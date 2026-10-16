/** The payload of each frame type, encoded and decoded; decoding checks every field and throws a `ProtocolError`. */
import { isResetCode, MAX_REASON_LENGTH, type ResetCode } from "./connection.ts";
import { ProtocolError } from "./errors.ts";
import { isCredential } from "./formats.ts";
import { decodeHeaderList, type HeaderList, isHeaderName } from "./headers.ts";
import { decodeJsonObject, encodeJson, isIntegerBetween, isStringUpTo, type JsonObject } from "./json.ts";
import { checkLimits, type Limits } from "./limits.ts";
import { encodeUtf8 } from "./utf8.ts";

/** What a connector sends first: the protocol version, its device's credential, and its own name and version. */
export type Hello = { readonly version: number; readonly credential: string; readonly connector: string };

/** The kind of a stream. */
export type StreamKind = "http" | "websocket";

/** A new stream, as the relay opens it for a visitor. */
export type Open = {
	readonly kind: StreamKind;
	readonly method: string;
	/** The path and query, starting with `/`. */
	readonly path: string;
	readonly headers: HeaderList;
	/** The WebSocket subprotocols the visitor asked for; empty for an HTTP stream. */
	readonly protocols: readonly string[];
	readonly remote: { readonly address: string };
};

/** The start of an HTTP response. */
export type HttpHead = { readonly status: number; readonly headers: HeaderList };

/** The connector's answer to a WebSocket stream: accepted, maybe with a subprotocol, or refused with an HTTP status. */
export type WebSocketHead = { readonly accept: true; readonly protocol?: string } | { readonly accept: false; readonly status: number };

/** How one side closed a WebSocket stream. */
export type Closing = { readonly code: number; readonly reason: string };

/** Why a stream was reset. */
export type Reset = { readonly code: ResetCode; readonly reason: string };

/** One frame's part of a WebSocket message. */
export type MessageChunk = { readonly binary: boolean; readonly more: boolean; readonly bytes: Uint8Array };

const METHOD = /^[A-Z]{1,16}$/;
const REFUSED_METHODS: ReadonlySet<string> = new Set(["CONNECT", "TRACE", "TRACK"]);
const MAX_PATH_LENGTH = 8192;
const MAX_PROTOCOLS = 16;
const MAX_NAME_LENGTH = 128;
const MAX_ADDRESS_LENGTH = 64;
/** The most UTF-8 bytes a WebSocket close frame leaves for its reason. */
const MAX_CLOSE_REASON_BYTES = 123;
const BINARY = 0b01;
const MORE = 0b10;

/** The payload of `hello`. */
export function encodeHello(hello: Hello): Uint8Array {
	return encodeJson(hello);
}

/** The `hello` in a payload, checked. */
export function decodeHello(bytes: Uint8Array): Hello {
	const value = decodeJsonObject(bytes);
	const { version, credential, connector } = value;
	if (!isIntegerBetween(version, 1, 255) || !isCredential(credential) || !isStringUpTo(connector, MAX_NAME_LENGTH)) {
		throw new ProtocolError("Invalid hello");
	}
	return { version, credential, connector };
}

/** The payload of `welcome`: the relay's limits. */
export function encodeWelcome(limits: Limits): Uint8Array {
	return encodeJson(limits);
}

/** The limits in a `welcome` payload, checked against their ranges. */
export function decodeWelcome(bytes: Uint8Array): Limits {
	return checkLimits(decodeJsonObject(bytes));
}

/** The payload of `open`; `protocols` is left out when empty. */
export function encodeOpen(open: Open): Uint8Array {
	const { protocols, ...rest } = open;
	return encodeJson(protocols.length === 0 ? rest : open);
}

/** The new stream in an `open` payload, checked: its kind, method, path, headers, subprotocols and remote address. */
export function decodeOpen(bytes: Uint8Array): Open {
	const value = decodeJsonObject(bytes);
	const { kind, method, path } = value;
	if (kind !== "http" && kind !== "websocket") throw new ProtocolError("Invalid stream kind");
	if (typeof method !== "string" || !METHOD.test(method) || REFUSED_METHODS.has(method)) throw new ProtocolError("Invalid method");
	if (!isStringUpTo(path, MAX_PATH_LENGTH) || !path.startsWith("/") || path.includes("#")) throw new ProtocolError("Invalid path");
	return { kind, method, path, headers: decodeHeaderList(value["headers"]), protocols: protocolsOf(value), remote: remoteOf(value) };
}

/** The payload of `head` for an HTTP stream. */
export function encodeHttpHead(head: HttpHead): Uint8Array {
	return encodeJson(head);
}

/** The response start in an HTTP stream's `head`, checked: a final status and a header list. */
export function decodeHttpHead(bytes: Uint8Array): HttpHead {
	const value = decodeJsonObject(bytes);
	const { status } = value;
	if (!isIntegerBetween(status, 200, 599)) throw new ProtocolError("Invalid status");
	return { status, headers: decodeHeaderList(value["headers"]) };
}

/** The payload of `head` for a WebSocket stream. */
export function encodeWebSocketHead(head: WebSocketHead): Uint8Array {
	return encodeJson(head);
}

/** The connector's answer in a WebSocket stream's `head`, checked. */
export function decodeWebSocketHead(bytes: Uint8Array): WebSocketHead {
	const value = decodeJsonObject(bytes);
	const { accept, protocol, status } = value;
	if (accept === false) {
		if (!isIntegerBetween(status, 400, 599)) throw new ProtocolError("Invalid refusal status");
		return { accept, status };
	}
	if (accept !== true) throw new ProtocolError("Invalid WebSocket head");
	if (protocol === undefined) return { accept };
	if (typeof protocol !== "string" || !isHeaderName(protocol)) throw new ProtocolError("Invalid subprotocol");
	return { accept, protocol };
}

/** The payload of a WebSocket stream's `end`. */
export function encodeClosing(closing: Closing): Uint8Array {
	return encodeJson(closing);
}

/** A WebSocket stream's `end`: a code that a close frame may carry, and a reason that fits in one. */
export function decodeClosing(bytes: Uint8Array): Closing {
	const value = decodeJsonObject(bytes);
	const { code, reason } = value;
	if (!isSendableCloseCode(code)) throw new ProtocolError("Invalid close code");
	if (typeof reason !== "string" || encodeUtf8(reason).length > MAX_CLOSE_REASON_BYTES) throw new ProtocolError("Invalid close reason");
	return { code, reason };
}

/** Whether `code` is one a WebSocket endpoint may send in a close frame. */
export function isSendableCloseCode(code: unknown): code is number {
	return isIntegerBetween(code, 1000, 1003) || isIntegerBetween(code, 1007, 1014) || isIntegerBetween(code, 3000, 4999);
}

/** The payload of `reset`. */
export function encodeReset(reset: Reset): Uint8Array {
	return encodeJson(reset);
}

/** The reason in a `reset` payload, checked. */
export function decodeReset(bytes: Uint8Array): Reset {
	const value = decodeJsonObject(bytes);
	const { code, reason } = value;
	if (!isResetCode(code) || !isStringUpTo(reason, MAX_REASON_LENGTH)) throw new ProtocolError("Invalid reset");
	return { code, reason };
}

/** The payload of `credit`: a grant of 1 to 2^32 − 1 bytes. */
export function encodeCredit(amount: number): Uint8Array {
	if (!isIntegerBetween(amount, 1, 0xffff_ffff)) throw new ProtocolError("Invalid credit");
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setUint32(0, amount);
	return bytes;
}

/** The grant in a `credit` payload. */
export function decodeCredit(bytes: Uint8Array): number {
	if (bytes.length !== 4) throw new ProtocolError("Invalid credit");
	const amount = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
	if (amount === 0) throw new ProtocolError("Empty credit");
	return amount;
}

/** The payload of `message`: the flags byte, then the chunk. */
export function encodeMessageChunk(chunk: MessageChunk): Uint8Array {
	const bytes = new Uint8Array(1 + chunk.bytes.length);
	bytes[0] = (chunk.binary ? BINARY : 0) | (chunk.more ? MORE : 0);
	bytes.set(chunk.bytes, 1);
	return bytes;
}

/** The chunk in a `message` payload, refusing unknown flags. */
export function decodeMessageChunk(payload: Uint8Array): MessageChunk {
	const flags = payload[0];
	if (flags === undefined || (flags & ~(BINARY | MORE)) !== 0) throw new ProtocolError("Invalid message flags");
	return { binary: (flags & BINARY) !== 0, more: (flags & MORE) !== 0, bytes: payload.subarray(1) };
}

function protocolsOf(value: JsonObject): readonly string[] {
	const protocols = value["protocols"];
	if (protocols === undefined) return [];
	if (!Array.isArray(protocols) || protocols.length > MAX_PROTOCOLS) throw new ProtocolError("Invalid subprotocols");
	return protocols.map((protocol: unknown) => {
		if (typeof protocol !== "string" || !isHeaderName(protocol)) throw new ProtocolError("Invalid subprotocol");
		return protocol;
	});
}

function remoteOf(value: JsonObject): { readonly address: string } {
	const remote = value["remote"];
	const address = typeof remote === "object" && remote !== null && "address" in remote ? remote.address : undefined;
	if (!isStringUpTo(address, MAX_ADDRESS_LENGTH)) throw new ProtocolError("Invalid remote");
	return { address };
}
