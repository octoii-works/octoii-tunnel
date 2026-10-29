/**
 * UTF-8 written out, since Hermes has no `TextDecoder`. Decoding is strict, as a fatal `TextDecoder` is: overlong forms,
 * surrogates, code points past U+10FFFF and truncated sequences are refused.
 */
import { ProtocolError } from "./errors.ts";

/** How many UTF-16 code units are turned into a string at once, kept well under engines' argument limits. */
const CHUNK = 4096;

/** The UTF-8 bytes of `text`; a lone surrogate becomes U+FFFD, as `TextEncoder` makes it. */
export function encodeUtf8(text: string): Uint8Array {
	const bytes = new Uint8Array(text.length * 3);
	let length = 0;
	for (let index = 0; index < text.length; index++) {
		const point = codePointAt(text, index);
		if (point > 0xffff) index++;
		length = writeCodePoint(bytes, length, point);
	}
	return bytes.slice(0, length);
}

/** The text that `bytes` encode; throws a `ProtocolError` for bytes that are not UTF-8. */
export function decodeUtf8(bytes: Uint8Array): string {
	let text = "";
	let units: number[] = [];
	for (let index = 0; index < bytes.length;) {
		const { point, size } = readCodePoint(bytes, index);
		index += size;
		if (point > 0xffff) units.push(0xd800 + ((point - 0x10000) >> 10), 0xdc00 + ((point - 0x10000) & 0x3ff));
		else units.push(point);
		if (units.length >= CHUNK) {
			text += String.fromCharCode(...units);
			units = [];
		}
	}
	return text + String.fromCharCode(...units);
}

/** The code point at `index`, joining a surrogate pair, and U+FFFD for a lone surrogate. */
function codePointAt(text: string, index: number): number {
	const unit = text.charCodeAt(index);
	if (unit < 0xd800 || unit > 0xdfff) return unit;
	const next = text.charCodeAt(index + 1);
	if (unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) return 0x10000 + ((unit - 0xd800) << 10) + (next - 0xdc00);
	return 0xfffd;
}

function writeCodePoint(bytes: Uint8Array, offset: number, point: number): number {
	if (point < 0x80) {
		bytes[offset] = point;
		return offset + 1;
	}
	if (point < 0x800) {
		bytes.set([0xc0 | (point >> 6), 0x80 | (point & 0x3f)], offset);
		return offset + 2;
	}
	if (point < 0x10000) {
		bytes.set([0xe0 | (point >> 12), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f)], offset);
		return offset + 3;
	}
	bytes.set([0xf0 | (point >> 18), 0x80 | ((point >> 12) & 0x3f), 0x80 | ((point >> 6) & 0x3f), 0x80 | (point & 0x3f)], offset);
	return offset + 4;
}

/** The code point that starts at `index`, and how many bytes it takes. */
function readCodePoint(bytes: Uint8Array, index: number): { point: number; size: number } {
	const first = byteAt(bytes, index);
	if (first < 0x80) return { point: first, size: 1 };
	const sequence = sequenceOf(first);
	if (index + sequence.size > bytes.length) throw new ProtocolError("Truncated UTF-8");
	let point = first & sequence.mask;
	for (let offset = 1; offset < sequence.size; offset++) {
		const byte = byteAt(bytes, index + offset);
		const [low, high] = offset === 1 ? sequence.second : [0x80, 0xbf];
		if (byte < low || byte > high) throw new ProtocolError("Invalid UTF-8");
		point = (point << 6) | (byte & 0x3f);
	}
	return { point, size: sequence.size };
}

/** The length of the sequence a lead byte starts, its payload bits, and the range its second byte must fall in. */
function sequenceOf(first: number): { size: number; mask: number; second: readonly [number, number] } {
	if (first >= 0xc2 && first <= 0xdf) return { size: 2, mask: 0x1f, second: [0x80, 0xbf] };
	if (first === 0xe0) return { size: 3, mask: 0x0f, second: [0xa0, 0xbf] };
	if (first === 0xed) return { size: 3, mask: 0x0f, second: [0x80, 0x9f] };
	if (first >= 0xe1 && first <= 0xef) return { size: 3, mask: 0x0f, second: [0x80, 0xbf] };
	if (first === 0xf0) return { size: 4, mask: 0x07, second: [0x90, 0xbf] };
	if (first >= 0xf1 && first <= 0xf3) return { size: 4, mask: 0x07, second: [0x80, 0xbf] };
	if (first === 0xf4) return { size: 4, mask: 0x07, second: [0x80, 0x8f] };
	throw new ProtocolError("Invalid UTF-8");
}

function byteAt(bytes: Uint8Array, index: number): number {
	const byte = bytes[index];
	if (byte === undefined) throw new ProtocolError("Truncated UTF-8");
	return byte;
}
