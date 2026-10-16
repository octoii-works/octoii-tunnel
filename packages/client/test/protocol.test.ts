import { describe, expect, test } from "bun:test";
import {
	decodeFrame,
	encodeFrame,
	jsonBytes,
	parseHello,
	parseLimits,
	defaultLimits,
	ReceiveBody,
	SendWindow,
	types,
	windowAmount,
	windowBytes,
	validateReset,
} from "../src/protocol/index.ts";

describe("frame validation", () => {
	test("decodes network-order stream ids and rejects truncated and oversized messages", () => {
		const bytes = encodeFrame(types.data, 0x12345678, new Uint8Array([1, 2, 3]));
		expect([...bytes.subarray(0, 10)]).toEqual([1, 0x12, 0x12, 0x34, 0x56, 0x78, 0, 0, 0, 3]);
		expect(decodeFrame(bytes).stream).toBe(0x12345678);
		expect(() => decodeFrame(bytes.subarray(0, 12))).toThrow();
		expect(() => decodeFrame(bytes, 2)).toThrow();
		expect(() => decodeFrame(encodeFrame(types.data, 0))).toThrow();
		expect(() => decodeFrame(encodeFrame(types.ping, 0, new Uint8Array(7)))).toThrow();
	});
	test("validates external handshake fields and bounded limits", () => {
		expect(() => parseHello(jsonBytes({ version: 1, credential: 4, agent: "test" }))).toThrow();
		expect(() => parseLimits(jsonBytes({ ...defaultLimits, initialWindow: 1 }))).toThrow();
		expect(() => windowAmount(new Uint8Array(4))).toThrow();
		expect(windowAmount(windowBytes(65536))).toBe(65536);
		expect(() => validateReset(jsonBytes({ code: "cancelled" }))).toThrow();
		expect(() => validateReset(jsonBytes({ code: "unknown", reason: "" }))).toThrow();
		expect(() => validateReset(jsonBytes({ code: "cancelled", reason: "Visitor left" }))).not.toThrow();
	});
});

test("a stalled reader returns no credit and excess data is rejected", async () => {
	let credit = 0;
	const body = new ReceiveBody(
		4,
		(size) => {
			credit += size;
		},
		() => {},
	);
	body.push(new Uint8Array([1, 2, 3, 4]));
	expect(credit).toBe(0);
	expect(() => body.push(new Uint8Array([5]))).toThrow();
	const reader = body.stream.getReader();
	expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3, 4]));
	expect(credit).toBe(4);
	body.end();
	expect((await reader.read()).done).toBe(true);
});

test("blocked sends resume with credit and fail promptly on cancellation", async () => {
	const window = new SendWindow(4);
	expect(await window.take(4)).toBe(4);
	const pending = window.take(4);
	window.grant(2);
	expect(await pending).toBe(2);
	const cancelled = window.take(4);
	window.fail(new Error("cancelled"));
	await expect(cancelled).rejects.toThrow("cancelled");
	expect(() => window.grant(5)).toThrow();
});
