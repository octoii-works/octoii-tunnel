/** The rules of the connector connection outside frames: heartbeats, deadlines, close and reset codes. */

/** The text message a connector sends as a heartbeat. */
export const PING = "ping";
/** The text message that answers a heartbeat. */
export const PONG = "pong";
/** How many heartbeat intervals of silence end a connection, on either side. */
export const MISSED_HEARTBEATS = 3;
/** How long the relay waits for `hello` after the upgrade, in milliseconds. */
export const HELLO_TIMEOUT = 10_000;

/** The close codes of the connector connection, by name. */
export const CLOSE_CODE = {
	NORMAL: 1000,
	GOING_AWAY: 1001,
	INTERNAL_ERROR: 1011,
	RESTART: 1012,
	REPLACED: 4000,
	UNAUTHORIZED: 4001,
	UNSUPPORTED_VERSION: 4002,
	HELLO_TIMEOUT: 4003,
	MALFORMED: 4004,
} as const;

/** The close codes after which a connector stops instead of reconnecting. */
export const FINAL_CLOSE_CODES: ReadonlySet<number> = new Set([
	CLOSE_CODE.NORMAL,
	CLOSE_CODE.REPLACED,
	CLOSE_CODE.UNAUTHORIZED,
	CLOSE_CODE.UNSUPPORTED_VERSION,
]);

/** Why a stream was reset. */
export const RESET_CODES = ["cancelled", "idle", "refused", "too_large", "protocol", "internal"] as const;

/** A reset code. */
export type ResetCode = (typeof RESET_CODES)[number];

/** The longest reason a `reset` or a WebSocket `end` may give. */
export const MAX_REASON_LENGTH = 256;

/** Whether `value` is a reset code. */
export function isResetCode(value: unknown): value is ResetCode {
	return RESET_CODES.some((code) => code === value);
}
