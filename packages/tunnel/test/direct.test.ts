import { afterEach, describe, expect, it } from "bun:test";
import { createSecureEndpoint, MemoryPairingStore, openSecureChannel, pairWith } from "../src/index.ts";
import { serveDirect } from "../src/bun/index.ts";
import { webPlatform } from "../src/web.ts";

/** What each test stops when it ends. */
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("a direct listener", () => {
	it("pairs a visitor at the address the device offers it, and opens its channels there, with no relay at all", async () => {
		const handler = async (request: Request): Promise<Response> => new Response(`${request.method} ${new URL(request.url).pathname}`);
		const secure = createSecureEndpoint({ address: "https://device.relay.invalid", store: new MemoryPairingStore(), handler, platform: webPlatform });
		const direct = serveDirect({ endpoint: secure, hostname: "127.0.0.1", port: 0 });
		cleanups.push(() => direct.close());
		const at = `http://127.0.0.1:${direct.port}`;
		const visitorStore = new MemoryPairingStore();
		const pairing = await pairWith((await secure.offerPairing(at)).url, { store: visitorStore, platform: webPlatform });
		expect(pairing.address).toBe(at);
		const channel = await openSecureChannel(pairing, { store: visitorStore, platform: webPlatform });
		cleanups.push(() => channel.close());
		expect(await (await channel.fetch("/home")).text()).toBe("GET /home");
	});
});
