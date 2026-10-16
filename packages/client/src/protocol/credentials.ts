import { equalBytes } from "@noble/ciphers/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { encoder } from "./frame.ts";

export function randomDeviceId(): string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
	return Array.from(crypto.getRandomValues(new Uint8Array(26)), (byte) => alphabet[byte & 31]).join("");
}
export function randomCredential(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/, "");
}
export function credentialHash(value: string): string {
	return bytesToHex(sha256(encoder.encode(value)));
}
export function equalSecrets(left: string, right: string): boolean {
	return equalBytes(sha256(encoder.encode(left)), sha256(encoder.encode(right)));
}
export function validDeviceId(value: string): boolean {
	return /^[a-z2-7]{26}$/.test(value);
}
