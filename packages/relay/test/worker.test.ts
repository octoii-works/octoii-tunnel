import { afterAll, beforeAll } from "bun:test";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { freePort, relaySuite, type Running, TOKEN } from "../src/testing/index.ts";

/** The test entry bundled into one module, as workerd runs it. */
let script = "";

beforeAll(async () => {
	const built = await Bun.build({ entrypoints: [join(import.meta.dir, "worker-entry.ts")], target: "browser", format: "esm", minify: false });
	const [output] = built.outputs;
	if (!built.success || output === undefined) throw new Error(`The worker did not build: ${built.logs.join("\n")}`);
	script = await output.text();
});

const running: Miniflare[] = [];
afterAll(async () => {
	for (const miniflare of running) await miniflare.dispose();
});

/** How many ports a start tries: the port is free when chosen, and another test may take it before workerd binds it. */
const PORT_ATTEMPTS = 5;

/** A relay on a local workerd: the Worker and its Durable Objects, listening on a loopback port. */
async function startRelay(): Promise<Running> {
	for (let attempt = 1; ; attempt++) {
		const port = freePort();
		const origin = `http://localhost:${port}`;
		const miniflare = new Miniflare({
			modules: true,
			script,
			compatibilityDate: "2026-07-01",
			compatibilityFlags: ["enable_request_signal"],
			durableObjects: { DEVICES: "DeviceObject" },
			bindings: { RELAY_ORIGIN: origin, REGISTRATION_TOKEN: TOKEN },
			host: "127.0.0.1",
			port,
		});
		try {
			await miniflare.ready;
		} catch (error) {
			await miniflare.dispose();
			if (attempt < PORT_ATTEMPTS && isAddressInUse(error)) continue;
			throw error;
		}
		running.push(miniflare);
		return { origin, port, close: () => miniflare.dispose() };
	}
}

/** Whether workerd could not listen because the port was taken. */
function isAddressInUse(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ERR_ADDRESS_IN_USE";
}

relaySuite("the relay on Durable Objects", startRelay);
