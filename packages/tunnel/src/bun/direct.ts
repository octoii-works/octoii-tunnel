/**
 * A direct listener: a WebSocket server on the device's own network that serves the secure path alone, handing each
 * socket to the device's secure endpoint, so a paired visitor nearby reaches the device without the relay.
 */
import type { Server, ServerWebSocket } from "bun";
import { SECURE_PATH } from "../protocol/index.ts";
import type { SecureEndpoint } from "../secure/endpoint.ts";
import type { TunnelSocket } from "../websocket-stream.ts";

/** The longest message a direct socket takes: one Noise message. */
const MAX_MESSAGE_BYTES = 65_535;

/** The close code of a socket the endpoint could not take, as for a refused handshake. */
const REFUSED = 4401;

/** Where a direct listener listens, and the endpoint it serves. */
export type DirectOptions = { readonly endpoint: SecureEndpoint; readonly hostname: string; readonly port: number };

/** A direct listener that answers: the port it listens on, and how it stops. */
export type DirectListener = { readonly port: number; close(): Promise<void> };

/** What a direct WebSocket carries: the tunnel socket it is to the endpoint. */
type SocketData = { socket?: DirectSocket };

/** Listens on `hostname` and `port` for paired visitors' secure channels. */
export function serveDirect(options: DirectOptions): DirectListener {
	const server: Server<SocketData> = Bun.serve<SocketData>({
		hostname: options.hostname,
		port: options.port,
		fetch: (request, served) => {
			if (new URL(request.url).pathname !== SECURE_PATH) return new Response(null, { status: 404 });
			return served.upgrade(request, { data: {} }) ? undefined : new Response(null, { status: 426 });
		},
		websocket: {
			maxPayloadLength: MAX_MESSAGE_BYTES,
			open: (socket) => {
				const direct = new DirectSocket(socket);
				socket.data.socket = direct;
				options.endpoint.accept(() => direct).catch(() => socket.close(REFUSED, ""));
			},
			message: (socket, message) => socket.data.socket?.received(typeof message === "string" ? message : new Uint8Array(message)),
			close: (socket, code, reason) => socket.data.socket?.closed(code, reason),
		},
	});
	const { port } = server;
	if (port === undefined) throw new Error("The direct listener listens on no port");
	return { port, close: () => server.stop(true) };
}

/** A direct WebSocket as the endpoint takes it: what arrives before the handshake listens is kept for it. */
class DirectSocket implements TunnelSocket {
	readonly protocol = undefined;
	onclose: ((code: number, reason: string) => void) | undefined;
	private readonly socket: ServerWebSocket<SocketData>;
	private readonly early: (string | Uint8Array)[] = [];
	private listener: ((message: string | Uint8Array) => void) | undefined;

	constructor(socket: ServerWebSocket<SocketData>) {
		this.socket = socket;
	}

	get onmessage(): ((message: string | Uint8Array) => void) | undefined {
		return this.listener;
	}

	set onmessage(listener: ((message: string | Uint8Array) => void) | undefined) {
		this.listener = listener;
		if (listener !== undefined) for (const message of this.early.splice(0)) listener(message);
	}

	send(message: string | Uint8Array): void {
		this.socket.send(message);
	}

	close(code?: number, reason?: string): void {
		this.socket.close(code, reason);
	}

	received(message: string | Uint8Array): void {
		if (this.listener === undefined) this.early.push(message);
		else this.listener(message);
	}

	closed(code: number, reason: string): void {
		this.onclose?.(code, reason);
	}
}
