/** The limits the relay announces in `welcome`, in bytes and milliseconds. */
import { ProtocolError } from "./errors.ts";
import { MAX_FRAME_SIZE } from "./frame.ts";
import { isIntegerBetween, type JsonObject } from "./json.ts";

/** What a relay allows on one connector connection. */
export type Limits = {
	/** The most streams open at once. */
	readonly maxStreams: number;
	/** The most payload bytes in one frame. */
	readonly maxFrame: number;
	/** The credit each side starts with on a stream, and the most it may have outstanding. */
	readonly initialCredit: number;
	/** How often the connector sends a heartbeat. */
	readonly heartbeat: number;
	/** How long a stream may go without a frame before it is reset. */
	readonly streamIdle: number;
};

/** The limits a relay announces unless it is configured otherwise. */
export const DEFAULT_LIMITS: Limits = {
	maxStreams: 100,
	maxFrame: MAX_FRAME_SIZE,
	initialCredit: 262_144,
	heartbeat: 25_000,
	streamIdle: 300_000,
};

/** The largest WebSocket message a stream carries, after reassembly. */
export const MAX_MESSAGE_SIZE = 16 * 1024 * 1024;

/** The range each limit must fall in; `initialCredit` must also be at least `maxFrame`. */
export const LIMIT_RANGES: { readonly [Name in keyof Limits]: readonly [number, number] } = {
	maxStreams: [1, 1000],
	maxFrame: [1024, MAX_FRAME_SIZE],
	initialCredit: [1024, 1_048_576],
	heartbeat: [5000, 120_000],
	streamIdle: [10_000, 3_600_000],
};

/** The limits in `value`, checked against their ranges; throws a `ProtocolError` for any out of range or missing. */
export function checkLimits(value: JsonObject): Limits {
	const limits = {
		maxStreams: limitOf(value, "maxStreams"),
		maxFrame: limitOf(value, "maxFrame"),
		initialCredit: limitOf(value, "initialCredit"),
		heartbeat: limitOf(value, "heartbeat"),
		streamIdle: limitOf(value, "streamIdle"),
	};
	if (limits.initialCredit < limits.maxFrame) throw new ProtocolError("initialCredit is smaller than maxFrame");
	return limits;
}

function limitOf(value: JsonObject, name: keyof Limits): number {
	const [min, max] = LIMIT_RANGES[name];
	const limit = value[name];
	if (!isIntegerBetween(limit, min, max)) throw new ProtocolError(`${name} is not from ${min} to ${max}`);
	return limit;
}
