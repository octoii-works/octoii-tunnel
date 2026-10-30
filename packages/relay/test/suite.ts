/** One behavioral suite of the relay, run against every host. */
import { afterEach, describe, expect, test } from "bun:test";
import {
	type Connector,
	connectDevice,
	createSecureEndpoint,
	type Device,
	type Handler,
	MemoryPairingStore,
	openSecureChannel,
	pairWith,
	type Platform,
	registerDevice,
	removeDevice,
	type SecureChannel,
} from "@octoii-works/tunnel";
import { serveDirect } from "@octoii-works/tunnel/bun";
import { webPlatform } from "@octoii-works/tunnel/web";

/** The registration token every test relay uses. */
export const TOKEN = "registration-token-for-tests";

/** A relay under test: its origin, the loopback port it listens on, and how to stop it. */
export type Running = { readonly origin: string; readonly port: number; close(): Promise<void> };

/** What each test stops when it ends, last started first. */
export const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A free loopback port. */
export function freePort(): number {
	const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
	const port = probe.port;
	void probe.stop(true);
	if (port === undefined) throw new Error("No port");
	return port;
}

/** A connector for the device, stopped when the test ends. */
export async function startConnector(relay: Running, device: Device, handler: Handler): Promise<Connector> {
	const connector = connectDevice({ relay: relay.origin, device, handler, platform: webPlatform });
	cleanups.push(() => connector.close());
	await connector.ready;
	return connector;
}

/** A visitor's request to the device, sent to the relay with the device's host. */
export function visit(relay: Running, device: Device, path: string, init: RequestInit = {}): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("host", `${device.deviceId}.localhost:${relay.port}`);
	return fetch(`http://127.0.0.1:${relay.port}${path}`, { ...init, headers });
}

/** A visitor's WebSocket to the device, through the relay with the device's host. */
export function openVisitorSocket(relay: Running, device: Device, path: string, protocols: string[] = []): Promise<WebSocket> {
	const socket = new WebSocket(`ws://127.0.0.1:${relay.port}${path}`, {
		headers: { host: `${device.deviceId}.localhost:${relay.port}`, ...(protocols.length === 0 ? {} : { "sec-websocket-protocol": protocols.join(", ") }) },
	});
	socket.binaryType = "arraybuffer";
	cleanups.push(() => socket.close());
	return new Promise((resolve, reject) => {
		socket.addEventListener("open", () => resolve(socket), { once: true });
		socket.addEventListener("error", () => reject(new Error("The WebSocket failed")), { once: true });
	});
}

/** The next message a WebSocket receives. */
export function nextMessage(socket: WebSocket): Promise<string | Uint8Array> {
	return new Promise((resolve) =>
		socket.addEventListener("message", (event) => resolve(typeof event.data === "string" ? event.data : new Uint8Array(event.data)), { once: true }),
	);
}

/** The code a WebSocket closes with. */
export function nextClose(socket: WebSocket): Promise<number> {
	return new Promise((resolve) => socket.addEventListener("close", (event) => resolve(event.code), { once: true }));
}

/** How far a test platform's clock runs ahead of the web standards' own. */
const CLOCK_SHIFT = 1_000_000_000;

/** The web standards' platform with its clock `CLOCK_SHIFT` ahead, counting the timers set and the randomness drawn. */
function countingPlatform(): { readonly platform: Platform; readonly used: { timers: number; randomBytes: number } } {
	const used = { timers: 0, randomBytes: 0 };
	const platform: Platform = {
		clock: {
			now: () => webPlatform.clock.now() + CLOCK_SHIFT,
			setTimer: (callback, delayMs) => {
				used.timers++;
				return webPlatform.clock.setTimer(callback, delayMs);
			},
		},
		randomBytes: (length) => {
			used.randomBytes++;
			return webPlatform.randomBytes(length);
		},
	};
	return { platform, used };
}

/** The relay's behavior, on the relays that `start` starts. */
export function relaySuite(host: string, start: () => Promise<Running>): void {
	describe(host, () => {
		describe("the relay over HTTP", () => {
			test("registers devices only with the token, and tells unknown devices from offline ones", async () => {
				const relay = await start();
				await expect(registerDevice({ relay: relay.origin, token: "wrong" })).rejects.toThrow("401");
				const device = await registerDevice({ relay: relay.origin, token: TOKEN, name: "laptop" });
				expect(device.address).toBe(`http://${device.deviceId}.localhost:${relay.port}`);
				expect((await visit(relay, device, "/")).status).toBe(502);
				expect((await visit(relay, { ...device, deviceId: "a".repeat(26) }, "/")).status).toBe(404);
			});

			test("forwards the method, path, query and headers, and streams the response", async () => {
				const relay = await start();
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
				const relay = await start();
				const device = await registerDevice({ relay: relay.origin, token: TOKEN });
				await startConnector(relay, device, async (request) => new Response(await request.arrayBuffer()));
				const bytes = crypto.getRandomValues(new Uint8Array(3 * 1024 * 1024 + 7));
				const response = await visit(relay, device, "/echo", { method: "POST", body: bytes });
				expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
			});

			test("keeps an early response while it stops an unread upload", async () => {
				const relay = await start();
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
				const relay = await start();
				const device = await registerDevice({ relay: relay.origin, token: TOKEN });
				let aborted = false;
				await startConnector(relay, device, (request) => {
					request.signal.addEventListener("abort", () => (aborted = true));
					const stream = new ReadableStream({
						// A relay may notice a visitor is gone only when it next writes to it, so the handler keeps writing.
						pull: async (controller) => {
							await Bun.sleep(10);
							controller.enqueue(new Uint8Array([1]));
						},
					});
					return new Response(stream);
				});
				const controller = new AbortController();
				const response = await visit(relay, device, "/stream", { signal: controller.signal, headers: { "accept-encoding": "identity" } });
				expect(response.status).toBe(200);
				const reader = response.body?.getReader();
				await reader?.read();
				controller.abort();
				await reader?.cancel().catch(() => undefined);
				await Bun.sleep(100);
				expect(aborted).toBe(true);
			});

			test("keeps HEAD bodiless and repeated cookies apart", async () => {
				const relay = await start();
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
				const relay = await start();
				const device = await registerDevice({ relay: relay.origin, token: TOKEN });
				let reached = false;
				await startConnector(relay, device, () => {
					reached = true;
					return new Response("plain");
				});
				expect((await visit(relay, device, "/.octoiitunnel/secure")).status).toBe(501);
				expect(reached).toBe(false);
			});
		});

		describe("connectors", () => {
			test("a wrong credential cannot replace a working connector, and a right one can", async () => {
				const relay = await start();
				const device = await registerDevice({ relay: relay.origin, token: TOKEN });
				const first = await startConnector(relay, device, () => new Response("first"));
				const wrong = connectDevice({
					relay: relay.origin,
					device: { ...device, credential: "A".repeat(43) },
					handler: () => new Response("wrong"),
					platform: webPlatform,
				});
				cleanups.push(() => wrong.close());
				await expect(wrong.ready).rejects.toThrow();
				expect(await (await visit(relay, device, "/")).text()).toBe("first");
				await startConnector(relay, device, () => new Response("second"));
				await first.closed;
				expect(await (await visit(relay, device, "/")).text()).toBe("second");
			});

			test("are disconnected for good when their device is removed", async () => {
				const relay = await start();
				const device = await registerDevice({ relay: relay.origin, token: TOKEN });
				const connector = await startConnector(relay, device, () => new Response("here"));
				await removeDevice({ relay: relay.origin, device });
				await connector.closed;
				expect((await visit(relay, device, "/")).status).toBe(404);
			});
		});

		describe("visitor WebSockets", () => {
			test("echo text and binary messages, larger than a frame, on the subprotocol the service chose", async () => {
				const relay = await start();
				const device = await registerDevice({ relay: relay.origin, token: TOKEN });
				const connector = connectDevice({
					relay: relay.origin,
					device,
					platform: webPlatform,
					handler: () => new Response("plain"),
					websocket: (_request, accept) => {
						const socket = accept("chat.v2");
						socket.onmessage = (message) => socket.send(message);
					},
				});
				cleanups.push(() => connector.close());
				await connector.ready;
				const visitor = await openVisitorSocket(relay, device, "/live", ["chat.v1", "chat.v2"]);
				expect(visitor.protocol).toBe("chat.v2");
				visitor.send("hello 🐙");
				expect(await nextMessage(visitor)).toBe("hello 🐙");
				const bytes = crypto.getRandomValues(new Uint8Array(300_000));
				visitor.send(bytes);
				expect(await nextMessage(visitor)).toEqual(bytes);
			});

			test("are refused with the status the service gives", async () => {
				const relay = await start();
				const device = await registerDevice({ relay: relay.origin, token: TOKEN });
				await startConnector(relay, device, () => new Response("plain"));
				const response = await visit(relay, device, "/live", {
					headers: { upgrade: "websocket", connection: "Upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" },
				});
				expect(response.status).toBe(501);
			});

			test("pass close codes both ways, and close with 1011 when the connector goes away", async () => {
				const relay = await start();
				const device = await registerDevice({ relay: relay.origin, token: TOKEN });
				const closes: number[] = [];
				const connector = connectDevice({
					relay: relay.origin,
					device,
					platform: webPlatform,
					handler: () => new Response("plain"),
					websocket: (_request, accept) => {
						const socket = accept();
						socket.onclose = (code) => closes.push(code);
						socket.onmessage = (message) => {
							if (message === "bye") socket.close(4100, "service says bye");
						};
					},
				});
				cleanups.push(() => connector.close());
				await connector.ready;
				const first = await openVisitorSocket(relay, device, "/a");
				first.send("bye");
				expect(await nextClose(first)).toBe(4100);
				const second = await openVisitorSocket(relay, device, "/b");
				second.close(4200, "visitor says bye");
				for (let attempt = 0; attempt < 50 && closes.length < 2; attempt++) await Bun.sleep(10);
				expect(closes).toEqual([4100, 4200]);
				const third = await openVisitorSocket(relay, device, "/c");
				const closed = nextClose(third);
				connector.close();
				expect(await closed).toBe(1011);
			});
		});

		describe("secure channels", () => {
			/** A device whose connector answers plain and secure requests alike, and echoes messages on secure channels. */
			async function secureDevice(relay: Running, store = new MemoryPairingStore(), device?: Device) {
				const registered = device ?? (await registerDevice({ relay: relay.origin, token: TOKEN }));
				const channels: SecureChannel[] = [];
				const handler = async (request: Request): Promise<Response> =>
					new Response(`${request.method} ${new URL(request.url).pathname} ${await request.text()}`);
				const secure = createSecureEndpoint({ address: registered.address, store, handler, platform: webPlatform });
				const connector = connectDevice({ relay: relay.origin, device: registered, secure, platform: webPlatform, handler });
				secure.onSecureChannel((channel) => {
					channels.push(channel);
					channel.onmessage = (message) => channel.send(message);
				});
				cleanups.push(() => connector.close());
				await connector.ready;
				return { device: registered, connector, secure, channels, store };
			}

			test("pair from an offer, then talk and fetch over a channel the relay cannot read", async () => {
				const relay = await start();
				const { secure, channels } = await secureDevice(relay);
				const visitorStore = new MemoryPairingStore();
				const pairing = await pairWith((await secure.offerPairing()).url, { store: visitorStore, name: "phone", platform: webPlatform });
				const channel = await openSecureChannel(pairing, { store: visitorStore, platform: webPlatform });
				cleanups.push(() => channel.close());
				const reply = new Promise((resolve) => (channel.onmessage = resolve));
				channel.send("hello over noise 🐙");
				expect(await reply).toBe("hello over noise 🐙");
				const large = crypto.getRandomValues(new Uint8Array(200_000));
				const echoed = new Promise((resolve) => (channel.onmessage = resolve));
				channel.send(large);
				expect(await echoed).toEqual(large);
				const response = await channel.fetch("/notes", { method: "POST", body: "secret" });
				expect(await response.text()).toBe("POST /notes secret");
				expect(channels.at(-1)?.visitor.name).toBe("phone");
			});

			test("reopen after the connector restarts with the same store", async () => {
				const relay = await start();
				const first = await secureDevice(relay);
				const visitorStore = new MemoryPairingStore();
				const pairing = await pairWith((await first.secure.offerPairing()).url, { store: visitorStore, platform: webPlatform });
				first.connector.close();
				await first.connector.closed;
				await secureDevice(relay, first.store, first.device);
				const channel = await openSecureChannel(pairing, { store: visitorStore, platform: webPlatform });
				cleanups.push(() => channel.close());
				expect(await (await channel.fetch("/again")).text()).toBe("GET /again ");
			});

			test("list the visitors paired, and close a forgotten one's channels and refuse its next", async () => {
				const relay = await start();
				const { secure } = await secureDevice(relay);
				const phoneStore = new MemoryPairingStore();
				const phone = await pairWith((await secure.offerPairing()).url, { store: phoneStore, name: "phone", platform: webPlatform });
				await pairWith((await secure.offerPairing()).url, { store: new MemoryPairingStore(), name: "laptop", platform: webPlatform });
				const visitors = await secure.visitors();
				expect(visitors.map((visitor) => visitor.name)).toEqual(["phone", "laptop"]);
				const channel = await openSecureChannel(phone, { store: phoneStore, platform: webPlatform });
				const closed = new Promise<number>((resolve) => (channel.onclose = resolve));
				await secure.forgetVisitor(visitors[0]?.publicKey ?? "");
				expect(await closed).toBe(4401);
				expect((await secure.visitors()).map((visitor) => visitor.name)).toEqual(["laptop"]);
				await expect(openSecureChannel(phone, { store: phoneStore, platform: webPlatform })).rejects.toThrow();
			});

			test("run the connector and the visitor on the platform each is given, bodies larger than a channel frame included", async () => {
				const relay = await start();
				const device = await registerDevice({ relay: relay.origin, token: TOKEN });
				const onDevice = countingPlatform();
				const onVisitor = countingPlatform();
				const handler = async (request: Request): Promise<Response> => new Response(await request.text());
				const secure = createSecureEndpoint({ address: device.address, store: new MemoryPairingStore(), handler, platform: onDevice.platform });
				const connector = connectDevice({ relay: relay.origin, device, secure, platform: onDevice.platform, handler });
				cleanups.push(() => connector.close());
				await connector.ready;
				const before = Date.now() + CLOCK_SHIFT;
				const offer = await secure.offerPairing();
				expect(offer.expiresAt).toBeGreaterThanOrEqual(before + 5 * 60_000);
				const visitorStore = new MemoryPairingStore();
				const pairing = await pairWith(offer.url, { store: visitorStore, platform: onVisitor.platform });
				expect((await secure.visitors())[0]?.pairedAt).toBeGreaterThanOrEqual(before);
				const channel = await openSecureChannel(pairing, { store: visitorStore, platform: onVisitor.platform });
				cleanups.push(() => channel.close());
				const body = "octoiitunnel ".repeat(20_000);
				expect(await (await channel.fetch("/echo", { method: "POST", body })).text()).toBe(body);
				for (const { used } of [onDevice, onVisitor]) {
					expect(used.timers).toBeGreaterThan(0);
					expect(used.randomBytes).toBeGreaterThan(0);
				}
			});

			test("open a channel directly at an address the device gave, and refuse a stranger and every other path there", async () => {
				const relay = await start();
				const { secure } = await secureDevice(relay);
				const direct = serveDirect({ endpoint: secure, hostname: "127.0.0.1", port: 0 });
				cleanups.push(() => void direct.close());
				const visitorStore = new MemoryPairingStore();
				const pairing = await pairWith((await secure.offerPairing()).url, { store: visitorStore, platform: webPlatform });
				const via = `http://127.0.0.1:${direct.port}`;
				const channel = await openSecureChannel(pairing, { store: visitorStore, platform: webPlatform, via });
				cleanups.push(() => channel.close());
				expect(await (await channel.fetch("/near")).text()).toBe("GET /near ");
				await expect(openSecureChannel(pairing, { store: new MemoryPairingStore(), platform: webPlatform, via })).rejects.toThrow();
				expect((await fetch(`${via}/anything`)).status).toBe(404);
			});

			test("refuse a visitor that never paired, and a pairing code used twice", async () => {
				const relay = await start();
				const { secure } = await secureDevice(relay);
				const offer = await secure.offerPairing();
				const pairing = await pairWith(offer.url, { store: new MemoryPairingStore(), platform: webPlatform });
				await expect(openSecureChannel(pairing, { store: new MemoryPairingStore(), platform: webPlatform })).rejects.toThrow();
				await expect(pairWith(offer.url, { store: new MemoryPairingStore(), platform: webPlatform })).rejects.toThrow();
			});
		});
	});
}
