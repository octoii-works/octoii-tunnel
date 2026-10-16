#!/usr/bin/env bun
import { serveRelay } from "../packages/relay/src/bun/index.ts";

const token = process.env["REGISTRATION_TOKEN"];
if (!token) throw new Error("Set REGISTRATION_TOKEN before starting the relay");
const port = Number(process.env["PORT"] ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
const relay = serveRelay({
	origin: process.env["RELAY_ORIGIN"] ?? `http://localhost:${port}`,
	registrationToken: token,
	database: process.env["DATABASE"] ?? ":memory:",
	hostname: process.env["HOST"] ?? "127.0.0.1",
	port,
});
console.log(`Relay listening on ${relay.server.url.origin}`);
if (process.env["DATABASE"] === undefined) console.log("Device records are in memory; set DATABASE to a SQLite file to keep them.");
let stopping = false;
const stop = () => {
	if (stopping) return;
	stopping = true;
	void relay.close().then(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
