/** When a connector tries again after its connection closed. */

/** The cap of the first delay, in milliseconds. */
export const FIRST_RECONNECT_DELAY = 1000;
/** The largest cap, in milliseconds. */
export const MAX_RECONNECT_DELAY = 60_000;
/** A connection that lasted this long counts as stable: the next attempt starts over at the first delay. */
export const STABLE_CONNECTION = 60_000;

/**
 * The delay before reconnect attempt `attempt`, counting from 0: a random point below a cap that doubles from
 * `FIRST_RECONNECT_DELAY` up to `MAX_RECONNECT_DELAY` (full jitter), so many connectors do not retry in step.
 */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
	const cap = Math.min(MAX_RECONNECT_DELAY, FIRST_RECONNECT_DELAY * 2 ** Math.min(attempt, 16));
	return Math.floor(random() * cap);
}
