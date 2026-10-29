/** One visitor's HTTP request, served on the device: the handler gets a `Request` and its `Response` goes back. */
import {
	decodeCredit,
	decodeReset,
	encodeCredit,
	encodeHttpHead,
	encodeReset,
	FRAME_TYPE,
	type Frame,
	type FrameType,
	forwardableHeaders,
	IncomingBody,
	type Limits,
	type Open,
	ProtocolError,
	type ResetCode,
	SECURE_PATH,
	SendCredit,
	sendBody,
	toHeaders,
} from "./protocol/index.ts";

/** What the service gives the connector: a `Response` for each visitor's `Request`. */
export type Handler = (request: Request) => Response | Promise<Response>;

/** What a served stream needs from its connection. */
export type ServedStreamLink = {
	readonly limits: Limits;
	/** The device's address, which request URLs start with. */
	readonly address: string;
	readonly handler: Handler;
	/** Sends a frame on the connection; throws when it cannot. */
	send(type: FrameType, stream: number, payload?: Uint8Array): void;
	/** The stream is done; the connector forgets it. */
	done(stream: ServedHttpStream): void;
};

/** Methods whose requests carry no body. */
const BODILESS_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);

/** One visitor's HTTP request on the device, from `open` to both ends. */
export class ServedHttpStream {
	readonly id: number;
	private readonly link: ServedStreamLink;
	private readonly open: Open;
	private readonly credit: SendCredit;
	private readonly body: IncomingBody;
	private readonly abort = new AbortController();
	private lastFrameAt = Date.now();
	private requestEnded = false;
	private finished = false;

	constructor(id: number, open: Open, link: ServedStreamLink) {
		this.id = id;
		this.open = open;
		this.link = link;
		this.credit = new SendCredit(link.limits.initialCredit);
		this.body = new IncomingBody(link.limits.initialCredit, {
			credit: (amount) => this.sendIfOpen(FRAME_TYPE.CREDIT, encodeCredit(amount)),
			cancel: () => this.reset("cancelled", "The handler stopped reading the request body"),
			finish: () => undefined,
		});
		if (BODILESS_METHODS.has(open.method)) this.body.end();
	}

	/** Serves the request through the handler; the secure path never reaches it. */
	start(): void {
		void this.serve();
	}

	/** Handles a frame the relay sent on this stream; a frame that breaks the stream's rules resets it. */
	receive(frame: Frame): void {
		this.lastFrameAt = Date.now();
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

	/** Ends the stream with `error`, without telling the relay, as when the connection is gone. */
	fail(error: Error): void {
		if (this.finished) return;
		this.credit.fail(error);
		this.body.fail(error);
		this.abort.abort(error);
		this.finish();
	}

	private handle(frame: Frame): void {
		switch (frame.type) {
			case FRAME_TYPE.DATA:
				return this.body.push(frame.payload);
			case FRAME_TYPE.END:
				if (frame.payload.length !== 0) throw new ProtocolError("Invalid end");
				if (!BODILESS_METHODS.has(this.open.method)) this.body.end();
				this.requestEnded = true;
				return;
			case FRAME_TYPE.CREDIT:
				return this.credit.grant(decodeCredit(frame.payload));
			case FRAME_TYPE.RESET:
				decodeReset(frame.payload);
				return this.fail(new Error("The relay reset the stream"));
			default:
				throw new ProtocolError("Unexpected frame on an HTTP stream");
		}
	}

	private async serve(): Promise<void> {
		try {
			const response = await this.respond();
			if (this.finished) {
				await response.body?.cancel();
				return;
			}
			this.link.send(FRAME_TYPE.HEAD, this.id, encodeHttpHead({ status: response.status, headers: forwardableHeaders(response.headers) }));
			if (response.body !== null && this.open.method !== "HEAD") {
				await sendBody(response.body, this.credit, this.link.limits.maxFrame, (bytes) => this.sendData(bytes), this.abort.signal);
			} else await response.body?.cancel();
			if (this.finished) return;
			this.link.send(FRAME_TYPE.END, this.id);
			// The handler answered without reading the whole request body: stop the upload.
			if (!this.requestEnded) this.reset("cancelled", "The handler finished without reading the request body");
			else this.finish();
		} catch {
			this.reset("internal", "The handler failed");
		}
	}

	private respond(): Response | Promise<Response> {
		const { method, path, headers } = this.open;
		if (path.split("?")[0] === SECURE_PATH) return new Response("Secure channels are not supported yet", { status: 501 });
		const init: RequestInit & { duplex?: "half" } = { method, headers: toHeaders(headers), signal: this.abort.signal };
		if (!BODILESS_METHODS.has(method)) Object.assign(init, { body: this.body.stream, duplex: "half" });
		return this.link.handler(new Request(this.link.address + path, init));
	}

	private sendData(bytes: Uint8Array): void {
		this.link.send(FRAME_TYPE.DATA, this.id, bytes);
		this.lastFrameAt = Date.now();
	}

	private sendIfOpen(type: FrameType, payload: Uint8Array): void {
		if (this.finished) return;
		try {
			this.link.send(type, this.id, payload);
		} catch {
			// The connection is gone; the connector fails every stream.
		}
	}

	private finish(): void {
		if (this.finished) return;
		this.finished = true;
		this.link.done(this);
	}
}
