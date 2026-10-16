import { describe, expect, test } from "bun:test";
import {
	encodeUtf8,
	IncomingBody,
	MAX_MESSAGE_SIZE,
	MessageAssembler,
	ProtocolError,
	ReceiveCredit,
	SendCredit,
	sendBody,
	splitMessage,
} from "../src/index.ts";

describe("send credit", () => {
	test("waits for a grant, takes no more than it has, and refuses grants past the initial credit", async () => {
		const credit = new SendCredit(4);
		expect(await credit.take(10)).toBe(4);
		const waiting = credit.take(10);
		credit.grant(3);
		expect(await waiting).toBe(3);
		credit.grant(4);
		expect(() => credit.grant(1)).toThrow(ProtocolError);
	});

	test("rejects a waiting take once the stream fails", async () => {
		const credit = new SendCredit(1);
		await credit.take(1);
		const waiting = credit.take(1);
		credit.fail(new Error("gone"));
		await expect(waiting).rejects.toThrow("gone");
	});
});

describe("receive credit", () => {
	test("refuses data past the credit and grants in batches of at least half", () => {
		const credit = new ReceiveCredit(10);
		credit.receive(10);
		expect(() => credit.receive(1)).toThrow(ProtocolError);
		expect(credit.release(4)).toBe(0);
		expect(credit.release(1)).toBe(5);
		credit.receive(5);
	});
});

describe("incoming bodies", () => {
	test("grant credit only as the consumer reads, and end after the queued bytes", async () => {
		const grants: number[] = [];
		let finished = false;
		const body = new IncomingBody(8, { credit: (amount) => grants.push(amount), cancel: () => undefined, finish: () => (finished = true) });
		body.push(Uint8Array.from([1, 2, 3, 4]));
		body.push(Uint8Array.from([5, 6, 7, 8]));
		expect(() => body.push(Uint8Array.from([9]))).toThrow(ProtocolError);
		expect(grants).toEqual([]);
		body.end();
		expect(new Uint8Array(await new Response(body.stream).arrayBuffer())).toEqual(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
		expect(grants).toEqual([4, 4]);
		expect(finished).toBe(true);
	});

	test("tell the stream when the consumer cancels", async () => {
		let cancelled = false;
		const body = new IncomingBody(8, { credit: () => undefined, cancel: () => (cancelled = true), finish: () => undefined });
		await body.stream.cancel();
		expect(cancelled).toBe(true);
	});
});

describe("sending a body", () => {
	test("splits it by frame size within the credit", async () => {
		const credit = new SendCredit(6);
		const sent: number[] = [];
		const body = new Response(new Uint8Array(10)).body;
		if (body === null) throw new Error("No body");
		const done = sendBody(body, credit, 4, (bytes) => sent.push(bytes.length), new AbortController().signal);
		await Bun.sleep(1);
		expect(sent).toEqual([4, 2]);
		credit.grant(6);
		await done;
		expect(sent).toEqual([4, 2, 4]);
	});
});

describe("messages", () => {
	test("split by chunk size and come back whole, text and binary", () => {
		const assembler = new MessageAssembler();
		const text = "🐙".repeat(1000);
		const chunks = splitMessage({ binary: false, text }, 100);
		expect(chunks.length).toBe(Math.ceil(encodeUtf8(text).length / 100));
		const results = chunks.map((chunk) => assembler.add(chunk));
		expect(results.at(-1)).toEqual({ binary: false, text });
		expect(results.slice(0, -1).every((result) => result === undefined)).toBe(true);
		expect(assembler.add(splitMessage({ binary: true, bytes: new Uint8Array(0) }, 100)[0] ?? { binary: true, more: false, bytes: new Uint8Array(0) })).toEqual({
			binary: true,
			bytes: new Uint8Array(0),
		});
	});

	test("refuse a message that changes type or grows too large", () => {
		const assembler = new MessageAssembler();
		assembler.add({ binary: true, more: true, bytes: new Uint8Array(1) });
		expect(() => assembler.add({ binary: false, more: false, bytes: new Uint8Array(1) })).toThrow(ProtocolError);
		const large = new MessageAssembler();
		large.add({ binary: true, more: true, bytes: new Uint8Array(MAX_MESSAGE_SIZE) });
		expect(() => large.add({ binary: true, more: false, bytes: new Uint8Array(1) })).toThrow(ProtocolError);
	});
});
