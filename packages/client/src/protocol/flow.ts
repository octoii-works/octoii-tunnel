import { positiveInteger, ProtocolError } from "./frame.ts";

export class SendWindow {
	private credit: number;
	private wake: (() => void) | undefined;
	private failure: Error | undefined;
	constructor(private readonly capacity: number) {
		this.credit = capacity;
	}
	grant(amount: number): void {
		if (!positiveInteger(amount) || this.credit + amount > this.capacity) throw new ProtocolError("Excess credit");
		this.credit += amount;
		this.wake?.();
	}
	async take(max: number): Promise<number> {
		while (!this.credit && !this.failure)
			await new Promise<void>((resolve) => {
				this.wake = resolve;
			});
		this.wake = undefined;
		if (this.failure) throw this.failure;
		const count = Math.min(max, this.credit);
		this.credit -= count;
		return count;
	}
	fail(error: Error): void {
		this.failure = error;
		this.wake?.();
	}
}

/** Credit returns only when a consumer pulls bytes, not when they arrive. */
export class ReceiveBody {
	readonly stream: ReadableStream<Uint8Array>;
	private readonly queue: Uint8Array[] = [];
	private controller!: ReadableStreamDefaultController<Uint8Array>;
	private credit: number;
	private pulling = false;
	private ended = false;
	private closed = false;
	private pullDone: (() => void) | undefined;
	constructor(
		capacity: number,
		private readonly consumed: (size: number) => void,
		private readonly cancelled: () => void,
		private readonly finished: () => void = () => {},
	) {
		this.credit = capacity;
		this.stream = new ReadableStream<Uint8Array>(
			{
				start: (controller) => {
					this.controller = controller;
				},
				pull: () => {
					this.pulling = true;
					return new Promise<void>((resolve) => {
						this.pullDone = resolve;
						this.flush();
					});
				},
				cancel: () => {
					this.close();
					this.cancelled();
				},
			},
			{ highWaterMark: 0 },
		);
	}
	push(bytes: Uint8Array): void {
		if (this.ended || this.closed || bytes.length > this.credit) throw new ProtocolError("Invalid body data");
		if (!bytes.length) return;
		this.credit -= bytes.length;
		this.queue.push(bytes.slice());
		this.flush();
	}
	end(): void {
		if (this.ended) throw new ProtocolError("Duplicate body end");
		this.ended = true;
		this.flush();
	}
	fail(error: Error): void {
		if (this.closed) return;
		this.controller.error(error);
		this.close();
	}
	private close(): void {
		this.closed = true;
		this.queue.length = 0;
		this.pullDone?.();
		this.pullDone = undefined;
	}
	private flush(): void {
		if (this.closed) return;
		if (this.pulling && this.queue.length) {
			const bytes = this.queue.shift();
			if (!bytes) return;
			this.pulling = false;
			this.credit += bytes.length;
			this.controller.enqueue(bytes);
			this.pullDone?.();
			this.pullDone = undefined;
			this.consumed(bytes.length);
		}
		if (this.ended && !this.queue.length) {
			this.controller.close();
			this.close();
			this.finished();
		}
	}
}

export async function sendBody(
	body: ReadableStream<Uint8Array> | null,
	window: SendWindow,
	maxFrame: number,
	send: (bytes: Uint8Array) => void,
	signal: AbortSignal,
): Promise<void> {
	if (!body) return;
	const reader = body.getReader();
	const cancel = () => {
		void reader.cancel(signal.reason).catch(() => {});
	};
	signal.addEventListener("abort", cancel, { once: true });
	try {
		while (true) {
			if (signal.aborted) throw signal.reason;
			const result = await reader.read();
			if (result.done) break;
			for (let offset = 0; offset < result.value.length;) {
				const size = await window.take(Math.min(maxFrame, result.value.length - offset));
				if (signal.aborted) throw signal.reason;
				send(result.value.subarray(offset, offset + size));
				offset += size;
			}
		}
	} finally {
		signal.removeEventListener("abort", cancel);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
