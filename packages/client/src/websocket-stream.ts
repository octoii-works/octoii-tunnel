/** One visitor's WebSocket, served on the device: the service accepts it and talks over a `TunnelSocket`. */
import {
	decodeClosing,
	decodeCredit,
	decodeMessageChunk,
	decodeReset,
	encodeClosing,
	encodeCredit,
	encodeMessageChunk,
	encodeReset,
	encodeWebSocketHead,
	FRAME_TYPE,
	type Frame,
	type FrameType,
	isIntegerBetween,
	type Limits,
	type Message,
	MessageAssembler,
	MessageCredit,
	MessageSender,
	type Open,
	ProtocolError,
	type ResetCode,
	SendCredit,
	toClosing,
	toHeaders,
} from "@octoii/tunnel-protocol";

/** A visitor's WebSocket on the device, as the service talks over it. */
export interface TunnelSocket {
	/** The subprotocol the service accepted with, if any. */
	readonly protocol: string | undefined;
	/** Sends a message to the visitor. */
	send(message: string | Uint8Array): void;
	/** Closes the WebSocket; the visitor hears `code` and `reason`. */
	close(code?: number, reason?: string): void;
	/** Called with each message from the visitor. */
	onmessage: ((message: string | Uint8Array) => void) | undefined;
	/** Called once when the WebSocket closes, from either side or because the tunnel failed. */
	onclose: ((code: number, reason: string) => void) | undefined;
}

/**
 * Decides on a visitor's WebSocket: call `accept`, with one of the subprotocols the visitor asked for if any, to take
 * it; or return a `Response` to refuse it with that response's status.
 */
export type WebSocketHandler = (request: Request, accept: (protocol?: string) => TunnelSocket) => void | Response | Promise<void | Response>;

/** What a served WebSocket stream needs from its connection. */
export type ServedWebSocketLink = {
	readonly limits: Limits;
	readonly address: string;
	readonly websocket: WebSocketHandler;
	send(type: FrameType, stream: number, payload?: Uint8Array): void;
	done(stream: ServedWebSocketStream): void;
};

/** The close code for a failure of the tunnel. */
const INTERNAL_ERROR = 1011;

/** The `TunnelSocket` a service gets. */
class ServedTunnelSocket implements TunnelSocket {
	readonly protocol: string | undefined;
	onmessage: ((message: string | Uint8Array) => void) | undefined;
	onclose: ((code: number, reason: string) => void) | undefined;
	private readonly stream: ServedWebSocketStream;

	constructor(stream: ServedWebSocketStream, protocol: string | undefined) {
		this.stream = stream;
		this.protocol = protocol;
	}

	send(message: string | Uint8Array): void {
		this.stream.sendToVisitor(typeof message === "string" ? { binary: false, text: message } : { binary: true, bytes: message });
	}

	close(code = 1000, reason = ""): void {
		this.stream.closeFromService(code, reason);
	}
}

/** One visitor's WebSocket on the device, from `open` to its close. */
export class ServedWebSocketStream {
	readonly id: number;
	private readonly link: ServedWebSocketLink;
	private readonly open: Open;
	private readonly credit: SendCredit;
	private readonly incoming: MessageCredit;
	private readonly assembler = new MessageAssembler();
	private readonly sender: MessageSender;
	private socket: ServedTunnelSocket | undefined;
	private finished = false;

	constructor(id: number, open: Open, link: ServedWebSocketLink) {
		this.id = id;
		this.open = open;
		this.link = link;
		this.credit = new SendCredit(link.limits.initialCredit);
		this.incoming = new MessageCredit(link.limits.initialCredit);
		this.sender = new MessageSender(
			this.credit,
			link.limits.maxFrame,
			(chunk) => this.link.send(FRAME_TYPE.MESSAGE, this.id, encodeMessageChunk(chunk)),
			() => this.reset("internal", "Sending a message failed"),
		);
	}

	/** Asks the handler to accept or refuse the WebSocket. */
	start(): void {
		void this.decide(this.link.websocket);
	}

	/** Handles a frame the relay sent on this stream; a frame that breaks the stream's rules resets it. */
	receive(frame: Frame): void {
		try {
			this.handle(frame);
		} catch (error) {
			if (!(error instanceof ProtocolError)) throw error;
			this.reset("protocol", error.message);
		}
	}

	/** Queues a message for the visitor, sent within credit. */
	sendToVisitor(message: Message): void {
		if (!this.finished) this.sender.enqueue(message);
	}

	/** The service closed the WebSocket; the visitor hears the code and reason. */
	closeFromService(code: number, reason: string): void {
		if (this.finished) return;
		this.sendIfOpen(FRAME_TYPE.END, encodeClosing(toClosing(code, reason)));
		this.finish(code, reason);
	}

	/** Resets the stream on both sides with `code`. */
	reset(code: ResetCode, reason: string): void {
		if (this.finished) return;
		this.sendIfOpen(FRAME_TYPE.RESET, encodeReset({ code, reason }));
		this.fail(new Error(reason));
	}

	/** Ends the stream with `error`; the service hears a close with 1011. */
	fail(error: Error): void {
		this.finish(INTERNAL_ERROR, error.message);
	}

	private async decide(handler: WebSocketHandler): Promise<void> {
		const { path, headers } = this.open;
		const request = new Request(this.link.address + path, { method: "GET", headers: toHeaders(headers) });
		try {
			const refusal = await handler(request, (protocol) => this.accept(protocol));
			if (this.socket === undefined) this.refuse(refusal instanceof Response && isIntegerBetween(refusal.status, 400, 599) ? refusal.status : 403);
		} catch {
			if (this.socket === undefined) this.refuse(500);
			else this.reset("internal", "The WebSocket handler failed");
		}
	}

	private accept(protocol: string | undefined): TunnelSocket {
		if (this.socket !== undefined) throw new Error("The WebSocket was accepted already");
		if (protocol !== undefined && !this.open.protocols.includes(protocol)) throw new Error(`The visitor did not ask for ${protocol}`);
		this.socket = new ServedTunnelSocket(this, protocol);
		this.link.send(FRAME_TYPE.HEAD, this.id, encodeWebSocketHead(protocol === undefined ? { accept: true } : { accept: true, protocol }));
		return this.socket;
	}

	private refuse(status: number): void {
		this.sendIfOpen(FRAME_TYPE.HEAD, encodeWebSocketHead({ accept: false, status }));
		this.finished = true;
		this.link.done(this);
	}

	private handle(frame: Frame): void {
		switch (frame.type) {
			case FRAME_TYPE.MESSAGE:
				return this.receiveChunk(frame.payload);
			case FRAME_TYPE.END: {
				const closing = decodeClosing(frame.payload);
				return this.finish(closing.code, closing.reason);
			}
			case FRAME_TYPE.CREDIT:
				return this.credit.grant(decodeCredit(frame.payload));
			case FRAME_TYPE.RESET:
				decodeReset(frame.payload);
				return this.fail(new Error("The relay reset the stream"));
			default:
				throw new ProtocolError("Unexpected frame on a WebSocket stream");
		}
	}

	private receiveChunk(payload: Uint8Array): void {
		const socket = this.socket;
		if (socket === undefined) throw new ProtocolError("A message before the WebSocket was accepted");
		const chunk = decodeMessageChunk(payload);
		this.incoming.receive(chunk.bytes.length);
		const message = this.assembler.add(chunk);
		if (chunk.bytes.length > 0) this.sendIfOpen(FRAME_TYPE.CREDIT, encodeCredit(this.incoming.take(chunk.bytes.length)));
		if (message !== undefined) socket.onmessage?.(message.binary ? message.bytes : message.text);
	}

	private sendIfOpen(type: FrameType, payload: Uint8Array): void {
		if (this.finished) return;
		try {
			this.link.send(type, this.id, payload);
		} catch {
			// The connection is gone; the connector fails every stream.
		}
	}

	private finish(code: number, reason: string): void {
		if (this.finished) return;
		this.finished = true;
		this.sender.fail();
		this.credit.fail(new Error(reason));
		this.link.done(this);
		this.socket?.onclose?.(code, reason);
	}
}
