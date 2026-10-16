import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Connector, connectDevice, type Device, type Handler, registerDevice, removeDevice } from "@klein-works/takotunnel";
import { serveRelay } from "../src/bun/index.ts";

const TOKEN = "registration-token-for-tests";

type Running = { readonly origin: string; readonly port: number; close(): Promise<void> };
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A free loopback port. */
function freePort(): number {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
	const port = probe.port;
	void probe.stop(true);
	if (port === undefined) throw new Error("No port");
	return port;
}

function startRelay(database = ":memory:", port = freePort()): Running {
	const origin = `http://localhost:${port}`;
	const relay = serveRelay({ origin, registrationToken: TOKEN, database, port });
	const running = { origin, port, close: () => relay.close() };
	cleanups.push(() => relay.close().catch(() => undefined));
	return running;
}

async function startConnector(relay: Running, device: Device, handler: Handler): Promise<Connector> {
	const connector = connectDevice({ relay: relay.origin, device, handler });
	cleanups.push(() => connector.close());
	await connector.ready;
	return connector;
}

/** A visitor's request to the device, sent to the relay with the device's host. */
function visit(relay: Running, device: Device, path: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("host", `${device.deviceId}.localhost:${relay.port}`);
	return fetch(`http://127.0.0.1:${relay.port}${path}`, { ...init, headers });
}

describe("the relay over HTTP", () => {
	test("registers devices only with the token, and tells unknown devices from offline ones", async () => {
		const relay = startRelay();
		await expect(registerDevice({ relay: relay.origin, token: "wrong" })).rejects.toThrow("401");
		const device = await registerDevice({ relay: relay.origin, token: TOKEN, name: "laptop" });
		expect(device.address).toBe(`http://${device.deviceId}.localhost:${relay.port}`);
		expect((await visit(relay, device, "/")).status).toBe(502);
		expect((await visit(relay, { ...device, deviceId: "a".repeat(26) }, "/")).status).toBe(404);
	});

	test("forwards the method, path, query and headers, and streams the response", async () => {
		const relay = startRelay();
		const device = await registerDevice({ relay: relay.origin, token: TOKEN });
		await startConnector(relay, device, async (request) => {
			const url = new URL(request.url);
			const body = await request.text();
			return Response.json({
				method: request.method,
				path: url.pathname + url.search,
				header: request.headers.get("x-test"),
				forwardedFor: request.headers.get("x-forwarded-for"),
				body,
			});
		});
		const response = await visit(relay, device, "/hello?x=1", { method: "POST", headers: { "x-test": "value", "x-forwarded-for": "spoofed" }, body: "hi" });
		expect(await response.json()).toEqual({ method: "POST", path: "/hello?x=1", header: "value", forwardedFor: "127.0.0.1", body: "hi" });
	});

	test("streams bodies larger than the credit both ways", async () => {
		const relay = startRelay();
		const device = await registerDevice({ relay: relay.origin, token: TOKEN });
		await startConnector(relay, device, async (request) => new Response(await request.arrayBuffer()));
		const bytes = crypto.getRandomValues(new Uint8Array(3 * 1024 * 1024 + 7));
		const response = await visit(relay, device, "/echo", { method: "POST", body: bytes });
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
	});

	test("keeps an early response while it stops an unread upload", async () => {
		const relay = startRelay();
		const device = await registerDevice({ relay: relay.origin, token: TOKEN });
		await startConnector(
			relay,
			device,
			(request) => new Response(request.method === "POST" ? "refused" : "fine", { status: request.method === "POST" ? 413 : 200 }),
		);
		const response = await visit(relay, device, "/", { method: "POST", body: new Uint8Array(2 * 1024 * 1024) });
		expect([response.status, await response.text()]).toEqual([413, "refused"]);
		expect(await (await visit(relay, device, "/")).text()).toBe("fine");
	});

	test("aborts the handler when the visitor goes away", async () => {
		const relay = startRelay();
		const device = await registerDevice({ relay: relay.origin, token: TOKEN });
		let aborted = false;
		await startConnector(relay, device, (request) => {
			request.signal.addEventListener("abort", () => (aborted = true));
			const stream = new ReadableStream({ start: (controller) => controller.enqueue(new Uint8Array([1])), pull: () => Bun.sleep(10) });
			return new Response(stream);
		});
		const controller = new AbortController();
		const response = await visit(relay, device, "/stream", { signal: controller.signal });
		expect(response.status).toBe(200);
		const reader = response.body?.getReader();
		await reader?.read();
		controller.abort();
		await reader?.cancel().catch(() => undefined);
		await Bun.sleep(100);
		expect(aborted).toBe(true);
	});

	test("keeps HEAD bodiless and repeated cookies apart", async () => {
		const relay = startRelay();
		const device = await registerDevice({ relay: relay.origin, token: TOKEN });
		await startConnector(relay, device, () => {
			const headers = new Headers({ "content-type": "text/plain" });
			headers.append("set-cookie", "a=1");
			headers.append("set-cookie", "b=2");
			return new Response("body", { headers });
		});
		const head = await visit(relay, device, "/", { method: "HEAD" });
		expect([head.status, await head.text()]).toEqual([200, ""]);
		expect((await visit(relay, device, "/")).headers.getSetCookie()).toEqual(["a=1", "b=2"]);
	});

	test("keeps the secure path from the handler", async () => {
		const relay = startRelay();
		const device = await registerDevice({ relay: relay.origin, token: TOKEN });
		let reached = false;
		await startConnector(relay, device, () => {
			reached = true;
			return new Response("plain");
		});
		expect((await visit(relay, device, "/.takotunnel/secure")).status).toBe(501);
		expect(reached).toBe(false);
	});
});

describe("connectors", () => {
	test("a wrong credential cannot replace a working connector, and a right one can", async () => {
		const relay = startRelay();
		const device = await registerDevice({ relay: relay.origin, token: TOKEN });
		const first = await startConnector(relay, device, () => new Response("first"));
		const wrong = connectDevice({ relay: relay.origin, device: { ...device, credential: "A".repeat(43) }, handler: () => new Response("wrong") });
		cleanups.push(() => wrong.close());
		await expect(wrong.ready).rejects.toThrow();
		expect(await (await visit(relay, device, "/")).text()).toBe("first");
		await startConnector(relay, device, () => new Response("second"));
		await first.closed;
		expect(await (await visit(relay, device, "/")).text()).toBe("second");
	});

	test("reconnect after the relay restarts, and keep their device across restarts with a database file", async () => {
		const database = join(mkdtempSync(join(tmpdir(), "takotunnel-")), "relay.sqlite");
		const relay = startRelay(database);
		const device = await registerDevice({ relay: relay.origin, token: TOKEN });
		const connector = connectDevice({ relay: relay.origin, device, handler: () => new Response("back") });
		cleanups.push(() => connector.close());
		await connector.ready;
		await relay.close();
		const restarted = startRelay(database, relay.port);
		for (let attempt = 0; attempt < 50; attempt++) {
			const response = await visit(restarted, device, "/");
			if (response.status === 200) {
				expect(await response.text()).toBe("back");
				return;
			}
			await Bun.sleep(100);
		}
		throw new Error("The connector did not come back");
	});

	test("are disconnected for good when their device is removed", async () => {
		const relay = startRelay();
		const device = await registerDevice({ relay: relay.origin, token: TOKEN });
		const connector = await startConnector(relay, device, () => new Response("here"));
		await removeDevice({ relay: relay.origin, device });
		await connector.closed;
		expect((await visit(relay, device, "/")).status).toBe(404);
	});
});
