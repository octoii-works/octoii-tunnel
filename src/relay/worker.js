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
//
// A deployment may also name routes: a request it finds to be for a route of a machine is carried, as HTTP/1.1, over a
// byte stream the machine's home opens on the machine's link to the local port of that route. Each direction is paced
// by the window its receiver grants, so a slow visitor holds the machine to a window. A stream's state is the object's
// memory alone: the request in flight keeps the object awake, and the stream goes with it.

import { DurableObject } from "cloudflare:workers";
import module from "./relay.wasm";

const relay = new WebAssembly.Instance(module, {}).exports;

/** The length of a key as text. */
const KEY_LENGTH = 52;

/** The most bytes a frame holds. */
const MAX_FRAME = 64 * 1024;

/** The frames between a home and its machine that the home reads, by their type's byte. */
const FROM_MACHINE = { DATA: 0x21, END: 0x22, RESET: 0x23, WINDOW: 0x24, ROUTES: 0x25 };

/** How many bytes of a stream each end takes before it grants more, and how many a home consumes before it does. */
const STREAM_WINDOW = 256 * 1024;
const GRANT_THRESHOLD = 64 * 1024;

/** The most routes a machine has; what it names of them lies in its link's attachment, which is bounded. */
const MAX_ROUTES = 20;

/** The headers of a request or a response that are its connection's, not its own. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);

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

/** The bytes of `parts`, one after the other. */
function joined(parts) {
	const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
	let at = 0;
	for (const part of parts) {
		bytes.set(part, at);
		at += part.length;
	}
	return bytes;
}

/** Where the blank line that ends an HTTP head lies in `bytes`; -1 where it has not come. */
function endOfHead(bytes) {
	for (let at = 0; at + 3 < bytes.length; at++) {
		if (bytes[at] === 13 && bytes[at + 1] === 10 && bytes[at + 2] === 13 && bytes[at + 3] === 10) return at;
	}
	return -1;
}

/** What a chunked body's bytes come to: gives each piece of the body it has as they come; `finished` once it ended. */
class Chunks {
	held = new Uint8Array(0);
	/** How many bytes of the chunk being read are still to come; null between chunks. */
	left = null;
	finished = false;

	take(bytes) {
		this.held = joined([this.held, bytes]);
		const pieces = [];
		while (!this.finished) {
			if (this.left === null) {
				const line = this.held.indexOf(10);
				if (line < 0) break;
				const size = parseInt(decoder.decode(this.held.subarray(0, line)), 16);
				if (Number.isNaN(size)) throw new Error("a chunk's size is no number");
				this.held = this.held.subarray(line + 1);
				if (size === 0) this.finished = true;
				else this.left = size;
			} else if (this.left > 0) {
				if (this.held.length === 0) break;
				const piece = this.held.subarray(0, this.left);
				pieces.push(piece);
				this.left -= piece.length;
				this.held = this.held.subarray(piece.length);
			} else {
				if (this.held.length < 2) break;
				this.held = this.held.subarray(2);
				this.left = null;
			}
		}
		return pieces;
	}
}

/**
 * A visitor's request carried over a stream to a route: its head and its body written within the machine's window, the
 * machine's answer read back as a Response whose body gives bytes as the visitor takes them, granting them again.
 */
class Carried {
	window = STREAM_WINDOW;
	owed = 0;
	held = new Uint8Array(0);
	queue = [];
	ended = false;
	failed = false;
	headDone = false;
	remaining = null;
	/** The bytes of the head that came, consumed once the head is whole. */
	headRaw = 0;
	chunks = null;
	wake = null;
	roomWaiter = null;

	constructor(home, socket, id, method) {
		this.home = home;
		this.socket = socket;
		this.id = id;
		this.noBody = method === "HEAD";
		this.response = new Promise((resolve) => {
			this.answer = resolve;
		});
	}

	/** Sends the request's head and body, within the machine's window, then ends the machine's side. */
	async send(request) {
		const url = new URL(request.url);
		const lines = [`${request.method} ${url.pathname}${url.search} HTTP/1.1`, `host: ${url.host}`, "connection: close", `x-forwarded-host: ${url.host}`, "x-forwarded-proto: https"];
		const visitor = request.headers.get("cf-connecting-ip");
		if (visitor) lines.push(`x-forwarded-for: ${visitor}`);
		for (const [name, value] of request.headers) {
			if (!HOP_BY_HOP.has(name) && name !== "host" && !name.startsWith("cf-") && !name.startsWith("x-forwarded-")) lines.push(`${name}: ${value}`);
		}
		const chunked = request.body !== null && !request.headers.has("content-length");
		if (chunked) lines.push("transfer-encoding: chunked");
		await this.write(encoder.encode(`${lines.join("\r\n")}\r\n\r\n`));
		if (request.body !== null) {
			const reader = request.body.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done || this.failed) break;
				await this.write(chunked ? joined([encoder.encode(`${value.length.toString(16)}\r\n`), value, encoder.encode("\r\n")]) : value);
			}
			if (chunked) await this.write(encoder.encode("0\r\n\r\n"));
		}
		if (!this.failed) this.home.sendFrame(this.socket, relay.relay_write_end(this.id));
	}

	async write(bytes) {
		let at = 0;
		const most = relay.relay_stream_max();
		while (at < bytes.length && !this.failed) {
			if (this.window === 0) {
				await new Promise((resolve) => {
					this.roomWaiter = resolve;
				});
				continue;
			}
			const piece = bytes.subarray(at, at + Math.min(most, this.window));
			put(relay.relay_exchange() + relay.relay_stream_header(), piece);
			send(this.socket, take(relay.relay_exchange(), relay.relay_write_data(this.id, piece.length)));
			this.window -= piece.length;
			at += piece.length;
		}
	}

	grow(grant) {
		this.window += grant;
		this.roomWaiter?.();
		this.roomWaiter = null;
	}

	/** Takes bytes of the machine's answer: its head, then its body as the head framed it. */
	data(bytes) {
		if (this.headDone) return this.body(bytes, bytes.length);
		this.headRaw += bytes.length;
		this.held = joined([this.held, bytes]);
		for (;;) {
			const end = endOfHead(this.held);
			if (end < 0) {
				if (this.held.length > 64 * 1024) this.fail(502);
				return;
			}
			const head = decoder.decode(this.held.subarray(0, end)).split("\r\n");
			const rest = this.held.subarray(end + 4);
			const status = Number(head[0]?.split(" ")[1]);
			if (!Number.isInteger(status) || status < 200 || status > 599) {
				// An interim response, ahead of the answer: 1xx, or what is no response at all.
				if (status >= 100 && status < 200) {
					this.held = rest;
					continue;
				}
				return this.fail(502);
			}
			this.held = new Uint8Array(0);
			this.headDone = true;
			this.open(status, head.slice(1));
			return this.body(rest, this.headRaw);
		}
	}

	open(status, lines) {
		const headers = new Headers();
		for (const line of lines) {
			const colon = line.indexOf(":");
			if (colon < 1) continue;
			const name = line.slice(0, colon).trim().toLowerCase();
			const value = line.slice(colon + 1).trim();
			if (name === "content-length") this.remaining = Number(value);
			if (name === "transfer-encoding" && value.toLowerCase().includes("chunked")) this.chunks = new Chunks();
			if (!HOP_BY_HOP.has(name)) headers.append(name, value);
		}
		const empty = this.noBody || status === 204 || status === 304;
		if (empty) this.remaining = 0;
		const carried = this;
		const body = empty
			? null
			: new ReadableStream(
					{
						pull: (controller) => carried.pull(controller),
						cancel: () => carried.abandon(),
					},
					{ highWaterMark: 0 },
				);
		this.answer(new Response(body, { status, headers }));
		if (empty) this.abandon();
	}

	/** Takes bytes of the body, `raw` of the stream's window consumed by them. */
	body(bytes, raw) {
		let pieces = [bytes];
		if (this.chunks) pieces = this.chunks.take(bytes);
		else if (this.remaining !== null) {
			pieces = [bytes.subarray(0, this.remaining)];
			this.remaining -= pieces[0].length;
		}
		pieces = pieces.filter((piece) => piece.length > 0);
		this.queue.push({ pieces, raw });
		if (this.chunks?.finished || this.remaining === 0) this.ended = true;
		this.wake?.();
		this.wake = null;
	}

	/** Gives the visitor what has come, as they read, and grants the machine what they took. */
	async pull(controller) {
		for (;;) {
			const next = this.queue.shift();
			if (next) {
				for (const piece of next.pieces) controller.enqueue(piece);
				this.credit(next.raw);
				if (next.pieces.length > 0) return;
				continue;
			}
			if (this.failed) return controller.error(new Error("the machine let the stream go"));
			if (this.ended) {
				controller.close();
				this.abandon();
				return;
			}
			await new Promise((resolve) => {
				this.wake = resolve;
			});
		}
	}

	credit(bytes) {
		this.owed += bytes;
		if (this.owed < GRANT_THRESHOLD || this.ended) return;
		send(this.socket, take(relay.relay_exchange(), relay.relay_write_window(this.id, this.owed)));
		this.owed = 0;
	}

	/** The machine ended its side. */
	end() {
		if (!this.headDone) return this.fail(502);
		this.ended = true;
		this.wake?.();
		this.wake = null;
	}

	/** The stream is lost: the visitor is told, in the status where no answer had begun. */
	fail(status) {
		this.failed = true;
		this.home.streams.delete(this.id);
		if (!this.headDone) this.answer(new Response("the machine did not answer", { status }));
		this.roomWaiter?.();
		this.wake?.();
	}

	/** The visitor went, or the answer is whole: the machine lets the stream go. */
	abandon() {
		if (!this.home.streams.delete(this.id)) return;
		send(this.socket, take(relay.relay_exchange(), relay.relay_write_reset(this.id)));
	}
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
export function defineRelay({ binding = "HOMES", authorize = async () => true, routeOf = async () => null } = {}) {
	class Home extends DurableObject {
		/** The streams in flight, by their numbers. */
		streams = new Map();
		/** The number of the next stream: from a random start, as a machine may hold streams of an earlier awakening. */
		nextStream = crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;

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
			server.serializeAttachment({ key, home: url.pathname.slice(1), host: url.hostname, nonce: Array.from(nonce), admitted: false, routes: [] });
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
			if (!link.admitted) this.admit(socket, link, bytes.length);
			else if (!this.fromMachine(socket, link, bytes.length)) this.forward(socket, bytes.length);
		}

		/** Takes what the machine of the home says of its streams and routes: whether the frame in the exchange was that. */
		fromMachine(socket, link, length) {
			if (link.key !== link.home) return false;
			const kind = relay.relay_stream_decode(length);
			if (kind === 0) return false;
			if (kind === FROM_MACHINE.ROUTES) {
				const names = decoder.decode(take(relay.relay_exchange() + relay.relay_stream_offset(), relay.relay_stream_length())).split("\n").filter(Boolean);
				if (names.length > MAX_ROUTES) socket.close(1008, "too many routes");
				else socket.serializeAttachment({ ...link, routes: names });
				return true;
			}
			const stream = this.streams.get(relay.relay_stream_id());
			if (!stream) return true;
			if (kind === FROM_MACHINE.DATA) stream.data(take(relay.relay_exchange() + relay.relay_stream_offset(), relay.relay_stream_length()));
			else if (kind === FROM_MACHINE.END) stream.end();
			else if (kind === FROM_MACHINE.RESET) stream.fail(502);
			else if (kind === FROM_MACHINE.WINDOW) stream.grow(relay.relay_stream_grant());
			return true;
		}

		/** Sends the frame the module wrote in the exchange, `length` long, on `socket`. */
		sendFrame(socket, length) {
			send(socket, take(relay.relay_exchange(), length));
		}

		/** The link of the machine whose home this is, admitted; undefined while it is not on it. */
		machine() {
			return this.ctx.getWebSockets().find((socket) => {
				const link = linkOf(socket);
				return link?.admitted && link.key === link.home;
			});
		}

		/** Carries a visitor's `request` to the machine's route `name`: the machine's answer, as it comes. */
		async route(name, request) {
			const socket = this.machine();
			if (!socket) return new Response("this machine is offline", { status: 502 });
			if (request.headers.get("upgrade")?.toLowerCase() === "websocket") return new Response("routes do not carry WebSockets", { status: 501 });
			const nameBytes = encoder.encode(name);
			if (nameBytes.length > 50) return new Response("no such route", { status: 404 });
			new Uint8Array(relay.memory.buffer).set(nameBytes, relay.relay_route());
			if (relay.relay_valid_route(nameBytes.length) !== 1) return new Response("no such route", { status: 404 });
			const id = this.nextStream++;
			send(socket, take(relay.relay_exchange(), relay.relay_write_open(id, nameBytes.length)));
			const carried = new Carried(this, socket, id, request.method);
			this.streams.set(id, carried);
			this.ctx.waitUntil(carried.send(request).catch(() => carried.fail(502)));
			return carried.response;
		}

		/** The names of the routes the machine says it has, while it is on its home. */
		async routes() {
			const socket = this.machine();
			return socket ? linkOf(socket).routes : [];
		}

		/** Asks the machine to remove its route `name`: whether it was there to be asked. */
		async removeRoute(name) {
			const socket = this.machine();
			const nameBytes = encoder.encode(name);
			if (!socket || nameBytes.length > 50) return false;
			new Uint8Array(relay.memory.buffer).set(nameBytes, relay.relay_route());
			if (relay.relay_valid_route(nameBytes.length) !== 1) return false;
			send(socket, take(relay.relay_exchange(), relay.relay_write_remove(nameBytes.length)));
			return true;
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
			const link = linkOf(socket);
			if (link?.key === link?.home) for (const stream of [...this.streams.values()]) if (stream.socket === socket) stream.fail(502);
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
			const routed = await routeOf(request, env);
			if (routed) return env[binding].getByName(routed.home).route(routed.name, request);
			const home = new URL(request.url).pathname.slice(1);
			if (!isKey(home)) return new Response("no home of that key", { status: 404 });
			if (!(await authorize(request, env, home))) return new Response("not authorized", { status: 403 });
			return env[binding].getByName(home).fetch(request);
		},
	};

	return { worker, Home };
}
