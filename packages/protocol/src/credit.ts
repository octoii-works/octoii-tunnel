/**
 * Flow control on one stream. A receiver grants credit for the bytes it will take; a sender sends only within it. The
 * receiver grants more only as its consumer takes bytes, so a slow reader slows the sender instead of filling memory.
 */
import { ProtocolError } from "./errors.ts";

/** The credit a sender has on one stream: what the receiver granted and it has not used. */
export class SendCredit {
	private credit: number;
	private readonly limit: number;
	private waiting: (() => void) | undefined;
	private failure: Error | undefined;

	/** Starts with `initial` credit, which is also the most the receiver may have outstanding. */
	constructor(initial: number) {
		this.credit = initial;
		this.limit = initial;
	}

	/** Adds credit the receiver granted; throws a `ProtocolError` for a grant past what it may have outstanding. */
	grant(amount: number): void {
		if (this.credit + amount > this.limit) throw new ProtocolError("Credit beyond the initial credit");
		this.credit += amount;
		this.wake();
	}

	/** Waits for credit, then takes up to `max` bytes of it and says how many. Rejects once the stream failed. */
	async take(max: number): Promise<number> {
		while (this.credit === 0 && this.failure === undefined) await this.nextGrant();
		if (this.failure !== undefined) throw this.failure;
		const taken = Math.min(max, this.credit);
		this.credit -= taken;
		return taken;
	}

	/** Ends the stream's sending: a waiting `take` and every later one reject with `error`. */
	fail(error: Error): void {
		this.failure ??= error;
		this.wake();
	}

	private nextGrant(): Promise<void> {
		return new Promise((resolve) => {
			this.waiting = resolve;
		});
	}

	private wake(): void {
		const waiting = this.waiting;
		this.waiting = undefined;
		waiting?.();
	}
}

/** The credit a receiver granted on one stream, and when to grant more. */
export class ReceiveCredit {
	private outstanding: number;
	private released = 0;
	private readonly limit: number;

	/** Starts with `initial` credit granted. */
	constructor(initial: number) {
		this.outstanding = initial;
		this.limit = initial;
	}

	/** Counts `size` bytes received; throws a `ProtocolError` when the sender went past its credit. */
	receive(size: number): void {
		if (size > this.outstanding) throw new ProtocolError("Data beyond credit");
		this.outstanding -= size;
	}

	/**
	 * Counts `size` bytes the consumer took, and says how much credit to grant now: nothing until half the initial credit
	 * is released, so grants come in a few frames rather than one per chunk.
	 */
	release(size: number): number {
		this.released += size;
		if (this.released * 2 < this.limit) return 0;
		const grant = this.released;
		this.released = 0;
		this.outstanding += grant;
		return grant;
	}
}

/**
 * The credit a WebSocket stream's receiver granted. Each chunk's bytes are granted back as soon as the receiver has taken
 * the chunk, so a quiet stream always holds its full credit, and a resumed session can start again from the initial
 * credit.
 */
export class MessageCredit {
	private outstanding: number;

	/** Starts with `initial` credit granted. */
	constructor(initial: number) {
		this.outstanding = initial;
	}

	/** Counts `size` message bytes received; throws a `ProtocolError` when the sender went past its credit. */
	receive(size: number): void {
		if (size > this.outstanding) throw new ProtocolError("Message bytes beyond credit");
		this.outstanding -= size;
	}

	/** Counts `size` bytes the receiver has taken, and says how much credit to grant now: all of it. */
	take(size: number): number {
		this.outstanding += size;
		return size;
	}
}

/** What an `IncomingBody` tells its stream. */
export type IncomingBodyEvents = {
	/** Grant the sender this much more credit. */
	readonly credit: (amount: number) => void;
	/** The consumer cancelled the body. */
	readonly cancel: () => void;
	/** The consumer read the whole body. */
	readonly finish: () => void;
};

/** A body arriving in `data` frames, as a `ReadableStream` that grants credit as its consumer reads. */
export class IncomingBody {
	/** The body for its consumer. */
	readonly stream: ReadableStream<Uint8Array>;
	private readonly credit: ReceiveCredit;
	private readonly events: IncomingBodyEvents;
	private readonly queue: Uint8Array[] = [];
	private controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	private pulled: (() => void) | undefined;
	private ended = false;
	private closed = false;

	constructor(initialCredit: number, events: IncomingBodyEvents) {
		this.credit = new ReceiveCredit(initialCredit);
		this.events = events;
		this.stream = new ReadableStream<Uint8Array>(
			{
				start: (controller) => {
					this.controller = controller;
				},
				pull: () => this.waitForPull(),
				cancel: () => {
					this.close();
					this.events.cancel();
				},
			},
			{ highWaterMark: 0 },
		);
	}

	/** Adds bytes of a `data` frame; throws a `ProtocolError` past the credit or after the end. */
	push(bytes: Uint8Array): void {
		if (this.ended || this.closed) throw new ProtocolError("Data after the end of the body");
		this.credit.receive(bytes.length);
		if (bytes.length === 0) return;
		this.queue.push(bytes.slice());
		this.flush();
	}

	/** Marks the end of the body: the consumer reads what is queued, then the end. */
	end(): void {
		if (this.ended) throw new ProtocolError("The body ended twice");
		this.ended = true;
		this.flush();
	}

	/** Fails the body: its consumer's next read rejects with `error`. */
	fail(error: Error): void {
		if (this.closed) return;
		this.controller?.error(error);
		this.close();
	}

	private waitForPull(): Promise<void> {
		return new Promise((resolve) => {
			this.pulled = resolve;
			this.flush();
		});
	}

	private flush(): void {
		const controller = this.controller;
		if (this.closed || controller === undefined) return;
		const bytes = this.pulled === undefined ? undefined : this.queue.shift();
		if (bytes !== undefined) {
			controller.enqueue(bytes);
			this.resolvePull();
			const grant = this.credit.release(bytes.length);
			if (grant > 0) this.events.credit(grant);
		}
		if (this.ended && this.queue.length === 0) {
			controller.close();
			this.close();
			this.events.finish();
		}
	}

	private resolvePull(): void {
		const pulled = this.pulled;
		this.pulled = undefined;
		pulled?.();
	}

	private close(): void {
		this.closed = true;
		this.queue.length = 0;
		this.resolvePull();
	}
}

/** Sends `body` in chunks of at most `maxFrame` bytes, each within `credit`, until it ends or `signal` aborts. */
export async function sendBody(
	body: ReadableStream<Uint8Array>,
	credit: SendCredit,
	maxFrame: number,
	send: (bytes: Uint8Array) => void,
	signal: AbortSignal,
): Promise<void> {
	const reader = body.getReader();
	const cancel = (): void => void reader.cancel(signal.reason).catch(() => undefined);
	signal.addEventListener("abort", cancel, { once: true });
	try {
		for (let read = await reader.read(); !read.done; read = await reader.read()) {
			for (let offset = 0; offset < read.value.length;) {
				const size = await credit.take(Math.min(maxFrame, read.value.length - offset));
				if (signal.aborted) throw signal.reason;
				send(read.value.subarray(offset, offset + size));
				offset += size;
			}
		}
	} finally {
		signal.removeEventListener("abort", cancel);
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}
