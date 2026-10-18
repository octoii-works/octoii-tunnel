import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectDevice, registerDevice } from "@octoii/tunnel";
import { serveRelay } from "../src/bun/index.ts";
import { cleanups, freePort, relaySuite, type Running, TOKEN, visit } from "./suite.ts";

/** A relay in this Bun process. */
function startRelay(database = ":memory:", port = freePort()): Running {
	const origin = `http://localhost:${port}`;
	const relay = serveRelay({ origin, registrationToken: TOKEN, database, port });
	cleanups.push(() => relay.close().catch(() => undefined));
	return { origin, port, close: () => relay.close() };
}

relaySuite("the relay on Bun", async () => startRelay());

test("reconnect after the relay restarts, and keep their device across restarts with a database file", async () => {
	const database = join(mkdtempSync(join(tmpdir(), "octoiitunnel-")), "relay.sqlite");
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
