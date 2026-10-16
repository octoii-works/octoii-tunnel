import { expect, test } from "bun:test";
import { credentialHash, decodeFrame, encodeFrame, jsonBytes, randomCredential, randomDeviceId, types, type Frame } from "@klein-works/takotunnel/protocol";
import { createMemoryDeviceStore, DeviceSession, type Decision, type DeviceStore, type RelayOptions } from "../src/index.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function fixture(options: Partial<RelayOptions> = {}, store: DeviceStore = createMemoryDeviceStore()) {
	const id = randomDeviceId();
	const credential = randomCredential();
	const origin = "https://relay.example.com";
	await store.create({ id, credentialHash: credentialHash(credential), name: "" });
	let now = 1000;
	let timer: { deadline: number; callback: () => void } | undefined;
	const session = new DeviceSession(
		id,
		{
			store,
			scheduler: {
				now: () => now,
				schedule(deadline, callback) {
					timer = { deadline, callback };
					return () => {
						timer = undefined;
					};
				},
			},
		},
		{ origin, registrationToken: randomCredential(), ...options },
	);
	const context = {
		address: "127.0.0.1",
		upgrade: () => {
			throw new Error("Unexpected upgrade");
		},
	};
	function agent() {
		const frames: Frame[] = [];
		const closes: number[] = [];
		const connection = session.accept({
			send: (bytes) => {
				frames.push(decodeFrame(bytes));
			},
			close: (code) => {
				closes.push(code);
			},
		});
		return { frames, closes, connection, hello: () => connection.message(encodeFrame(types.hello, 0, jsonBytes({ version: 1, credential, agent: "test" }))) };
	}
	return {
		session,
		store,
		agent,
		id,
		visit: (init?: RequestInit) => session.fetch(new Request(`https://${id}.relay.example.com/`, init), context),
		remove: () => session.fetch(new Request(`${origin}/v1/devices/${id}`, { method: "DELETE", headers: { authorization: `Bearer ${credential}` } }), context),
		advance(milliseconds: number) {
			now += milliseconds;
			if (timer && timer.deadline <= now) {
				const callback = timer.callback;
				timer = undefined;
				callback();
			}
		},
	};
}

test("slow consumers retain their stream slot until buffered bytes are read", async () => {
	const host = await fixture({ limits: { maxStreams: 1 } });
	const agent = host.agent();
	await agent.hello();
	const incoming = host.visit();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	const open = agent.frames.find((frame) => frame.type === types.open);
	if (!open) throw new Error("No stream opened");
	await agent.connection.message(encodeFrame(types.head, open.stream, jsonBytes({ status: 200, headers: [] })));
	await agent.connection.message(encodeFrame(types.data, open.stream, new TextEncoder().encode("buffered")));
	await agent.connection.message(encodeFrame(types.end, open.stream));
	const response = await incoming;
	expect((await host.visit())?.status).toBe(503);
	expect(await response?.text()).toBe("buffered");
	const abort = new AbortController();
	const next = host.visit({ signal: abort.signal });
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	abort.abort();
	expect((await next)?.status).toBe(502);
	expect(agent.frames.filter((frame) => frame.type === types.open)).toHaveLength(2);
	expect(agent.frames.some((frame) => frame.type === types.reset)).toBe(true);
	host.session.shutdown();
});

test("response completion followed by reset preserves the body and cancels a blocked upload", async () => {
	const host = await fixture({ limits: { maxFrame: 1024, initialWindow: 1024 } });
	const agent = host.agent();
	await agent.hello();
	const cancelled = deferred<void>();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(65536));
		},
		cancel() {
			cancelled.resolve();
		},
	});
	const incoming = host.visit({ method: "POST", body });
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	const open = agent.frames.find((frame) => frame.type === types.open);
	if (!open) throw new Error("No stream opened");
	await agent.connection.message(encodeFrame(types.head, open.stream, jsonBytes({ status: 413, headers: [] })));
	await agent.connection.message(encodeFrame(types.data, open.stream, new TextEncoder().encode("refused")));
	await agent.connection.message(encodeFrame(types.end, open.stream));
	await agent.connection.message(encodeFrame(types.reset, open.stream, jsonBytes({ code: "cancelled", reason: "Upload refused" })));
	await cancelled.promise;
	const response = await incoming;
	expect(response?.status).toBe(413);
	expect(await response?.text()).toBe("refused");
	expect(agent.closes).toHaveLength(0);
	host.session.shutdown();
});

test("a delayed policy rejection leaves the authenticated agent connected", async () => {
	const decision = deferred<Decision>();
	let count = 0;
	const host = await fixture({ authorize: (event) => (event.kind === "agent" && count++ > 0 ? decision.promise : { allowed: true }) });
	const first = host.agent();
	await first.hello();
	const second = host.agent();
	const pending = second.hello();
	decision.resolve({ allowed: false, status: 403 });
	await pending;
	expect(first.closes).toHaveLength(0);
	expect(second.closes).toEqual([4001]);
	host.session.shutdown();
});

test("removal cannot be bypassed by an asynchronous authentication hook", async () => {
	const decision = deferred<Decision>();
	const entered = deferred<void>();
	const host = await fixture({
		authorize: () => {
			entered.resolve();
			return decision.promise;
		},
	});
	const agent = host.agent();
	const pending = agent.hello();
	await entered.promise;
	expect((await host.remove())?.status).toBe(204);
	decision.resolve({ allowed: true });
	await pending;
	expect(agent.frames.some((frame) => frame.type === types.welcome)).toBe(false);
	expect(await host.store.get(host.id)).toBeUndefined();
	expect(agent.closes).toEqual([4001]);
});

test("hello and heartbeat deadlines close abandoned connections", async () => {
	const host = await fixture();
	const pending = host.agent();
	host.advance(10_000);
	expect(pending.closes).toEqual([4003]);
	const active = host.agent();
	await active.hello();
	host.advance(20_000);
	expect(active.frames.at(-1)?.type).toBe(types.ping);
	host.advance(40_000);
	expect(active.closes).toEqual([1011]);
});

test("shutdown fails an in-flight visitor without deleting caller-owned records", async () => {
	const host = await fixture();
	const agent = host.agent();
	await agent.hello();
	const incoming = host.visit();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	host.session.shutdown();
	expect((await incoming)?.status).toBe(502);
	expect(agent.closes).toEqual([1012]);
	expect(await host.store.get(host.id)).toBeDefined();
});

test("a new stream schedules its own deadline before the next heartbeat", async () => {
	const host = await fixture({ limits: { streamIdle: 5 } });
	const agent = host.agent();
	await agent.hello();
	const incoming = host.visit();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	host.advance(5);
	expect((await incoming)?.status).toBe(502);
	expect(agent.frames.at(-1)?.type).toBe(types.reset);
	expect(agent.closes).toHaveLength(0);
	host.session.shutdown();
});
