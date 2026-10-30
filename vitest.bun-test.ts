/**
 * `bun:test` on Node: Vitest's `describe`, `it`, `expect` and hooks, with what the tests use of Bun's runner that
 * Vitest names otherwise or lacks.
 */
import { expect } from "vitest";

export * from "vitest";

expect.extend({
	toStartWith(received: unknown, prefix: string) {
		const pass = typeof received === "string" && received.startsWith(prefix);
		return { pass, message: () => `expected ${JSON.stringify(received)} ${pass ? "not " : ""}to start with ${JSON.stringify(prefix)}` };
	},
	toEndWith(received: unknown, suffix: string) {
		const pass = typeof received === "string" && received.endsWith(suffix);
		return { pass, message: () => `expected ${JSON.stringify(received)} ${pass ? "not " : ""}to end with ${JSON.stringify(suffix)}` };
	},
	toBeNumber(received: unknown) {
		const pass = typeof received === "number";
		return { pass, message: () => `expected ${JSON.stringify(received)} ${pass ? "not " : ""}to be a number` };
	},
});
