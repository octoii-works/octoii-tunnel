/** The formats of a device's id, credential and address, and how the relay keeps and compares credentials. */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { encodeBase64Url } from "./base64url.ts";
import { ProtocolError } from "./errors.ts";
import { encodeUtf8 } from "./utf8.ts";

const DEVICE_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
/** How many characters a device id has: 130 random bits of lowercase base32, which is also a DNS label. */
export const DEVICE_ID_LENGTH = 26;
const DEVICE_ID = /^[a-z2-7]{26}$/;
/** How many random bytes a credential has; in base64url it is 43 characters. */
export const CREDENTIAL_BYTES = 32;
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;

/** Whether `value` is a device id. */
export function isDeviceId(value: unknown): value is string {
	return typeof value === "string" && DEVICE_ID.test(value);
}

/** A new random device id. */
export function newDeviceId(): string {
	// 32 divides 256, so masking a random byte to 5 bits keeps every character equally likely.
	const bytes = crypto.getRandomValues(new Uint8Array(DEVICE_ID_LENGTH));
	return Array.from(bytes, (byte) => DEVICE_ID_ALPHABET.charAt(byte & 31)).join("");
}

/** Whether `value` is a credential. */
export function isCredential(value: unknown): value is string {
	return typeof value === "string" && CREDENTIAL.test(value);
}

/** A new random credential. */
export function newCredential(): string {
	return encodeBase64Url(crypto.getRandomValues(new Uint8Array(CREDENTIAL_BYTES)));
}

/** What the relay keeps of a credential: its SHA-256 in hex. */
export function hashCredential(credential: string): string {
	return bytesToHex(sha256(encodeUtf8(credential)));
}

/** Whether two secrets are equal, in time that does not depend on where they differ. */
export function sameSecret(left: string, right: string): boolean {
	const a = sha256(encodeUtf8(left));
	const b = sha256(encodeUtf8(right));
	let difference = 0;
	for (let index = 0; index < a.length; index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
	return difference === 0;
}

/** A relay's origin: its scheme and host (with the port, if any). */
export type RelayOrigin = {
	readonly scheme: "http" | "https";
	/** The host and, when one is given, the port, such as `takotunnel.dev` or `127.0.0.1:8787`. */
	readonly host: string;
	/** `<scheme>://<host>`. */
	readonly origin: string;
};

const ORIGIN = /^(https?):\/\/([a-z0-9.-]+|\[[0-9a-f:.]+\])(:\d{1,5})?\/?$/;

/**
 * A relay's origin, parsed and checked: http or https, then a host and an optional port, with nothing after. Throws a
 * `ProtocolError` for anything else. It needs no `URL`, which React Native implements only in part.
 */
export function parseRelayOrigin(value: string): RelayOrigin {
	const match = ORIGIN.exec(value.toLowerCase());
	const scheme = match?.[1];
	const hostname = match?.[2];
	if ((scheme !== "http" && scheme !== "https") || hostname === undefined) {
		throw new ProtocolError("A relay origin is http or https, then a host and an optional port, with nothing after");
	}
	const host = hostname + (match?.[3] ?? "");
	return { scheme, host, origin: `${scheme}://${host}` };
}

/** The address visitors reach a device at: `<scheme>://<device id>.<relay host>`. */
export function deviceAddress(relay: RelayOrigin, deviceId: string): string {
	return `${relay.scheme}://${deviceId}.${relay.host}`;
}
