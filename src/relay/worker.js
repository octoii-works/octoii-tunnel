// The relay on Cloudflare Workers: a Durable Object for each machine, its home, which holds the WebSockets of the
// machine and of the peers that reach it, hibernating while they are quiet; and the Worker that routes each request to
// the home of the key its path names. What a home does with each message, the relay's WebAssembly module decides
// (relay.wasm, src/relay_wasm.zig): this file only holds the links.
//
// A peer connects to `wss://<relay>/<home key>?key=<its own key>`. The home accepts the WebSocket tagged with the key
// the peer claims and sends it a challenge; the peer's answer admits it by that key, displacing an earlier link of the
// same key. From then on each binary message is a frame of datagrams for a peer of the home, forwarded to it as from
// the sender, or answered with that peer's being gone. A text message "ping" is answered "pong" without waking the home.
// Asked, a home tells the keys of the peers on it, as a deployment shows who is on a machine's home.

import { DurableObject } from "cloudflare:workers";
import module from "./relay.wasm";

const relay = new WebAssembly.Instance(module, {}).exports;

/** The length of a key as text. */
const KEY_LENGTH = 52;

/** The most bytes a frame holds. */
const MAX_FRAME = 64 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Writes `bytes` into the module's memory at `pointer`. */
function put(pointer, bytes) {
	new Uint8Array(relay.memory.buffer).set(bytes, pointer);
}

/** The `length` bytes of the module's memory at `pointer`, copied out. */
function take(pointer, length) {
	return new Uint8Array(relay.memory.buffer).slice(pointer, pointer + length);
}

/** Whether `text` is a key's text. */
function isKey(text) {
	if (typeof text !== "string" || text.length !== KEY_LENGTH) return false;
	put(relay.relay_key(), encoder.encode(text));
	return relay.relay_valid_key() === 1;
}

/** The link a WebSocket of a home holds: the key its peer claimed, the relay's host, its challenge, and whether the
 * peer answered it. */
function linkOf(socket) {
	return socket.deserializeAttachment();
}

/** Sends `bytes` on `socket`, where it is still open. */
function send(socket, bytes) {
	try {
		socket.send(bytes);
	} catch {
		// A socket closing as the frame came: the frame is a datagram's, and lost as a network would lose it.
	}
}

/**
 * Defines the relay: its Worker and its Durable Object class, bound as `binding`. `authorize(request, env, home)`
 * decides whether a request may reach the home of `home`; all may, where it is not given.
 */
export function defineRelay({ binding = "HOMES", authorize = async () => true } = {}) {
	class Home extends DurableObject {
		constructor(ctx, env) {
			super(ctx, env);
			ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
		}

		async fetch(request) {
			if (request.headers.get("Upgrade") !== "websocket") return new Response("a home takes WebSockets", { status: 426 });
			const url = new URL(request.url);
			const key = url.searchParams.get("key");
			if (!isKey(key)) return new Response("a peer names its key", { status: 400 });
			const nonce = crypto.getRandomValues(new Uint8Array(32));
			const [client, server] = Object.values(new WebSocketPair());
			this.ctx.acceptWebSocket(server, [key]);
			server.serializeAttachment({ key, host: url.hostname, nonce: Array.from(nonce), admitted: false });
			put(relay.relay_nonce(), nonce);
			server.send(take(relay.relay_exchange(), relay.relay_challenge()));
			return new Response(null, { status: 101, webSocket: client });
		}

		async webSocketMessage(socket, message) {
			if (typeof message === "string" || message.byteLength > MAX_FRAME) {
				socket.close(1003, "frames are binary, each within its bound");
				return;
			}
			const link = linkOf(socket);
			const bytes = new Uint8Array(message);
			put(relay.relay_exchange(), bytes);
			put(relay.relay_key(), encoder.encode(link.key));
			if (link.admitted) this.forward(socket, bytes.length);
			else this.admit(socket, link, bytes.length);
		}

		/** Admits the peer of `socket` by its answer, displacing an earlier link of its key; ends the link where it
		 * does not hold. */
		admit(socket, link, length) {
			const host = encoder.encode(link.host);
			put(relay.relay_nonce(), new Uint8Array(link.nonce));
			put(relay.relay_host(), host);
			if (relay.relay_admit(length, host.length) !== 1) {
				socket.close(1008, "the answer does not hold");
				return;
			}
			socket.serializeAttachment({ ...link, admitted: true });
			for (const other of this.ctx.getWebSockets(link.key)) {
				if (other !== socket && linkOf(other)?.admitted) other.close(4000, "displaced by the same key");
			}
			send(socket, take(relay.relay_exchange(), relay.relay_welcome()));
		}

		/** Forwards the frame of `socket`'s peer to the peer it is for, or tells it that peer is gone; ends the link of
		 * a peer that sends anything else. */
		forward(socket, length) {
			if (relay.relay_forward(length) !== 1) {
				socket.close(1008, "not a frame a peer sends");
				return;
			}
			const addressee = decoder.decode(take(relay.relay_key(), KEY_LENGTH));
			const target = this.ctx.getWebSockets(addressee).find((other) => linkOf(other)?.admitted);
			if (target) {
				send(target, take(relay.relay_exchange(), length));
				return;
			}
			put(relay.relay_key(), encoder.encode(addressee));
			send(socket, take(relay.relay_exchange(), relay.relay_gone()));
		}

		async webSocketClose(socket, code, reason) {
			socket.close(code, reason);
		}

		/** The keys of the peers on the home now, each admitted by its answer; the machine's own among them while it is
		 * on its home. */
		async peers() {
			const keys = new Set();
			for (const socket of this.ctx.getWebSockets()) {
				const link = linkOf(socket);
				if (link?.admitted) keys.add(link.key);
			}
			return [...keys];
		}
	}

	const worker = {
		async fetch(request, env) {
			const home = new URL(request.url).pathname.slice(1);
			if (!isKey(home)) return new Response("no home of that key", { status: 404 });
			if (!(await authorize(request, env, home))) return new Response("not authorized", { status: 403 });
			return env[binding].getByName(home).fetch(request);
		},
	};

	return { worker, Home };
}
