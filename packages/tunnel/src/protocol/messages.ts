/** WebSocket messages as `message` frames carry them: split into chunks, and put together again. */
import { ProtocolError } from "./errors.ts";
import { MAX_MESSAGE_SIZE } from "./limits.ts";
import { type Closing, isSendableCloseCode, MAX_CLOSE_REASON_BYTES, type MessageChunk } from "./payloads.ts";
import type { SendCredit } from "./credit.ts";
import { decodeUtf8, encodeUtf8 } from "./utf8.ts";

/** A whole WebSocket message. */
export type Message = { readonly binary: true; readonly bytes: Uint8Array } | { readonly binary: false; readonly text: string };

/** Puts chunks back together into messages, refusing any larger than `MAX_MESSAGE_SIZE`. */
export class MessageAssembler {
	private parts: Uint8Array[] = [];
	private size = 0;
	private binary: boolean | undefined;

	/** Adds a chunk; returns the message it completes, or `undefined` while more are to come. */
	add(chunk: MessageChunk): Message | undefined {
		if (this.binary !== undefined && this.binary !== chunk.binary) throw new ProtocolError("A message changed type mid-way");
		this.size += chunk.bytes.length;
		if (this.size > MAX_MESSAGE_SIZE) throw new ProtocolError("Message too large");
		this.binary = chunk.binary;
		this.parts.push(chunk.bytes.slice());
		if (chunk.more) return undefined;
		const bytes = this.joined();
		const binary = this.binary;
		this.parts = [];
		this.size = 0;
		this.binary = undefined;
		return binary ? { binary, bytes } : { binary, text: decodeUtf8(bytes) };
	}

	private joined(): Uint8Array {
		const [only, ...rest] = this.parts;
		if (only !== undefined && rest.length === 0) return only;
		const bytes = new Uint8Array(this.size);
		let offset = 0;
		for (const part of this.parts) {
			bytes.set(part, offset);
			offset += part.length;
		}
		return bytes;
	}
}

/** The close code passed on for a close that carried none the protocol may send, such as 1005 or 1006. */
export const GOING_AWAY = 1001;

/** How a WebSocket close is passed on: a code a close frame may carry (1001 otherwise), and a reason cut to fit one. */
export function toClosing(code: number, reason: string): Closing {
	let fitting = reason;
	while (encodeUtf8(fitting).length > MAX_CLOSE_REASON_BYTES) fitting = fitting.slice(0, -1);
	return { code: isSendableCloseCode(code) ? code : GOING_AWAY, reason: fitting };
}

/**
 * Sends a stream's WebSocket messages in order, each split into chunks that fit a frame with their flags byte, within
 * the stream's credit, holding them while there is none.
 */
export class MessageSender {
	private readonly credit: SendCredit;
	private readonly maxChunk: number;
	private readonly send: (chunk: MessageChunk) => void;
	private readonly onFailure: (error: Error) => void;
	private readonly queue: { readonly binary: boolean; readonly bytes: Uint8Array }[] = [];
	private queued = 0;
	private sending = false;
	private failed = false;

	/** Sends chunks with `send`; when sending fails, drops what is held and tells `failed`. */
	constructor(credit: SendCredit, maxFrame: number, send: (chunk: MessageChunk) => void, failed: (error: Error) => void) {
		this.credit = credit;
		// Each chunk travels after its flags byte.
		this.maxChunk = maxFrame - 1;
		this.send = send;
		this.onFailure = failed;
	}

	/** Bytes held, waiting for credit. */
	get held(): number {
		return this.queued;
	}

	/** Queues a message; it goes as soon as credit allows. */
	enqueue(message: Message): void {
		if (this.failed) return;
		const bytes = message.binary ? message.bytes : encodeUtf8(message.text);
		this.queue.push({ binary: message.binary, bytes });
		this.queued += bytes.length;
		if (!this.sending) void this.pump();
	}

	/** Drops what is held and sends nothing more. */
	fail(): void {
		this.failed = true;
		this.queue.length = 0;
		this.queued = 0;
	}

	private async pump(): Promise<void> {
		this.sending = true;
		try {
			for (let message = this.queue.shift(); message !== undefined && !this.failed; message = this.queue.shift()) {
				this.queued -= message.bytes.length;
				await this.sendMessage(message.binary, message.bytes);
			}
		} catch (error) {
			if (!this.failed) this.onFailure(error instanceof Error ? error : new Error("Sending a message failed"));
			this.fail();
		} finally {
			this.sending = false;
		}
	}

	private async sendMessage(binary: boolean, bytes: Uint8Array): Promise<void> {
		if (bytes.length === 0) return this.send({ binary, more: false, bytes });
		for (let offset = 0; offset < bytes.length && !this.failed;) {
			const size = await this.credit.take(Math.min(this.maxChunk, bytes.length - offset));
			this.send({ binary, more: offset + size < bytes.length, bytes: bytes.subarray(offset, offset + size) });
			offset += size;
		}
	}
}
