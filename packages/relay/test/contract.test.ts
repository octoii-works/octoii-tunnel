import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectAgent, registerDevice, removeDevice, type AgentHandle, type Device } from "@klein-works/takotunnel";
import { randomCredential, randomDeviceId } from "@klein-works/takotunnel/protocol";
import { createMemoryDeviceStore } from "../src/index.ts";
import { serveRelay } from "../src/bun/index.ts";

interface Host {
	origin: string;
	token: string;
	close(): Promise<void>;
}
async function startHost(): Promise<Host> {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
	const port = probe.port;
	await probe.stop(true);
	if (!port) throw new Error("No free port");
	const origin = `http://localhost:${port}`;
	const token = randomCredential();
	const relay = serveRelay({ origin, registrationToken: token, store: createMemoryDeviceStore(), port });
	return { origin, token, close: () => relay.close() };
}

describe("relay HTTP contract", () => {
	let host: Host;
	const agents: AgentHandle[] = [];
	beforeAll(async () => {
		host = await startHost();
	});
	afterAll(async () => {
		for (const agent of agents) agent.close();
		await host?.close();
	});

	const register = () => registerDevice({ relay: host.origin, token: host.token });
	const visit = (device: Device, path: string, init: RequestInit = {}) => {
		const headers = new Headers(init.headers);
		headers.set("host", new URL(device.address).host);
		return fetch(host.origin + path, { ...init, headers });
	};
	function agent(device: Device, handler: (request: Request) => Response | Promise<Response>): AgentHandle {
		const connection = connectAgent({ relay: host.origin, device, handler });
		agents.push(connection);
		return connection;
	}

	test("registration requires a token and unknown and offline devices differ", async () => {
		await expect(registerDevice({ relay: host.origin, token: randomCredential() })).rejects.toThrow("401");
		const device = await register();
		expect((await visit(device, "/")).status).toBe(502);
		const unknown = { ...device, address: device.address.replace(device.deviceId, randomDeviceId()) };
		expect((await visit(unknown, "/")).status).toBe(404);
	});

	test("forwards method, path, headers and a streamed response", async () => {
		const device = await register();
		const connection = agent(device, async (request) =>
			Response.json({
				method: request.method,
				path: new URL(request.url).pathname,
				query: new URL(request.url).search,
				body: await request.text(),
				forwarded: request.headers.get("x-forwarded-for"),
				custom: request.headers.get("x-test"),
			}),
		);
		await connection.ready;
		const response = await visit(device, "/hello?x=1", { method: "POST", headers: { "x-test": "value", "x-forwarded-for": "spoof" }, body: "hello" });
		expect(response.status).toBe(200);
		const result = await response.json();
		expect(result).toMatchObject({ method: "POST", path: "/hello", query: "?x=1", body: "hello", custom: "value" });
		expect(result.forwarded).not.toBe("spoof");
	});

	test("streams more than one window in both directions", async () => {
		const device = await register();
		const connection = agent(device, (request) => new Response(request.body));
		await connection.ready;
		const bytes = new Uint8Array(1024 * 1024 + 37);
		for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
		const response = await visit(device, "/echo", { method: "POST", body: bytes });
		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
	}, 15_000);

	test("invalid credentials cannot replace a working agent", async () => {
		const device = await register();
		const good = agent(device, () => new Response("good"));
		await good.ready;
		const bad = agent({ ...device, credential: randomCredential() }, () => new Response("bad"));
		await expect(bad.ready).rejects.toThrow();
		expect(await (await visit(device, "/")).text()).toBe("good");
		const replacement = agent(device, () => new Response("replacement"));
		await replacement.ready;
		await good.closed;
		expect(await (await visit(device, "/")).text()).toBe("replacement");
	});

	test("an early response survives cancelling an unread upload", async () => {
		const device = await register();
		await agent(device, () => new Response("upload refused", { status: 413 })).ready;
		const response = await visit(device, "/", { method: "POST", body: new Uint8Array(1024 * 1024) });
		expect(response.status).toBe(413);
		expect(await response.text()).toBe("upload refused");
		expect(await (await visit(device, "/")).text()).toBe("upload refused");
	});

	test("visitor cancellation aborts the handler and releases its response producer", async () => {
		const device = await register();
		let signal: AbortSignal | undefined;
		let cancelled!: () => void;
		const producerCancelled = new Promise<void>((resolve) => {
			cancelled = resolve;
		});
		await agent(device, (request) => {
			if (new URL(request.url).pathname === "/health") return new Response("ok");
			signal = request.signal;
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array([1]));
					},
					cancel() {
						cancelled();
					},
				}),
			);
		}).ready;
		const response = await visit(device, "/stream");
		const reader = response.body?.getReader();
		expect((await reader?.read())?.value).toEqual(new Uint8Array([1]));
		await reader?.cancel();
		await producerCancelled;
		expect(signal?.aborted).toBe(true);
		expect(await (await visit(device, "/health")).text()).toBe("ok");
	});

	test("HEAD and repeated cookies preserve HTTP response semantics", async () => {
		const device = await register();
		await agent(
			device,
			() =>
				new Response("body", {
					headers: [
						["set-cookie", "a=1; Path=/"],
						["set-cookie", "b=2; Path=/"],
					],
				}),
		).ready;
		const response = await visit(device, "/", { method: "HEAD" });
		expect(await response.text()).toBe("");
		expect(response.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
	});

	test("removal validates credentials and disconnects the agent", async () => {
		const device = await register();
		const connection = agent(device, () => new Response("ok"));
		await connection.ready;
		await expect(removeDevice({ relay: host.origin, device: { ...device, credential: randomCredential() } })).rejects.toThrow("401");
		await removeDevice({ relay: host.origin, device });
		await connection.closed;
		expect((await visit(device, "/")).status).toBe(404);
	});

	test("secure path is reserved and never reaches the plain handler", async () => {
		const device = await register();
		let called = false;
		await agent(device, () => {
			called = true;
			return new Response("private");
		}).ready;
		expect((await visit(device, "/.takotunnel/secure")).status).toBe(501);
		expect(called).toBe(false);
	});
});
