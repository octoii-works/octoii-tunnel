import type { Server, WebSocketHandler } from "bun";
import { MAX_BUFFER, MAX_FRAME } from "@klein-works/takotunnel/protocol";
import { createRelay, DeviceSession, type AgentConnection, type DeviceStore, type RelayOptions, type RelaySocket, type Scheduler } from "../index.ts";
import { errorResponse } from "../host.ts";

export interface SocketData {
	accept: (socket: RelaySocket) => AgentConnection;
	connection?: AgentConnection;
}
export interface BunRelayOptions extends RelayOptions {
	store: DeviceStore;
}

export function createBunRelay(options: BunRelayOptions) {
	const store = options.store;
	const router = createRelay(options);
	const sessions = new Map<string, DeviceSession>();
	const scheduler: Scheduler = {
		now: () => Date.now(),
		schedule: (deadline, callback) => {
			const timer = setTimeout(callback, Math.max(0, deadline - Date.now()));
			return () => clearTimeout(timer);
		},
	};
	const websocket: WebSocketHandler<SocketData> = {
		maxPayloadLength: MAX_FRAME + 10,
		backpressureLimit: MAX_BUFFER,
		closeOnBackpressureLimit: true,
		open(socket) {
			socket.data.connection = socket.data.accept({
				send(bytes) {
					if (socket.send(bytes) === 0) throw new Error("Socket closed");
				},
				close(code, reason) {
					socket.close(code, reason);
				},
			});
		},
		message(socket, message) {
			if (typeof message === "string") {
				socket.close(4004, "Binary frames required");
				return;
			}
			void socket.data.connection?.message(new Uint8Array(message)).catch(() => socket.close(4004, "Invalid frame"));
		},
		close(socket) {
			socket.data.connection?.closed();
		},
	};
	return {
		websocket,
		async fetch(request: Request, server: Server<SocketData>): Promise<Response | undefined> {
			try {
				return await router.fetch(request, {
					create: (record) => store.create(record),
					dispatch: async (id, incoming) => {
						if (!(await store.get(id))) return errorResponse(404, "not_found", "Unknown device");
						let session = sessions.get(id);
						if (!session) {
							session = new DeviceSession(id, { store, scheduler }, options);
							sessions.set(id, session);
						}
						const response = await session.fetch(incoming, {
							address: server.requestIP(request)?.address ?? "",
							upgrade: (accept) => (server.upgrade(request, { data: { accept } }) ? undefined : errorResponse(400, "invalid", "Upgrade failed")),
						});
						if (response?.status === 204 && incoming.method === "DELETE") sessions.delete(id);
						return response;
					},
				});
			} catch {
				return errorResponse(500, "internal", "Relay request failed");
			}
		},
		close() {
			for (const session of sessions.values()) session.shutdown();
			sessions.clear();
		},
	};
}

export function serveRelay(options: BunRelayOptions & { port?: number; hostname?: string }) {
	const adapter = createBunRelay(options);
	const server = Bun.serve<SocketData>({
		port: options.port ?? 8787,
		hostname: options.hostname ?? "127.0.0.1",
		fetch: adapter.fetch,
		websocket: adapter.websocket,
		idleTimeout: 0,
		error: () => errorResponse(500, "internal", "Relay request failed"),
	});
	return {
		server,
		async close() {
			adapter.close();
			await server.stop(true);
		},
	};
}
