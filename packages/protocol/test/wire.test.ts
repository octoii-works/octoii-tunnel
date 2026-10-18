import { describe, expect, test } from "bun:test";
import {
	checkLimits,
	decodeClosing,
	decodeCredit,
	decodeFrame,
	decodeHello,
	decodeHttpHead,
	decodeMessageChunk,
	decodeOpen,
	decodeRegistration,
	decodeReset,
	decodeWebSocketHead,
	decodeWelcome,
	DEFAULT_LIMITS,
	deviceAddress,
	encodeCredit,
	encodeFrame,
	encodeHello,
	encodeJson,
	encodeMessageChunk,
	encodeOpen,
	encodeWelcome,
	forwardableHeaders,
	FRAME_TYPE,
	hashCredential,
	isCredential,
	isDeviceId,
	matchDevicePath,
	MAX_FRAME_SIZE,
	newCredential,
	newDeviceId,
	parseRelayOrigin,
	ProtocolError,
	sameSecret,
} from "../src/index.ts";

describe("frames", () => {
	test("carry the version, type, stream id and payload length in network order", () => {
		const bytes = encodeFrame(FRAME_TYPE.DATA, 0x01020304, Uint8Array.from([9, 8]));
		expect([...bytes]).toEqual([1, 0x12, 1, 2, 3, 4, 0, 0, 0, 2, 9, 8]);
		expect(decodeFrame(bytes, MAX_FRAME_SIZE)).toEqual({ type: FRAME_TYPE.DATA, stream: 0x01020304, payload: Uint8Array.from([9, 8]) });
	});

	test("are refused when truncated, too long, of an unknown type or version, or on the wrong stream", () => {
		const frame = encodeFrame(FRAME_TYPE.DATA, 1, new Uint8Array(4));
		expect(() => decodeFrame(frame.subarray(0, 9), MAX_FRAME_SIZE)).toThrow(ProtocolError);
		expect(() => decodeFrame(frame.subarray(0, 12), MAX_FRAME_SIZE)).toThrow(ProtocolError);
		expect(() => decodeFrame(frame, 3)).toThrow(ProtocolError);
		expect(() => decodeFrame(Uint8Array.from([1, 0x7f, 0, 0, 0, 1, 0, 0, 0, 0]), MAX_FRAME_SIZE)).toThrow(ProtocolError);
		expect(() => decodeFrame(Uint8Array.from([2, 0x12, 0, 0, 0, 1, 0, 0, 0, 0]), MAX_FRAME_SIZE)).toThrow(ProtocolError);
		expect(() => decodeFrame(encodeFrame(FRAME_TYPE.HELLO, 3), MAX_FRAME_SIZE)).toThrow(ProtocolError);
		expect(() => decodeFrame(encodeFrame(FRAME_TYPE.OPEN, 0), MAX_FRAME_SIZE)).toThrow(ProtocolError);
	});
});

describe("formats", () => {
	test("make device ids and credentials that their checks accept", () => {
		for (let round = 0; round < 50; round++) {
			expect(isDeviceId(newDeviceId())).toBe(true);
			expect(isCredential(newCredential())).toBe(true);
		}
		expect(isDeviceId("ABCDEFGHIJKLMNOPQRSTUVWXYZ")).toBe(false);
		expect(isCredential("short")).toBe(false);
	});

	test("hash credentials and compare secrets", () => {
		const credential = newCredential();
		expect(hashCredential(credential)).toMatch(/^[0-9a-f]{64}$/);
		expect(sameSecret(credential, credential)).toBe(true);
		expect(sameSecret(credential, newCredential())).toBe(false);
	});

	test("parse a relay origin without URL and give a device its address", () => {
		const relay = parseRelayOrigin("https://octoiitunnel.com/");
		expect(relay).toEqual({ scheme: "https", host: "octoiitunnel.com", origin: "https://octoiitunnel.com" });
		expect(deviceAddress(parseRelayOrigin("http://127.0.0.1:8787"), "a".repeat(26))).toBe(`http://${"a".repeat(26)}.127.0.0.1:8787`);
		for (const bad of ["ftp://x.dev", "https://user@x.dev", "https://x.dev/path", "https://x.dev?q", "x.dev"]) {
			expect(() => parseRelayOrigin(bad)).toThrow(ProtocolError);
		}
	});
});

describe("payloads", () => {
	test("hello and welcome round-trip and refuse what breaks their rules", () => {
		const hello = { version: 1, credential: newCredential(), connector: "octoiitunnel/1.0.0" };
		expect(decodeHello(encodeHello(hello))).toEqual(hello);
		expect(() => decodeHello(encodeJson({ ...hello, credential: "x" }))).toThrow(ProtocolError);
		expect(decodeWelcome(encodeWelcome(DEFAULT_LIMITS))).toEqual(DEFAULT_LIMITS);
		expect(() => checkLimits({ ...DEFAULT_LIMITS, initialCredit: 2048, maxFrame: 4096 })).toThrow(ProtocolError);
		expect(() => checkLimits({ ...DEFAULT_LIMITS, heartbeat: 1 })).toThrow(ProtocolError);
	});

	test("open keeps headers in order with repeats, and leaves empty subprotocols out", () => {
		const open = {
			kind: "http" as const,
			method: "POST",
			path: "/a?b=1",
			headers: [
				["set-cookie", "a=1"],
				["set-cookie", "b=2"],
			] as const,
			protocols: [],
			remote: { address: "203.0.113.7" },
		};
		const bytes = encodeOpen(open);
		expect(new TextDecoder().decode(bytes)).not.toContain("protocols");
		expect(decodeOpen(bytes)).toEqual(open);
		for (const bad of [
			{ method: "CONNECT" },
			{ method: "get" },
			{ path: "relative" },
			{ path: "/#frag" },
			{ headers: [["bad name", "x"]] },
			{ headers: [["x", "a\r\nb"]] },
		]) {
			expect(() => decodeOpen(encodeJson({ ...open, ...bad }))).toThrow(ProtocolError);
		}
	});

	test("heads, closings, resets, credit and message chunks are checked", () => {
		expect(decodeHttpHead(encodeJson({ status: 204, headers: [] }))).toEqual({ status: 204, headers: [] });
		expect(() => decodeHttpHead(encodeJson({ status: 101, headers: [] }))).toThrow(ProtocolError);
		expect(decodeWebSocketHead(encodeJson({ accept: true, protocol: "graphql-ws" }))).toEqual({ accept: true, protocol: "graphql-ws" });
		expect(decodeWebSocketHead(encodeJson({ accept: false, status: 403 }))).toEqual({ accept: false, status: 403 });
		expect(() => decodeClosing(encodeJson({ code: 1005, reason: "" }))).toThrow(ProtocolError);
		expect(() => decodeClosing(encodeJson({ code: 1000, reason: "x".repeat(124) }))).toThrow(ProtocolError);
		expect(() => decodeReset(encodeJson({ code: "nope", reason: "" }))).toThrow(ProtocolError);
		expect(decodeCredit(encodeCredit(65_536))).toBe(65_536);
		expect(() => decodeCredit(new Uint8Array(4))).toThrow(ProtocolError);
		const chunk = { binary: true, more: true, bytes: Uint8Array.from([1, 2]) };
		expect(decodeMessageChunk(encodeMessageChunk(chunk))).toEqual(chunk);
		expect(() => decodeMessageChunk(Uint8Array.from([0b100]))).toThrow(ProtocolError);
	});
});

describe("headers that cross the relay", () => {
	test("leave hop-by-hop, connection-named, proxy, WebSocket handshake and forwarded headers behind", () => {
		const headers = new Headers([
			["connection", "keep-alive, x-private"],
			["keep-alive", "timeout=5"],
			["x-private", "secret"],
			["proxy-authorization", "basic"],
			["sec-websocket-key", "k"],
			["x-forwarded-for", "spoofed"],
			["host", "example"],
			["content-type", "text/plain"],
		]);
		headers.append("set-cookie", "a=1");
		headers.append("set-cookie", "b=2");
		expect(forwardableHeaders(headers)).toEqual([
			["content-type", "text/plain"],
			["set-cookie", "a=1"],
			["set-cookie", "b=2"],
		]);
	});
});

describe("the relay's API", () => {
	test("matches device paths and checks a registration against its relay", () => {
		const deviceId = newDeviceId();
		expect(matchDevicePath(`/v1/connect/${deviceId}`)).toEqual({ target: "connect", deviceId });
		expect(matchDevicePath(`/v1/devices/${deviceId}`)).toEqual({ target: "devices", deviceId });
		expect(matchDevicePath("/v1/agent/x")).toBeUndefined();
		const relay = parseRelayOrigin("https://octoiitunnel.com");
		const registration = { deviceId, credential: newCredential(), address: deviceAddress(relay, deviceId) };
		expect(decodeRegistration(registration, relay)).toEqual(registration);
		expect(() => decodeRegistration({ ...registration, address: "https://evil.example" }, relay)).toThrow(ProtocolError);
	});
});
