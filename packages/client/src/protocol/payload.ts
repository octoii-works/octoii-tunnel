import { isObject, MAX_FRAME, parseObject, positiveInteger, ProtocolError } from "./frame.ts";

export type HeaderList = [string, string][];
export interface Limits {
	maxStreams: number;
	maxFrame: number;
	initialWindow: number;
	pingInterval: number;
	streamIdle: number;
}
export const defaultLimits: Limits = {
	maxStreams: 100,
	maxFrame: MAX_FRAME,
	initialWindow: 262_144,
	pingInterval: 20_000,
	streamIdle: 300_000,
};

export function parseLimits(bytes: Uint8Array): Limits {
	const value = parseObject(bytes);
	const { maxStreams, maxFrame, initialWindow, pingInterval, streamIdle } = value;
	if (
		!positiveInteger(maxStreams, 1000) ||
		!positiveInteger(maxFrame, MAX_FRAME) ||
		maxFrame < 1024 ||
		!positiveInteger(initialWindow, 1024 * 1024) ||
		initialWindow < maxFrame ||
		!positiveInteger(pingInterval, 300_000) ||
		!positiveInteger(streamIdle, 3_600_000)
	)
		throw new ProtocolError("Invalid limits");
	return { maxStreams, maxFrame, initialWindow, pingInterval, streamIdle };
}

export function parseHello(bytes: Uint8Array): { version: number; credential: string } {
	const value = parseObject(bytes);
	if (
		!positiveInteger(value.version) ||
		typeof value.credential !== "string" ||
		!/^[A-Za-z0-9_-]{43}$/.test(value.credential) ||
		typeof value.agent !== "string" ||
		value.agent.length > 128
	) {
		throw new ProtocolError("Invalid hello");
	}
	return { version: value.version, credential: value.credential };
}

export function parseHeaders(value: unknown): HeaderList {
	if (!Array.isArray(value) || value.length > 128) throw new ProtocolError("Invalid headers");
	const headers: HeaderList = [];
	for (const item of value) {
		if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== "string" || typeof item[1] !== "string") {
			throw new ProtocolError("Invalid header");
		}
		// Validate names and values before handing them to an HTTP runtime.
		new Headers([[item[0], item[1]]]);
		headers.push([item[0], item[1]]);
	}
	return headers;
}

export interface OpenPayload {
	kind: "http" | "websocket";
	method: string;
	path: string;
	headers: HeaderList;
	remote: { address: string };
}

export function parseOpen(bytes: Uint8Array): OpenPayload {
	const value = parseObject(bytes);
	if (
		(value.kind !== "http" && value.kind !== "websocket") ||
		typeof value.method !== "string" ||
		!/^[A-Z]+$/.test(value.method) ||
		["CONNECT", "TRACE", "TRACK"].includes(value.method) ||
		typeof value.path !== "string" ||
		!value.path.startsWith("/") ||
		value.path.includes("#") ||
		!isObject(value.remote) ||
		typeof value.remote.address !== "string"
	) {
		throw new ProtocolError("Invalid open");
	}
	return { kind: value.kind, method: value.method, path: value.path, headers: parseHeaders(value.headers), remote: { address: value.remote.address } };
}

export function parseHead(bytes: Uint8Array): { status: number; headers: HeaderList } {
	const value = parseObject(bytes);
	if (!positiveInteger(value.status, 599) || value.status < 200) throw new ProtocolError("Invalid status");
	return { status: value.status, headers: parseHeaders(value.headers) };
}

const resetCodes = new Set(["cancelled", "idle", "refused", "too_large", "protocol", "internal"]);
export function validateReset(bytes: Uint8Array): void {
	const value = parseObject(bytes);
	if (typeof value.code !== "string" || !resetCodes.has(value.code) || typeof value.reason !== "string" || value.reason.length > 256) {
		throw new ProtocolError("Invalid reset");
	}
}

const hopHeaders = new Set(["connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]);
export function forwardedHeaders(headers: Headers): HeaderList {
	const removed = new Set(
		(headers.get("connection") ?? "")
			.toLowerCase()
			.split(",")
			.map((s) => s.trim()),
	);
	const result: HeaderList = [];
	for (const [name, value] of headers) {
		if (
			hopHeaders.has(name) ||
			removed.has(name) ||
			name.startsWith("proxy-") ||
			name.startsWith("sec-websocket-") ||
			name.startsWith("x-forwarded-") ||
			name === "host"
		)
			continue;
		result.push([name, value]);
	}
	return result;
}
