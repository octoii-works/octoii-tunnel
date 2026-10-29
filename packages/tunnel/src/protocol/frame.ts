/** Frames, the binary messages of the connector connection: a ten-byte header, then the payload. */
import { ProtocolError } from "./errors.ts";

/** The protocol version every frame and `hello` carries. */
export const PROTOCOL_VERSION = 1;
/** The bytes of a frame's header: version, type, stream id and payload length. */
export const FRAME_HEADER_SIZE = 10;
/** The most payload bytes any frame may carry; `welcome` may announce less. */
export const MAX_FRAME_SIZE = 65_536;

/** The frame types, by name. */
export const FRAME_TYPE = {
	HELLO: 0x01,
	WELCOME: 0x02,
	OPEN: 0x10,
	HEAD: 0x11,
	DATA: 0x12,
	MESSAGE: 0x13,
	END: 0x14,
	RESET: 0x15,
	CREDIT: 0x16,
} as const;

/** A frame type. */
export type FrameType = (typeof FRAME_TYPE)[keyof typeof FRAME_TYPE];

/** A decoded frame. */
export type Frame = {
	readonly type: FrameType;
	/** The stream it belongs to; `0` for `hello` and `welcome`. */
	readonly stream: number;
	readonly payload: Uint8Array;
};

const FRAME_TYPES: ReadonlySet<number> = new Set(Object.values(FRAME_TYPE));
const CONNECTION_FRAME_TYPES: ReadonlySet<number> = new Set([FRAME_TYPE.HELLO, FRAME_TYPE.WELCOME]);
const MAX_STREAM_ID = 0xffff_ffff;
const EMPTY = new Uint8Array(0);

/** Whether `value` is a frame type. */
export function isFrameType(value: number): value is FrameType {
	return FRAME_TYPES.has(value);
}

/** The bytes of a frame. */
export function encodeFrame(type: FrameType, stream: number, payload: Uint8Array = EMPTY): Uint8Array<ArrayBuffer> {
	if (!Number.isInteger(stream) || stream < 0 || stream > MAX_STREAM_ID) throw new ProtocolError("Invalid stream id");
	if (payload.length > MAX_FRAME_SIZE) throw new ProtocolError("Frame payload too large");
	const bytes = new Uint8Array(FRAME_HEADER_SIZE + payload.length);
	const view = new DataView(bytes.buffer);
	view.setUint8(0, PROTOCOL_VERSION);
	view.setUint8(1, type);
	view.setUint32(2, stream);
	view.setUint32(6, payload.length);
	bytes.set(payload, FRAME_HEADER_SIZE);
	return bytes;
}

/**
 * The frame that `bytes` hold, checked: its version, a known type, a length that matches, a payload of at most
 * `maxPayload` bytes, and a stream id of `0` exactly for the connection's own frames. Throws a `ProtocolError`.
 */
export function decodeFrame(bytes: Uint8Array, maxPayload: number): Frame {
	if (bytes.length < FRAME_HEADER_SIZE) throw new ProtocolError("Truncated frame");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint8(0) !== PROTOCOL_VERSION) throw new ProtocolError("Unsupported frame version");
	const type = view.getUint8(1);
	const stream = view.getUint32(2);
	const length = view.getUint32(6);
	if (!isFrameType(type)) throw new ProtocolError("Unknown frame type");
	if (length !== bytes.length - FRAME_HEADER_SIZE || length > maxPayload) throw new ProtocolError("Invalid frame length");
	if (CONNECTION_FRAME_TYPES.has(type) !== (stream === 0)) throw new ProtocolError("Invalid stream id for frame type");
	return { type, stream, payload: bytes.subarray(FRAME_HEADER_SIZE) };
}
