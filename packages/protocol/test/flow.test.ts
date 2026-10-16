import { describe, expect, test } from "bun:test";
import {
	encodeUtf8,
	IncomingBody,
	MAX_MESSAGE_SIZE,
	MessageAssembler,
	MessageSender,
	ProtocolError,
	ReceiveCredit,
	SendCredit,
	sendBody,
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
	test("are sent in chunks that fit a frame with their flags byte, and come back whole", async () => {
		const credit = new SendCredit(1 << 20);
		const assembler = new MessageAssembler();
		const results: unknown[] = [];
		const sizes: number[] = [];
		const sender = new MessageSender(
			credit,
			100,
			(chunk) => {
				sizes.push(chunk.bytes.length);
				results.push(assembler.add(chunk));
			},
			() => undefined,
		);
		const text = "🐙".repeat(100);
		sender.enqueue({ binary: false, text });
		sender.enqueue({ binary: true, bytes: new Uint8Array(0) });
		await Bun.sleep(1);
		expect(sizes).toEqual([99, 99, 99, 99, 4, 0]);
		expect(results.filter((result) => result !== undefined)).toEqual([
			{ binary: false, text },
			{ binary: true, bytes: new Uint8Array(0) },
		]);
		expect(encodeUtf8(text).length).toBe(400);
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
