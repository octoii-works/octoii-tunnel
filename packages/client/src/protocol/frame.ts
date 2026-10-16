export const types = {
	hello: 0x01,
	welcome: 0x02,
	open: 0x10,
	head: 0x11,
	data: 0x12,
	message: 0x13,
	end: 0x14,
	reset: 0x15,
	window: 0x16,
	ping: 0x20,
	pong: 0x21,
} as const;

export type FrameType = (typeof types)[keyof typeof types];
export interface Frame {
	type: FrameType;
	stream: number;
	payload: Uint8Array;
}

export class ProtocolError extends Error {}

const connectionTypes = new Set<number>([types.hello, types.welcome, types.ping, types.pong]);
const knownTypes = new Set<number>(Object.values(types));
export const MAX_FRAME = 65_536;
export const MAX_BUFFER = 8 * 1024 * 1024;
export const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function isType(value: number): value is FrameType {
	return knownTypes.has(value);
}

export function encodeFrame(type: FrameType, stream: number, payload: Uint8Array = new Uint8Array()): Uint8Array<ArrayBuffer> {
	if (!Number.isInteger(stream) || stream < 0 || stream > 0xffff_ffff || payload.length > MAX_FRAME) {
		throw new ProtocolError("Invalid frame size or stream id");
	}
	const bytes = new Uint8Array(10 + payload.length);
	const view = new DataView(bytes.buffer);
	view.setUint8(0, 1);
	view.setUint8(1, type);
	view.setUint32(2, stream);
	view.setUint32(6, payload.length);
	bytes.set(payload, 10);
	return bytes;
}

export function decodeFrame(bytes: Uint8Array, maxFrame = MAX_FRAME): Frame {
	if (bytes.length < 10) throw new ProtocolError("Truncated frame");
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (view.getUint8(0) !== 1) throw new ProtocolError("Unsupported frame version");
	const type = view.getUint8(1);
	const stream = view.getUint32(2);
	const length = view.getUint32(6);
	if (!isType(type) || length !== bytes.length - 10 || length > maxFrame) {
		throw new ProtocolError("Invalid frame");
	}
	if (connectionTypes.has(type) !== (stream === 0)) throw new ProtocolError("Invalid stream id");
	if ((type === types.ping || type === types.pong) && length !== 8) {
		throw new ProtocolError("Invalid heartbeat");
	}
	if (type === types.window && length !== 4) throw new ProtocolError("Invalid window");
	return { type, stream, payload: bytes.subarray(10) };
}

export function jsonBytes(value: unknown): Uint8Array {
	return encoder.encode(JSON.stringify(value));
}

export function parseObject(bytes: Uint8Array): Record<string, unknown> {
	const value: unknown = JSON.parse(decoder.decode(bytes));
	if (!isObject(value)) throw new ProtocolError("Expected an object");
	return value;
}

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function positiveInteger(value: unknown, max = 0xffff_ffff): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max;
}

export function windowBytes(amount: number): Uint8Array {
	if (!positiveInteger(amount)) throw new ProtocolError("Invalid window increment");
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setUint32(0, amount);
	return bytes;
}

export function windowAmount(bytes: Uint8Array): number {
	if (bytes.length !== 4) throw new ProtocolError("Invalid window");
	const value = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
	if (!positiveInteger(value)) throw new ProtocolError("Empty window increment");
	return value;
}
