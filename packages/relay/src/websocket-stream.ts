/** One visitor's WebSocket, carried on one stream of the connector connection. */
import {
	decodeClosing,
	decodeCredit,
	decodeMessageChunk,
	decodeReset,
	decodeWebSocketHead,
	encodeClosing,
	encodeCredit,
	encodeMessageChunk,
	encodeOpen,
	encodeReset,
	FRAME_TYPE,
	type Frame,
	type FrameType,
	forwardableHeaders,
	isHeaderName,
	type Limits,
	MAX_MESSAGE_SIZE,
	type Message,
	MessageAssembler,
	MessageCredit,
	MessageSender,
	ProtocolError,
	type ResetCode,
	SendCredit,
	toClosing,
} from "@octoii-works/tunnel/protocol";
import type { SessionSocket } from "./host.ts";

/** How long the relay waits for the connector to accept or refuse a WebSocket. */
const HEAD_TIMEOUT = 30_000;
/** The close code that asks a visitor to try again later. */
const TRY_AGAIN_LATER = 1013;
/** The close code for a failure on the relay's side. */
const INTERNAL_ERROR = 1011;

/** What a WebSocket stream needs from its session. */
export type WebSocketLink = {
	readonly limits: Limits;
	send(type: FrameType, stream: number, payload?: Uint8Array): void;
	now(): number;
	/** Runs `callback` after `delayMs`; returns what cancels it. */
	setTimer(callback: () => void, delayMs: number): () => void;
	/** The stream is done; the session forgets it and meters it. */
	done(stream: WebSocketStream): void;
};

/** The connector's answer to a WebSocket stream, or why there was none. */
export type WebSocketAnswer =
	| { readonly accept: true; readonly protocol?: string }
	| { readonly accept: false; readonly status: number }
	| { readonly failed: "timeout" | "offline" };

/** One visitor's WebSocket on the relay. */
export class WebSocketStream {
	readonly id: number;
	readonly startedAt: number;
	/** The connector's answer. */
	readonly answer: Promise<WebSocketAnswer>;
	bytesIn = 0;
	bytesOut = 0;
	private readonly link: WebSocketLink;
	private readonly credit: SendCredit;
	private readonly incoming: MessageCredit;
	private readonly assembler = new MessageAssembler();
	private readonly sender: MessageSender;
	private readonly early: Message[] = [];
	private socket: SessionSocket | undefined;
	private settle: (answer: WebSocketAnswer) => void = () => undefined;
	private cancelTimeout: () => void = () => undefined;
	/** Bytes taken from the connector and not granted back yet, held while the visitor's socket is backed up. */
	private ungranted = 0;
	private cancelRecheck: (() => void) | undefined;
	private answered = false;
	private finished = false;

	constructor(id: number, link: WebSocketLink) {
		this.id = id;
		this.link = link;
		this.startedAt = link.now();
		this.credit = new SendCredit(link.limits.initialCredit);
		this.incoming = new MessageCredit(link.limits.initialCredit);
		this.sender = new MessageSender(
			this.credit,
			link.limits.maxFrame,
			(chunk) => {
				this.link.send(FRAME_TYPE.MESSAGE, this.id, encodeMessageChunk(chunk));
				this.bytesIn += chunk.bytes.length;
			},
			() => this.reset("internal", "Sending a message failed"),
		);
		this.answer = new Promise((resolve) => {
			this.settle = resolve;
		});
	}

	/** A stream the connector accepted before the host suspended the session, resumed on the visitor's socket. */
	static resumed(id: number, socket: SessionSocket, link: WebSocketLink): WebSocketStream {
		const stream = new WebSocketStream(id, link);
		stream.answered = true;
		stream.socket = socket;
		return stream;
	}

	/** Opens the stream on the connector, offering the subprotocols the visitor asked for. */
	start(request: Request, address: string, origin: URL): void {
		const url = new URL(request.url);
		const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
			.split(",")
			.map((protocol) => protocol.trim())
			.filter((protocol) => protocol !== "" && isHeaderName(protocol));
		const headers = [
			...forwardableHeaders(request.headers),
			["x-forwarded-for", address],
			["x-forwarded-proto", origin.protocol === "https:" ? "https" : "http"],
			["x-forwarded-host", url.host],
		] as const;
		const open = { kind: "websocket" as const, method: "GET", path: url.pathname + url.search, headers, protocols, remote: { address } };
		this.link.send(FRAME_TYPE.OPEN, this.id, encodeOpen(open));
		this.cancelTimeout = this.link.setTimer(() => {
			if (this.answered) return;
			this.reset("idle", "The device did not answer the WebSocket");
			this.settle({ failed: "timeout" });
		}, HEAD_TIMEOUT);
	}

	/** The visitor's socket, once the host upgraded the request; messages that came first go out now. */
	attach(socket: SessionSocket): void {
		this.socket = socket;
		for (const message of this.early.splice(0)) this.deliver(message);
	}

	/** Handles a frame the connector sent on this stream; a frame that breaks the stream's rules resets it. */
	receive(frame: Frame): void {
		try {
			this.handle(frame);
		} catch (error) {
			if (!(error instanceof ProtocolError)) throw error;
			this.reset("protocol", error.message);
		}
	}

	/** A message from the visitor, sent on within credit; a visitor that sends faster than the device takes is closed. */
	fromVisitor(data: Uint8Array | string): void {
		if (this.finished) return;
		this.sender.enqueue(typeof data === "string" ? { binary: false, text: data } : { binary: true, bytes: data });
		if (this.sender.held > MAX_MESSAGE_SIZE + this.link.limits.initialCredit) {
			this.closeVisitor(TRY_AGAIN_LATER, "The device is not keeping up");
			this.reset("too_large", "The visitor sent faster than the device took");
		}
	}

	/** The visitor closed its WebSocket; the connector hears the code and reason. */
	visitorClosed(code: number, reason: string): void {
		if (this.finished) return;
		this.socket = undefined;
		this.sendIfOpen(FRAME_TYPE.END, encodeClosing(toClosing(code, reason)));
		this.finish();
	}

	/** Resets the stream on both sides with `code`. */
	reset(code: ResetCode, reason: string): void {
		if (this.finished) return;
		this.sendIfOpen(FRAME_TYPE.RESET, encodeReset({ code, reason }));
		this.fail(new Error(reason));
	}

	/** Ends the stream with `error`, closing the visitor's WebSocket with 1011, as when the connection is gone. */
	fail(error: Error): void {
		if (this.finished) return;
		this.closeVisitor(INTERNAL_ERROR, "The device's connection ended");
		this.settle({ failed: "offline" });
		this.credit.fail(error);
		this.finish();
	}

	private handle(frame: Frame): void {
		switch (frame.type) {
			case FRAME_TYPE.HEAD:
				return this.receiveHead(frame.payload);
			case FRAME_TYPE.MESSAGE:
				return this.receiveChunk(frame.payload);
			case FRAME_TYPE.END: {
				const closing = decodeClosing(frame.payload);
				this.closeVisitor(closing.code, closing.reason);
				return this.finish();
			}
			case FRAME_TYPE.CREDIT:
				return this.credit.grant(decodeCredit(frame.payload));
			case FRAME_TYPE.RESET:
				decodeReset(frame.payload);
				return this.fail(new Error("The connector reset the stream"));
			default:
				throw new ProtocolError("Unexpected frame on a WebSocket stream");
		}
	}

	private receiveHead(payload: Uint8Array): void {
		if (this.answered) throw new ProtocolError("A second head");
		const head = decodeWebSocketHead(payload);
		this.answered = true;
		this.cancelTimeout();
		this.settle(head);
		if (!head.accept) this.finish();
	}

	private receiveChunk(payload: Uint8Array): void {
		if (!this.answered) throw new ProtocolError("A message before the WebSocket was accepted");
		const chunk = decodeMessageChunk(payload);
		this.incoming.receive(chunk.bytes.length);
		this.bytesOut += chunk.bytes.length;
		const message = this.assembler.add(chunk);
		this.ungranted += chunk.bytes.length;
		if (message !== undefined) {
			if (this.socket === undefined) this.early.push(message);
			else this.deliver(message);
		}
		this.grantCredit();
	}

	private deliver(message: Message): void {
		const socket = this.socket;
		if (socket === undefined) return;
		if (message.binary) socket.send(message.bytes);
		else socket.sendText(message.text);
	}

	/**
	 * Grants the connector back the bytes taken, unless the visitor's socket has more than `initialCredit` waiting;
	 * then it checks again shortly, so a slow visitor slows the device instead of filling the relay.
	 */
	private grantCredit(): void {
		if (this.ungranted === 0 || this.finished || this.cancelRecheck !== undefined) return;
		if ((this.socket?.bufferedAmount() ?? 0) > this.link.limits.initialCredit) {
			this.cancelRecheck = this.link.setTimer(() => {
				this.cancelRecheck = undefined;
				this.grantCredit();
			}, 50);
			return;
		}
		const amount = this.ungranted;
		this.ungranted = 0;
		this.sendIfOpen(FRAME_TYPE.CREDIT, encodeCredit(this.incoming.take(amount)));
	}

	private closeVisitor(code: number, reason: string): void {
		const socket = this.socket;
		this.socket = undefined;
		try {
			socket?.close(code, reason);
		} catch {
			// The visitor's socket is gone already.
		}
	}

	private sendIfOpen(type: FrameType, payload: Uint8Array): void {
		if (this.finished) return;
		try {
			this.link.send(type, this.id, payload);
		} catch {
			// The connection is gone; the session fails every stream.
		}
	}

	private finish(): void {
		if (this.finished) return;
		this.finished = true;
		this.cancelTimeout();
		this.cancelRecheck?.();
		this.sender.fail();
		this.link.done(this);
	}
}
