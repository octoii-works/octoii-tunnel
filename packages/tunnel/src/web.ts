/**
 * The platform of web standards: `Date.now`, `setTimeout` and `crypto.getRandomValues`, as Bun, Node, browsers and
 * workerd have them. It is the one file that reads them; on an engine without `crypto.getRandomValues`, such as Hermes,
 * pass a `Platform` whose `randomBytes` comes from the app's own secure source.
 */
import type { Platform } from "./platform.ts";

/** The web standards' clock, timers and secure randomness. */
export const webPlatform: Platform = {
	clock: {
		now: () => Date.now(),
		setTimer: (callback, delayMs) => {
			const timer = setTimeout(callback, delayMs);
			return () => clearTimeout(timer);
		},
	},
	randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
};
