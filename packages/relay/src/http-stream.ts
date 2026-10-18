/** One visitor's HTTP request and its response, carried on one stream of the connector connection. */
import {
	decodeCredit,
	encodeCredit,
	decodeHttpHead,
	decodeReset,
	encodeOpen,
	encodeReset,
	FRAME_TYPE,
	type Frame,
	type FrameType,
	forwardableHeaders,
	IncomingBody,
	type Limits,
	ProtocolError,
	type ResetCode,
	SendCredit,
	sendBody,
	toHeaders,
} from "@octoii/tunnel-protocol";
import { errorResponse } from "./hooks.ts";

/** What an HTTP stream needs from its session. */
export type StreamLink = {
	readonly limits: Limits;
	/** Sends a frame on the connector connection; throws when it cannot. */
	send(type: FrameType, stream: number, payload?: Uint8Array): void;
	now(): number;
	/** The stream is done, either way; the session forgets it and meters it. */
	done(stream: HttpStream): void;
};

/** Statuses whose responses carry no body. */
const BODILESS_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);

/** One visitor's HTTP exchange on the relay. */
export class HttpStream {
	readonly id: number;
	readonly startedAt: number;
	/** The visitor's response, once the connector sent `head`, or an error response. */
	readonly response: Promise<Response>;
	bytesIn = 0;
	bytesOut = 0;
	private readonly link: StreamLink;
	private readonly method: string;
	private readonly credit: SendCredit;
	private readonly body: IncomingBody;
	private readonly abort = new AbortController();
	private resolve: (response: Response) => void = () => undefined;
	private lastFrameAt: number;
	private headReceived = false;
	private statusIsBodiless = false;
	private requestEnded = false;
	private responseEnded = false;
	private responseRead = false;
	private finished = false;

	constructor(id: number, method: string, link: StreamLink) {
		this.id = id;
		this.method = method;
		this.link = link;
		this.startedAt = link.now();
		this.lastFrameAt = this.startedAt;
		this.credit = new SendCredit(link.limits.initialCredit);
		this.body = new IncomingBody(link.limits.initialCredit, {
			credit: (amount) => this.sendIfOpen(FRAME_TYPE.CREDIT, encodeCredit(amount)),
			cancel: () => this.reset("cancelled", "The visitor stopped reading the response"),
			finish: () => {
				this.responseRead = true;
				this.finishIfDone();
			},
		});
		this.response = new Promise((resolve) => {
			this.resolve = resolve;
		});
	}

	/** Opens the stream on the connector and starts sending the visitor's body. */
	start(request: Request, address: string, origin: URL): void {
		const url = new URL(request.url);
		const headers = [
			...forwardableHeaders(request.headers),
			["x-forwarded-for", address],
			["x-forwarded-proto", origin.protocol.slice(0, -1)],
			["x-forwarded-host", url.host],
		] as const;
		const open = { kind: "http" as const, method: request.method, path: url.pathname + url.search, headers, protocols: [], remote: { address } };
		request.signal.addEventListener("abort", () => this.reset("cancelled", "The visitor went away"), { once: true });
		this.link.send(FRAME_TYPE.OPEN, this.id, encodeOpen(open));
		void this.sendRequestBody(request.body);
	}

	/** Handles a frame the connector sent on this stream; a frame that breaks the stream's rules resets it. */
	receive(frame: Frame): void {
		this.lastFrameAt = this.link.now();
		try {
			this.handle(frame);
		} catch (error) {
			if (!(error instanceof ProtocolError)) throw error;
			this.reset("protocol", error.message);
		}
	}

	/** Whether the stream went `idle` milliseconds without a frame. */
	idleAt(now: number, idle: number): boolean {
		return now - this.lastFrameAt >= idle;
	}

	/** Resets the stream on both sides with `code`. */
	reset(code: ResetCode, reason: string): void {
		if (this.finished) return;
		this.sendIfOpen(FRAME_TYPE.RESET, encodeReset({ code, reason }));
		this.fail(new Error(reason));
	}

	/** Ends the stream with `error`, without telling the connector, as when the connection is gone. */
	fail(error: Error): void {
		if (this.finished) return;
		this.credit.fail(error);
		this.body.fail(error);
		this.abort.abort(error);
		if (!this.headReceived) this.resolve(errorResponse("offline", error.message));
		this.finish();
	}

	private handle(frame: Frame): void {
		switch (frame.type) {
			case FRAME_TYPE.HEAD:
				return this.receiveHead(frame.payload);
			case FRAME_TYPE.DATA:
				if (!this.headReceived || this.bodiless()) throw new ProtocolError("Body data before head or on a bodiless response");
				this.body.push(frame.payload);
				this.bytesOut += frame.payload.length;
				return;
			case FRAME_TYPE.END:
				if (!this.headReceived || frame.payload.length !== 0) throw new ProtocolError("Invalid end");
				if (!this.bodiless()) this.body.end();
				this.responseEnded = true;
				return this.finishIfDone();
			case FRAME_TYPE.CREDIT:
				return this.credit.grant(decodeCredit(frame.payload));
			case FRAME_TYPE.RESET:
				decodeReset(frame.payload);
				return this.receiveReset();
			default:
				throw new ProtocolError("Unexpected frame on an HTTP stream");
		}
	}

	private receiveHead(payload: Uint8Array): void {
		if (this.headReceived) throw new ProtocolError("A second head");
		const head = decodeHttpHead(payload);
		this.headReceived = true;
		this.statusIsBodiless = BODILESS_STATUSES.has(head.status);
		// A bodiless response has nothing for the visitor to read.
		if (this.bodiless()) this.responseRead = true;
		this.resolve(new Response(this.bodiless() ? null : this.body.stream, { status: head.status, headers: toHeaders(forwardableHeaders(head.headers)) }));
	}

	/** A reset after the whole response stops only the upload; any other reset fails the stream. */
	private receiveReset(): void {
		if (!this.responseEnded) {
			this.fail(new Error("The connector reset the stream"));
			return;
		}
		const error = new Error("The connector stopped reading the request body");
		this.credit.fail(error);
		this.abort.abort(error);
		this.requestEnded = true;
		this.finishIfDone();
	}

	private bodiless(): boolean {
		return this.method === "HEAD" || this.statusIsBodiless;
	}

	private async sendRequestBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
		try {
			if (body !== null) {
				await sendBody(body, this.credit, this.link.limits.maxFrame, (bytes) => this.sendData(bytes), this.abort.signal);
			}
			if (this.finished || this.requestEnded) return;
			this.link.send(FRAME_TYPE.END, this.id);
			this.requestEnded = true;
			this.finishIfDone();
		} catch {
			if (!this.requestEnded) this.reset("internal", "The request body failed");
		}
	}

	private sendData(bytes: Uint8Array): void {
		this.link.send(FRAME_TYPE.DATA, this.id, bytes);
		this.bytesIn += bytes.length;
		this.lastFrameAt = this.link.now();
	}

	private sendIfOpen(type: FrameType, payload: Uint8Array): void {
		if (this.finished) return;
		try {
			this.link.send(type, this.id, payload);
		} catch {
			// The connection is gone; the session fails every stream.
		}
	}

	private finishIfDone(): void {
		if (this.requestEnded && this.responseEnded && this.responseRead) this.finish();
	}

	private finish(): void {
		if (this.finished) return;
		this.finished = true;
		this.link.done(this);
	}
}
