#!/usr/bin/env bun
import { createMemoryDeviceStore } from "../packages/relay/src/index.ts";
import { serveRelay } from "../packages/relay/src/bun/index.ts";

const token = process.env.REGISTRATION_TOKEN;
if (!token) throw new Error("Set REGISTRATION_TOKEN before starting the relay");
const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
const relay = serveRelay({
	origin: process.env.RELAY_ORIGIN ?? `http://localhost:${port}`,
	registrationToken: token,
	store: createMemoryDeviceStore(),
	hostname: process.env.HOST ?? "127.0.0.1",
	port,
});
console.log(`Relay listening on ${relay.server.url.origin}`);
console.log("Development storage is in memory; registrations end with this process.");
let stopping = false;
const stop = () => {
	if (stopping) return;
	stopping = true;
	void relay.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
