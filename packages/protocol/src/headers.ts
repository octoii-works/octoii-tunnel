/** Header lists as frames carry them, and which headers cross the relay. */
import { ProtocolError } from "./errors.ts";

/** Headers as name and value pairs, in order, with repeats such as `set-cookie` kept apart. */
export type HeaderList = readonly (readonly [name: string, value: string])[];

/** The most headers one `open` or `head` carries. */
export const MAX_HEADERS = 128;

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FIELD_VALUE = /^[^\r\n\0]*$/;
const HOP_BY_HOP: ReadonlySet<string> = new Set(["connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade", "host"]);
const DROPPED_PREFIXES = ["proxy-", "sec-websocket-", "x-forwarded-"];

/** Whether `name` is a header name: an HTTP token. */
export function isHeaderName(name: string): boolean {
	return TOKEN.test(name);
}

/** The header list in `value`, checked: at most `MAX_HEADERS` pairs of a token and a value without line breaks. */
export function decodeHeaderList(value: unknown): HeaderList {
	if (!Array.isArray(value) || value.length > MAX_HEADERS) throw new ProtocolError("Invalid header list");
	return value.map((pair: unknown): readonly [string, string] => {
		if (!Array.isArray(pair) || pair.length !== 2) throw new ProtocolError("Invalid header");
		const [name, field]: unknown[] = pair;
		if (typeof name !== "string" || typeof field !== "string" || !isHeaderName(name) || !FIELD_VALUE.test(field)) {
			throw new ProtocolError("Invalid header");
		}
		return [name.toLowerCase(), field];
	});
}

/**
 * The headers that cross the relay, names in lower case: hop-by-hop headers, those `connection` names, `host`, proxy
 * headers, the WebSocket handshake's and any `x-forwarded-*` are left behind.
 */
export function forwardableHeaders(headers: Iterable<readonly [string, string]>): HeaderList {
	const pairs = Array.from(headers, ([name, field]): readonly [string, string] => [name.toLowerCase(), field]);
	const named = new Set(
		pairs
			.filter(([name]) => name === "connection")
			.flatMap(([, field]) => field.split(","))
			.map((name) => name.trim().toLowerCase()),
	);
	return pairs.filter(([name]) => !HOP_BY_HOP.has(name) && !named.has(name) && !DROPPED_PREFIXES.some((prefix) => name.startsWith(prefix)));
}
