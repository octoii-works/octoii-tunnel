/** WebSocket messages as `message` frames carry them: split into chunks, and put together again. */
import { ProtocolError } from "./errors.ts";
import { MAX_MESSAGE_SIZE } from "./limits.ts";
import type { MessageChunk } from "./payloads.ts";
import { decodeUtf8, encodeUtf8 } from "./utf8.ts";

/** A whole WebSocket message. */
export type Message = { readonly binary: true; readonly bytes: Uint8Array } | { readonly binary: false; readonly text: string };

/** The chunks of `message`, each of at most `maxChunk` bytes; an empty message is one empty chunk. */
export function splitMessage(message: Message, maxChunk: number): MessageChunk[] {
	const bytes = message.binary ? message.bytes : encodeUtf8(message.text);
	if (bytes.length > MAX_MESSAGE_SIZE) throw new ProtocolError("Message too large");
	const chunks: MessageChunk[] = [];
	for (let offset = 0; offset === 0 || offset < bytes.length; offset += maxChunk) {
		const end = Math.min(bytes.length, offset + maxChunk);
		chunks.push({ binary: message.binary, more: end < bytes.length, bytes: bytes.subarray(offset, end) });
	}
	return chunks;
}

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
