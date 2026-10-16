/** Base64url without padding (RFC 4648, section 5), written out, since Hermes has no `btoa` or `atob`. */
import { ProtocolError } from "./errors.ts";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const VALUES = new Map([...ALPHABET].map((char, index) => [char, index]));

/** `bytes` in base64url, without padding. */
export function encodeBase64Url(bytes: Uint8Array): string {
	let text = "";
	for (let index = 0; index < bytes.length; index += 3) {
		const chunk = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
		const chars = Math.min(4, Math.ceil(((bytes.length - index) * 8) / 6));
		for (let position = 0; position < chars; position++) text += ALPHABET.charAt((chunk >> (18 - position * 6)) & 63);
	}
	return text;
}

/** The bytes of unpadded base64url `text`; throws a `ProtocolError` for anything else, including stray trailing bits. */
export function decodeBase64Url(text: string): Uint8Array {
	if (text.length % 4 === 1) throw new ProtocolError("Invalid base64url length");
	const bytes = new Uint8Array(Math.floor((text.length * 6) / 8));
	let bits = 0;
	let buffer = 0;
	let length = 0;
	for (const char of text) {
		const value = VALUES.get(char);
		if (value === undefined) throw new ProtocolError("Invalid base64url character");
		buffer = (buffer << 6) | value;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			bytes[length++] = (buffer >> bits) & 0xff;
		}
	}
	if (buffer & ((1 << bits) - 1)) throw new ProtocolError("Invalid base64url padding bits");
	return bytes;
}
