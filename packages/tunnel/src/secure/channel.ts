/**
 * A secure channel once its handshake is done: channel frames, each one Noise transport message, carrying WebSocket-
 * style messages and fetch-style requests. The connector's side answers requests through the service's handler; the
 * visitor's side sends them.
 */
import {
	decodeHeaderList,
	decodeHttpHead,
	decodeJsonObject,
	decodeMessageChunk,
	encodeHttpHead,
	encodeJson,
	encodeMessageChunk,
	encodeUtf8,
	forwardableHeaders,
	isIntegerBetween,
	isStringUpTo,
	type Message,
	MessageAssembler,
	ProtocolError,
	toHeaders,
} from "../protocol/index.ts";
import { CHANNEL_FRAME, type ChannelFrame, type ChannelFrameType, decodeChannelFrame, encodeChannelFrame, MAX_CHANNEL_PAYLOAD } from "./frames.ts";
import type { TransportCiphers } from "./noise.ts";

/** How many messages each direction sends before it rekeys. */
const REKEY_INTERVAL = 2 ** 20;
/** The close code of a channel that broke its rules or whose ciphertext did not authenticate. */
const BROKEN = 4400;
const EMPTY = new Uint8Array(0);

/** The messages under a channel: binary WebSocket messages, each one Noise message, and how the socket closes. */
export interface ChannelLink {
	send(bytes: Uint8Array): void;
	close(code: number, reason: string): void;
}

/** Encrypts and decrypts a channel's frames, rekeying each direction every `REKEY_INTERVAL` messages. */
class EncryptedLink {
	private readonly link: ChannelLink;
	private readonly ciphers: TransportCiphers;
	private sent = 0;
	private received = 0;

	constructor(link: ChannelLink, ciphers: TransportCiphers) {
		this.link = link;
		this.ciphers = ciphers;
	}

	send(type: ChannelFrameType, id: number, payload: Uint8Array = EMPTY): void {
		this.link.send(this.ciphers.send.encryptWithAd(EMPTY, encodeChannelFrame(type, id, payload)));
		if (++this.sent % REKEY_INTERVAL === 0) this.ciphers.send.rekey();
	}

	/** The frame in a message; throws when the ciphertext does not authenticate or the frame is malformed. */
	receive(bytes: Uint8Array): ChannelFrame {
		const frame = decodeChannelFrame(this.ciphers.receive.decryptWithAd(EMPTY, bytes));
		if (++this.received % REKEY_INTERVAL === 0) this.ciphers.receive.rekey();
		return frame;
	}

	close(code: number, reason: string): void {
		this.link.close(code, reason);
	}
}

/** What both sides of a channel share: messages, and closing. */
abstract class Channel {
	/** Called with each message from the other side. */
	onmessage: ((message: string | Uint8Array) => void) | undefined;
	/** Called once when the channel closes, from either side or because it broke. */
	onclose: ((code: number, reason: string) => void) | undefined;
	/** Settles once the channel closed, with how. */
	readonly done: Promise<{ readonly code: number; readonly reason: string }>;
	private settleDone: ((closed: { readonly code: number; readonly reason: string }) => void) | undefined;
	protected readonly link: EncryptedLink;
	private readonly assembler = new MessageAssembler();
	private closed = false;

	constructor(link: ChannelLink, ciphers: TransportCiphers) {
		this.link = new EncryptedLink(link, ciphers);
		this.done = new Promise((resolve) => {
			this.settleDone = resolve;
		});
	}

	/** Sends a message to the other side, in as many frames as it takes. */
	send(message: string | Uint8Array): void {
		const whole: Message = typeof message === "string" ? { binary: false, text: message } : { binary: true, bytes: message };
		const bytes = whole.binary ? whole.bytes : encodeUtf8(whole.text);
		// Each chunk travels after its flags byte.
		const size = MAX_CHANNEL_PAYLOAD - 1;
		for (let offset = 0; offset === 0 || offset < bytes.length; offset += size) {
			const chunk = bytes.subarray(offset, offset + size);
			this.link.send(CHANNEL_FRAME.MESSAGE, 0, encodeMessageChunk({ binary: whole.binary, more: offset + size < bytes.length, bytes: chunk }));
		}
	}

	/** Closes the channel; the other side hears `code` and `reason`. */
	close(code = 1000, reason = ""): void {
		if (this.closed) return;
		this.link.send(CHANNEL_FRAME.CLOSE, 0, encodeJson({ code, reason }));
		this.link.close(code, reason);
		this.ended(code, reason);
	}

	/** Handles one message of the socket under the channel; a message that breaks the channel closes it. */
	received(bytes: Uint8Array): void {
		if (this.closed) return;
		try {
			this.handle(this.link.receive(bytes));
		} catch {
			this.link.close(BROKEN, "The channel broke");
			this.ended(BROKEN, "The channel broke");
		}
	}

	/** The socket under the channel closed. */
	socketClosed(code: number, reason: string): void {
		this.ended(code, reason);
	}

	/** Handles a frame of a fetch, which each side handles its own way. */
	protected abstract fetchFrame(frame: ChannelFrame): void;

	/** Lets each side end its fetches when the channel ends. */
	protected abstract endFetches(): void;

	/** Handles `ready`, which only the visitor may receive, and only first. */
	protected abstract readyReceived(): void;

	private handle(frame: ChannelFrame): void {
		switch (frame.type) {
			case CHANNEL_FRAME.MESSAGE: {
				const message = this.assembler.add(decodeMessageChunk(frame.payload));
				if (message !== undefined) this.onmessage?.(message.binary ? message.bytes : message.text);
				return;
			}
			case CHANNEL_FRAME.CLOSE: {
				const value = decodeJsonObject(frame.payload);
				const code = isIntegerBetween(value["code"], 1000, 4999) ? value["code"] : 1000;
				const reason = isStringUpTo(value["reason"], 123) ? value["reason"] : "";
				this.link.close(code, reason);
				return this.ended(code, reason);
			}
			case CHANNEL_FRAME.READY:
				return this.readyReceived();
			default:
				return this.fetchFrame(frame);
		}
	}

	private ended(code: number, reason: string): void {
		if (this.closed) return;
		this.closed = true;
		this.endFetches();
		this.settleDone?.({ code, reason });
		this.onclose?.(code, reason);
	}
}

/** A paired visitor, as the connector knows it. */
export type VisitorIdentity = { readonly publicKey: string; readonly name: string };

/** A request arriving on a channel, until its body ends. */
type IncomingRequest = { readonly controller: ReadableStreamDefaultController<Uint8Array>; readonly abort: AbortController };

/**
 * The connector's side of a secure channel: messages with one paired visitor, and the visitor's fetches answered by the
 * service's handler, as in plain mode.
 */
export class SecureChannel extends Channel {
	/** Who is on the other side. */
	readonly visitor: VisitorIdentity;
	private readonly address: string;
	private readonly handler: (request: Request) => Response | Promise<Response>;
	private readonly requests = new Map<number, IncomingRequest>();

	constructor(
		link: ChannelLink,
		ciphers: TransportCiphers,
		visitor: VisitorIdentity,
		address: string,
		handler: (request: Request) => Response | Promise<Response>,
	) {
		super(link, ciphers);
		this.visitor = visitor;
		this.address = address;
		this.handler = handler;
	}

	/** Tells the visitor the handshake was accepted; the first transport message. */
	ready(): void {
		this.link.send(CHANNEL_FRAME.READY, 0);
	}

	protected fetchFrame(frame: ChannelFrame): void {
		switch (frame.type) {
			case CHANNEL_FRAME.REQUEST:
				return this.startRequest(frame);
			case CHANNEL_FRAME.BODY:
				return this.requests.get(frame.id)?.controller.enqueue(frame.payload.slice());
			case CHANNEL_FRAME.END:
				this.requests.get(frame.id)?.controller.close();
				return;
			case CHANNEL_FRAME.CANCEL:
				this.requests.get(frame.id)?.abort.abort(new Error("The visitor cancelled the request"));
				this.requests.delete(frame.id);
				return;
			default:
				throw new ProtocolError("Unexpected frame from the visitor");
		}
	}

	protected endFetches(): void {
		for (const request of this.requests.values()) request.abort.abort(new Error("The channel closed"));
		this.requests.clear();
	}

	protected readyReceived(): void {
		throw new ProtocolError("Only the connector sends ready");
	}

	private startRequest(frame: ChannelFrame): void {
		if (frame.id === 0 || this.requests.has(frame.id)) throw new ProtocolError("Invalid request id");
		const head = decodeJsonObject(frame.payload);
		const { method, path } = head;
		if (typeof method !== "string" || !/^[A-Z]{1,16}$/.test(method) || typeof path !== "string" || !path.startsWith("/")) {
			throw new ProtocolError("Invalid request");
		}
		const headers = toHeaders(decodeHeaderList(head["headers"]));
		const abort = new AbortController();
		let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
		const body = new ReadableStream<Uint8Array>({ start: (started) => (controller = started) });
		if (controller === undefined) throw new Error("The request body did not start");
		this.requests.set(frame.id, { controller, abort });
		const bodiless = method === "GET" || method === "HEAD";
		const init: RequestInit & { duplex?: "half" } = { method, headers, signal: abort.signal, ...(bodiless ? {} : { body, duplex: "half" }) };
		void this.respond(frame.id, new Request(this.address + path, init), abort.signal);
	}

	private async respond(id: number, request: Request, signal: AbortSignal): Promise<void> {
		try {
			const response = await this.handler(request);
			this.link.send(CHANNEL_FRAME.RESPONSE, id, encodeHttpHead({ status: response.status, headers: forwardableHeaders(response.headers) }));
			const reader = response.body?.getReader();
			for (let read = await reader?.read(); read !== undefined && !read.done && !signal.aborted; read = await reader?.read()) {
				for (let offset = 0; offset < read.value.length; offset += MAX_CHANNEL_PAYLOAD) {
					this.link.send(CHANNEL_FRAME.BODY, id, read.value.subarray(offset, offset + MAX_CHANNEL_PAYLOAD));
				}
			}
			if (!signal.aborted) this.link.send(CHANNEL_FRAME.END, id);
		} catch {
			if (!signal.aborted) this.link.send(CHANNEL_FRAME.CANCEL, id);
		} finally {
			this.requests.delete(id);
		}
	}
}

/** A fetch the visitor sent, until its response body ends. */
type OutgoingRequest = {
	readonly resolve: (response: Response) => void;
	readonly reject: (error: Error) => void;
	body?: ReadableStreamDefaultController<Uint8Array>;
};

/** The visitor's side of a secure channel: messages with the device, and fetches its service answers. */
export class VisitorChannel extends Channel {
	/** Settles when the connector sends `ready`: it accepted the handshake. */
	readonly opened: Promise<void>;
	private readonly requests = new Map<number, OutgoingRequest>();
	private nextRequest = 1;
	private isOpen = false;
	private open: () => void = () => undefined;
	private refuse: (error: Error) => void = () => undefined;

	constructor(link: ChannelLink, ciphers: TransportCiphers) {
		super(link, ciphers);
		this.opened = new Promise((resolve, reject) => {
			this.open = resolve;
			this.refuse = reject;
		});
		this.opened.catch(() => undefined);
	}

	/** Sends a request over the channel; the device's service answers it as it answers plain requests. */
	async fetch(
		path: string,
		init: { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: Uint8Array | string } = {},
	): Promise<Response> {
		const id = this.nextRequest++;
		const method = init.method ?? "GET";
		const headers = Object.entries(init.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value] as const);
		const response = new Promise<Response>((resolve, reject) => this.requests.set(id, { resolve, reject }));
		this.link.send(CHANNEL_FRAME.REQUEST, id, encodeJson({ method, path, headers }));
		const body = typeof init.body === "string" ? encodeUtf8(init.body) : init.body;
		if (body !== undefined) {
			for (let offset = 0; offset < body.length; offset += MAX_CHANNEL_PAYLOAD)
				this.link.send(CHANNEL_FRAME.BODY, id, body.subarray(offset, offset + MAX_CHANNEL_PAYLOAD));
		}
		this.link.send(CHANNEL_FRAME.END, id);
		return response;
	}

	protected fetchFrame(frame: ChannelFrame): void {
		const request = this.requests.get(frame.id);
		if (request === undefined) return;
		switch (frame.type) {
			case CHANNEL_FRAME.RESPONSE: {
				const head = decodeHttpHead(frame.payload);
				const body = new ReadableStream<Uint8Array>({ start: (controller) => (request.body = controller) });
				const bodiless = head.status === 204 || head.status === 205 || head.status === 304;
				return request.resolve(new Response(bodiless ? null : body, { status: head.status, headers: toHeaders(head.headers) }));
			}
			case CHANNEL_FRAME.BODY:
				return request.body?.enqueue(frame.payload.slice());
			case CHANNEL_FRAME.END:
				request.body?.close();
				this.requests.delete(frame.id);
				return;
			case CHANNEL_FRAME.CANCEL:
				request.reject(new Error("The device could not answer"));
				request.body?.error(new Error("The device could not answer"));
				this.requests.delete(frame.id);
				return;
			default:
				throw new ProtocolError("Unexpected frame from the device");
		}
	}

	protected endFetches(): void {
		for (const request of this.requests.values()) {
			request.reject(new Error("The channel closed"));
			request.body?.error(new Error("The channel closed"));
		}
		this.requests.clear();
		this.refuse(new Error("The device refused the channel"));
	}

	protected readyReceived(): void {
		if (this.isOpen) throw new ProtocolError("A second ready");
		this.isOpen = true;
		this.open();
	}
}
