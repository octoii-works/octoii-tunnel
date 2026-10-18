/** Channel frames, the plaintext of each Noise transport message of a secure channel. */
import { ProtocolError } from "@octoii/tunnel-protocol";
import { MAX_MESSAGE_LENGTH, TAG_LENGTH } from "./noise.ts";

/** The channel frame types, by name. */
export const CHANNEL_FRAME = {
	MESSAGE: 0x01,
	REQUEST: 0x02,
	RESPONSE: 0x03,
	BODY: 0x04,
	END: 0x05,
	CANCEL: 0x06,
	CLOSE: 0x07,
	READY: 0x08,
} as const;

/** A channel frame type. */
export type ChannelFrameType = (typeof CHANNEL_FRAME)[keyof typeof CHANNEL_FRAME];

/** A decoded channel frame. */
export type ChannelFrame = {
	readonly type: ChannelFrameType;
	/** `0` for messages and the channel's own frames; a request id for the frames of a fetch. */
	readonly id: number;
	readonly payload: Uint8Array;
};

/** The bytes of a channel frame's header: its type and id. */
const HEADER_SIZE = 5;
/** The most payload bytes a channel frame carries, so it fits one Noise transport message. */
export const MAX_CHANNEL_PAYLOAD = MAX_MESSAGE_LENGTH - TAG_LENGTH - HEADER_SIZE;

const TYPES: ReadonlySet<number> = new Set(Object.values(CHANNEL_FRAME));

/** The bytes of a channel frame. */
export function encodeChannelFrame(type: ChannelFrameType, id: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
	if (payload.length > MAX_CHANNEL_PAYLOAD) throw new ProtocolError("Channel frame too large");
	const bytes = new Uint8Array(HEADER_SIZE + payload.length);
	const view = new DataView(bytes.buffer);
	view.setUint8(0, type);
	view.setUint32(1, id);
	bytes.set(payload, HEADER_SIZE);
	return bytes;
}

/** The channel frame in `bytes`; throws a `ProtocolError` for a short frame or an unknown type. */
export function decodeChannelFrame(bytes: Uint8Array): ChannelFrame {
	if (bytes.length < HEADER_SIZE) throw new ProtocolError("Truncated channel frame");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const type = view.getUint8(0);
	if (!isChannelFrameType(type)) throw new ProtocolError("Unknown channel frame type");
	return { type, id: view.getUint32(1), payload: bytes.subarray(HEADER_SIZE) };
}

function isChannelFrameType(value: number): value is ChannelFrameType {
	return TYPES.has(value);
}
