/**
 * What the client takes from its host: the time, timers and secure randomness. The root entry reads them from nowhere
 * else, so it runs wherever JavaScript does, and a test can run it on a clock of its own.
 */

/** The time and timers. */
export type Clock = {
	/** The time, in milliseconds since the epoch. */
	now(): number;
	/** Runs `callback` after `delayMs`, never synchronously, and returns a function that cancels it. */
	setTimer(callback: () => void, delayMs: number): () => void;
};

/** `length` bytes from a cryptographically secure source of randomness. */
export type RandomBytes = (length: number) => Uint8Array;

/** What a host gives the client: its clock and its randomness. `webPlatform` in `/web` is the web standards' own. */
export type Platform = { readonly clock: Clock; readonly randomBytes: RandomBytes };

/** Runs `callback` every `intervalMs` on `clock` until the returned function is called. */
export function repeat(clock: Clock, callback: () => void, intervalMs: number): () => void {
	let cancel = (): void => undefined;
	const schedule = (): void => {
		cancel = clock.setTimer(() => {
			schedule();
			callback();
		}, intervalMs);
	};
	schedule();
	return () => cancel();
}

/** A random number from 0 up to but not including 1, from 32 random bits. */
export function randomFraction(randomBytes: RandomBytes): number {
	const bytes = randomBytes(4);
	return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0) / 2 ** 32;
}
