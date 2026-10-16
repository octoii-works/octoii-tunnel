import { describe, expect, test } from "bun:test";
import { decodeBase64Url, decodeUtf8, encodeBase64Url, encodeUtf8, ProtocolError } from "../src/index.ts";

const SAMPLES = ["", "ascii", "ünïcödé", "日本語", "emoji 🐙 and 𝄞", "\u0000\u007f\u0080߿ࠀ￿", "x".repeat(10_000) + "🐙"];

describe("UTF-8", () => {
	test("encodes and decodes as the platform's encoder and strict decoder do", () => {
		for (const text of SAMPLES) {
			const bytes = encodeUtf8(text);
			expect(bytes).toEqual(new TextEncoder().encode(text));
			expect(decodeUtf8(bytes)).toBe(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		}
	});

	test("encodes a lone surrogate as U+FFFD", () => {
		expect(encodeUtf8("a\ud800b")).toEqual(new TextEncoder().encode("a\ud800b"));
		expect(encodeUtf8("\udc00")).toEqual(Uint8Array.from([0xef, 0xbf, 0xbd]));
	});

	test("refuses what a strict decoder refuses", () => {
		const invalid = [
			[0x80],
			[0xc0, 0xaf],
			[0xe0, 0x80, 0xaf],
			[0xed, 0xa0, 0x80],
			[0xf4, 0x90, 0x80, 0x80],
			[0xf5, 0x80, 0x80, 0x80],
			[0xe2, 0x82],
			[0xf0, 0x9f, 0x90],
		];
		for (const bytes of invalid) {
			const array = Uint8Array.from(bytes);
			expect(() => new TextDecoder("utf-8", { fatal: true }).decode(array)).toThrow();
			expect(() => decodeUtf8(array)).toThrow(ProtocolError);
		}
	});
});

describe("base64url", () => {
	test("encodes as the platform does, without padding, and decodes back", () => {
		for (let length = 0; length < 70; length++) {
			const bytes = crypto.getRandomValues(new Uint8Array(length));
			const text = encodeBase64Url(bytes);
			expect(text).toBe(Buffer.from(bytes).toString("base64url"));
			expect(decodeBase64Url(text)).toEqual(bytes);
		}
	});

	test("refuses other alphabets, impossible lengths and stray bits", () => {
		expect(() => decodeBase64Url("ab+/")).toThrow(ProtocolError);
		expect(() => decodeBase64Url("abcde")).toThrow(ProtocolError);
		expect(() => decodeBase64Url("QR")).toThrow(ProtocolError);
		expect(decodeBase64Url("QQ")).toEqual(Uint8Array.from([0x41]));
	});
});
