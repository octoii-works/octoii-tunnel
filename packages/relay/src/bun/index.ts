/**
 * The relay in one Bun process: sessions in memory, device records in SQLite, sockets from `Bun.serve`. For
 * development, tests, and a relay on a single machine.
 */
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { MAX_MESSAGE_SIZE } from "@klein-works/takotunnel-protocol";
import { errorResponse } from "../hooks.ts";
import type { Clock, RelayHost, RelayOptions, SessionSocket, SocketAttachment } from "../host.ts";
import { createRelay } from "../router.ts";
import { DeviceSession } from "../session.ts";
import { SqliteDevices } from "./devices.ts";

/** How a Bun relay is configured. */
export type BunRelayOptions = RelayOptions & {
	/** The SQLite file for device records, or `":memory:"` to keep them only while the process runs. */
	readonly database: string;
};

/** What Bun keeps on each WebSocket: its device, what its session attached at the upgrade, and its wrapper. */
type SocketData = { readonly deviceId: string; readonly attachment: SocketAttachment; socket?: BunSessionSocket };

/** A session and its open sockets. */
type Entry = { readonly session: DeviceSession; readonly sockets: Set<BunSessionSocket> };

const CLOCK: Clock = {
	now: () => Date.now(),
	after: (delay, callback) => {
		const timer = setTimeout(callback, delay);
		return () => clearTimeout(timer);
	},
};

/** A Bun WebSocket as a session uses it. */
class BunSessionSocket implements SessionSocket {
	private readonly socket: ServerWebSocket<SocketData>;
	private kept: SocketAttachment;

	constructor(socket: ServerWebSocket<SocketData>) {
		this.socket = socket;
		this.kept = socket.data.attachment;
	}

	send(bytes: Uint8Array): void {
		if (this.socket.send(bytes) === 0) throw new Error("The socket is closed");
	}

	sendText(text: string): void {
		this.socket.send(text);
	}

	close(code: number, reason: string): void {
		this.socket.close(code, reason);
	}

	bufferedAmount(): number {
		return this.socket.getBufferedAmount();
	}

	attachment(): SocketAttachment {
		return this.kept;
	}

	attach(attachment: SocketAttachment): void {
		this.kept = attachment;
	}
}

/** The relay as a Bun `fetch` handler and `websocket` handler, for an application's own `Bun.serve`. */
export function createBunRelay(options: BunRelayOptions) {
	const relay = createRelay(options);
	const devices = new SqliteDevices(options.database);
	const entries = new Map<string, Entry>();

	const entryOf = (deviceId: string): Entry => {
		const existing = entries.get(deviceId);
		if (existing !== undefined) return existing;
		const sockets = new Set<BunSessionSocket>();
		const host = {
			records: { get: async () => devices.get(deviceId), delete: async () => devices.delete(deviceId) },
			sockets: { live: () => [...sockets], lastHeartbeat: () => undefined },
			clock: CLOCK,
		};
		const entry = { session: new DeviceSession(deviceId, host, options), sockets };
		entries.set(deviceId, entry);
		return entry;
	};

	const websocket: WebSocketHandler<SocketData> = {
		// Visitors' messages may be this large; connector frames are checked against the limits by the session.
		maxPayloadLength: MAX_MESSAGE_SIZE,
		perMessageDeflate: false,
		open(socket) {
			const wrapped = new BunSessionSocket(socket);
			socket.data.socket = wrapped;
			const entry = entryOf(socket.data.deviceId);
			entry.sockets.add(wrapped);
			entry.session.opened(wrapped);
		},
		message(socket, message) {
			const wrapped = socket.data.socket;
			if (wrapped === undefined) return;
			const data = typeof message === "string" ? message : new Uint8Array(message);
			void entryOf(socket.data.deviceId).session.message(wrapped, data);
		},
		close(socket, code, reason) {
			const wrapped = socket.data.socket;
			const entry = entries.get(socket.data.deviceId);
			if (wrapped === undefined || entry === undefined) return;
			entry.sockets.delete(wrapped);
			entry.session.closed(wrapped, code, reason);
		},
	};

	const hostFor = (server: Server<SocketData>, original: Request): RelayHost => ({
		createDevice: async (record) => devices.create(record),
		forward: async (deviceId, request) => {
			if (devices.get(deviceId) === undefined) return errorResponse("not_found", "Unknown device");
			const entry = entryOf(deviceId);
			const response = await entry.session.fetch(request, {
				address: server.requestIP(original)?.address ?? "",
				acceptWebSocket: (attachment, protocol) => {
					const headers = protocol === undefined ? undefined : { "sec-websocket-protocol": protocol };
					return server.upgrade(original, { data: { deviceId, attachment }, ...(headers === undefined ? {} : { headers }) })
						? undefined
						: errorResponse("invalid", "The upgrade failed");
				},
			});
			if (devices.get(deviceId) === undefined && entry.sockets.size === 0) entries.delete(deviceId);
			return response;
		},
	});

	return {
		websocket,
		/** Answers a request; `undefined` when it was upgraded to a WebSocket. */
		async fetch(request: Request, server: Server<SocketData>): Promise<Response | undefined> {
			try {
				return await relay.handle(request, hostFor(server, request));
			} catch {
				return errorResponse("internal", "The relay failed");
			}
		},
		/** Closes every session's connections with 1012, so connectors reconnect, and the database. */
		close(): void {
			for (const { session } of entries.values()) session.shutdown();
			entries.clear();
			devices.close();
		},
	};
}

/** A relay serving on its own `Bun.serve`, by default on `127.0.0.1:8787`. */
export function serveRelay(options: BunRelayOptions & { readonly port?: number; readonly hostname?: string }) {
	const relay = createBunRelay(options);
	const server = Bun.serve<SocketData>({
		port: options.port ?? 8787,
		hostname: options.hostname ?? "127.0.0.1",
		fetch: relay.fetch,
		websocket: relay.websocket,
		idleTimeout: 0,
		error: () => errorResponse("internal", "The relay failed"),
	});
	return {
		server,
		async close(): Promise<void> {
			relay.close();
			await server.stop(true);
		},
	};
}
