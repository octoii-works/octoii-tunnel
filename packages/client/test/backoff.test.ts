import { expect, test } from "bun:test";
import { reconnectDelay } from "../src/index.ts";

test("reconnect delays fall below a cap that doubles from one second to a minute", () => {
	expect([0, 1, 2, 3, 6, 7, 30].map((attempt) => reconnectDelay(attempt, () => 0.999_999))).toEqual([999, 1999, 3999, 7999, 59_999, 59_999, 59_999]);
	expect(reconnectDelay(4, () => 0)).toBe(0);
});
