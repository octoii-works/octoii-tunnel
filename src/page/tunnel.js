// The session for a browser: the page's side of the module `tunnel.wasm`, which is the whole session. This file holds
// what only a page has — the relay's WebSocket, the clock and the timers — and turns the module's calls into promises:
// each turn takes what came, runs what waits on the session, sends what is due, and sleeps till the module's next wake.

const STATES = ["connecting", "ready", "ended", "machine-away"];
const OPCODE = { TEXT: 1, BINARY: 2, CLOSE: 8 };

/** The most frames a turn sends before it lets the page's other work run. */
const FRAMES_PER_TURN = 32;

/** How often the relay's link is pinged, in ms: a relay answers without waking the machine's home. */
const PING_MS = 30_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The time, in microseconds: fine enough to measure a session's round trip, and never going back. */
function clock() {
	return (performance.timeOrigin + performance.now()) * 1000;
}

/** The little of WASI the module calls: randomness and the time; anything else is refused. */
function wasi(memory) {
	const view = () => new DataView(memory().buffer);
	const calls = {
		random_get(pointer, length) {
			for (let at = 0; at < length; at += 65536) crypto.getRandomValues(new Uint8Array(memory().buffer, pointer + at, Math.min(65536, length - at)));
			return 0;
		},
		clock_time_get(_id, _precision, out) {
			view().setBigUint64(out, BigInt(Math.round(clock())) * 1000n, true);
			return 0;
		},
		args_sizes_get(count, size) {
			view().setUint32(count, 0, true);
			view().setUint32(size, 0, true);
			return 0;
		},
		args_get: () => 0,
		fd_write(_fd, vectors, count, out) {
			let written = 0;
			for (let index = 0; index < count; index++) {
				const pointer = view().getUint32(vectors + index * 8, true);
				const length = view().getUint32(vectors + index * 8 + 4, true);
				console.error(decoder.decode(new Uint8Array(memory().buffer, pointer, length)));
				written += length;
			}
			view().setUint32(out, written, true);
			return 0;
		},
		proc_exit(code) {
			throw new Error(`the session's module exited with ${code}`);
		},
	};
	// The module links the rest of WASI's table, and calls none of it: ENOSYS, as a system without the call answers.
	return new Proxy(calls, { get: (target, name) => target[name] ?? (() => 52) });
}

/** A failure of the session or of a request on it. */
export class TunnelError extends Error {}

/** A WebSocket opened over the session. */
export class TunnelSocket {
	onmessage = null;
	onclose = null;

	constructor(tunnel, stream) {
		this.tunnel = tunnel;
		this.stream = stream;
	}

	/** Sends a message: a string as text, bytes as binary. */
	send(data) {
		this.tunnel.sendMessage(this, typeof data === "string" ? OPCODE.TEXT : OPCODE.BINARY, typeof data === "string" ? encoder.encode(data) : data);
	}

	close() {
		this.tunnel.closeSocket(this);
	}
}

/** A session from this page to a machine, through a relay. */
export class Tunnel {
	#module;
	#memory;
	#link;
	#tasks = new Set();
	#sockets = new Set();
	#timer = null;
	#ping = null;
	#admitted = false;
	#machine;
	#hostLength;
	#ended = false;

	constructor(instance, link, machine, hostLength) {
		this.#module = instance.exports;
		this.#memory = instance.exports.memory;
		this.#link = link;
		this.#machine = machine;
		this.#hostLength = hostLength;
	}

	/**
	 * Opens a session to the machine of the key `machine`, through the relay at `relay`, a `ws` or `wss` address, for the
	 * device whose key is made from the 32 bytes `seed`; resolved once the session is ready.
	 */
	static async open({ module, relay, machine, seed }) {
		let memory = null;
		const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi(() => memory) });
		memory = instance.exports.memory;
		instance.exports.__wasm_call_ctors?.();
		const exports = instance.exports;
		new Uint8Array(memory.buffer, exports.tunnel_exchange(), 32).set(seed);
		if (exports.tunnel_start(clock()) !== 1) throw new TunnelError("the session did not start");
		const key = decoder.decode(new Uint8Array(memory.buffer, exports.tunnel_exchange(), exports.tunnel_key()));
		const host = encoder.encode(new URL(relay).hostname);
		new Uint8Array(memory.buffer, exports.tunnel_host(), host.length).set(host);
		const link = new WebSocket(`${relay}/${machine}?key=${key}`);
		link.binaryType = "arraybuffer";
		const tunnel = new Tunnel(instance, link, machine, host.length);
		await tunnel.#ready();
		return tunnel;
	}

	/** Where the session stands: `connecting`, `ready`, `ended` or `machine-away`. */
	get state() {
		return STATES[this.#module.tunnel_state()];
	}

	/** The text of this device's key. */
	get key() {
		return decoder.decode(this.#bytes(this.#module.tunnel_exchange(), this.#module.tunnel_key()));
	}

	#bytes(pointer, length) {
		return new Uint8Array(this.#memory.buffer, pointer, length);
	}

	#put(bytes) {
		this.#bytes(this.#module.tunnel_exchange(), bytes.length).set(bytes);
	}

	#ready() {
		const link = this.#link;
		link.addEventListener("message", (event) => this.#arrived(event.data));
		link.addEventListener("close", () => this.#end(new TunnelError("the relay's link closed")));
		link.addEventListener("error", () => this.#end(new TunnelError("the relay could not be reached")));
		this.#ping = setInterval(() => link.readyState === WebSocket.OPEN && link.send("ping"), PING_MS);
		return this.#until(() => {
			if (this.state === "machine-away") throw new TunnelError("the machine is not on the relay");
			return this.state === "ready" ? true : undefined;
		});
	}

	#arrived(data) {
		if (typeof data === "string") return;
		const bytes = new Uint8Array(data);
		this.#put(bytes);
		const told = this.#module.tunnel_admit(bytes.length, this.#hostLength);
		if (told > 0) this.#link.send(this.#bytes(this.#module.tunnel_exchange(), told).slice());
		else if (told === -1) this.#admit();
		else this.#module.tunnel_take(bytes.length, clock());
		this.#turn();
	}

	#admit() {
		this.#admitted = true;
		this.#put(encoder.encode(this.#machine));
		if (this.#module.tunnel_connect(clock()) !== 1) this.#end(new TunnelError("the machine's key is no key"));
	}

	/** Takes what came, runs what waits, sends what is due, and sleeps till the module's next wake. */
	#turn() {
		if (this.#ended) return;
		clearTimeout(this.#timer);
		const now = clock();
		if (this.#admitted) this.#module.tunnel_step(now);
		this.#runTasks();
		this.#deliver();
		if (this.#ended) return;
		if (!this.#admitted) return;
		if (this.#module.tunnel_state() === 2) return this.#end(new TunnelError("the session ended"));
		let frames = 0;
		for (; frames < FRAMES_PER_TURN; frames++) {
			const length = this.#module.tunnel_next_frame(clock());
			if (length === 0) break;
			if (this.#link.readyState === WebSocket.OPEN) this.#link.send(this.#bytes(this.#module.tunnel_exchange(), length).slice());
		}
		const wake = frames === FRAMES_PER_TURN ? 0 : Math.max(0, (this.#module.tunnel_wake(clock()) - clock()) / 1000);
		this.#timer = setTimeout(() => this.#turn(), Math.min(wake, 2_147_483_647));
	}

	#runTasks() {
		for (const task of [...this.#tasks]) {
			try {
				const value = task.step();
				if (value === undefined) continue;
				this.#tasks.delete(task);
				task.resolve(value);
			} catch (error) {
				this.#tasks.delete(task);
				task.reject(error);
			}
		}
	}

	/** Resolves with what `step` gives, called each turn till it gives anything but undefined. */
	#until(step) {
		if (this.#ended) return Promise.reject(new TunnelError("the session ended"));
		return new Promise((resolve, reject) => {
			this.#tasks.add({ step, resolve, reject });
			this.#turn();
		});
	}

	#end(error) {
		if (this.#ended) return;
		this.#ended = true;
		clearTimeout(this.#timer);
		clearInterval(this.#ping);
		for (const task of this.#tasks) task.reject(error);
		this.#tasks.clear();
		for (const socket of this.#sockets) socket.onclose?.();
		this.#sockets.clear();
		if (this.#link.readyState === WebSocket.OPEN) this.#link.close();
	}

	/** Ends the session. */
	close() {
		this.#end(new TunnelError("the session was closed"));
	}

	#fields(fields) {
		return encoder.encode(fields.map(([name, value]) => `${name}\0${value}\0`).join(""));
	}

	#headOf(stream) {
		return this.#until(() => {
			const length = this.#module.tunnel_head(stream);
			if (length === -1) return undefined;
			if (length < 0) throw new TunnelError("the request was refused");
			const parts = decoder.decode(this.#bytes(this.#module.tunnel_exchange(), length)).split("\0");
			const headers = new Headers();
			let status = 0;
			for (let at = 0; at + 1 < parts.length; at += 2) {
				if (parts[at] === ":status") status = Number(parts[at + 1]);
				else if (!parts[at].startsWith(":")) headers.append(parts[at], parts[at + 1]);
			}
			return { status, headers };
		});
	}

	/** Sends a request and reads its whole response: its status, headers and body. */
	async request(method, target, { authority = "machine", headers = {}, body } = {}) {
		const fields = [[":method", method], [":scheme", "https"], [":authority", authority], [":path", target], ...Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])];
		const stream = await this.#until(() => {
			this.#put(this.#fields(fields));
			const opened = this.#module.tunnel_open(this.#fields(fields).length);
			if (opened === -2) throw new TunnelError("the request could not be sent");
			return opened === -1 ? undefined : opened;
		});
		try {
			await this.#writeBody(stream, typeof body === "string" ? encoder.encode(body) : body);
			const head = await this.#headOf(stream);
			return { ...head, body: await this.#readBody(stream) };
		} finally {
			this.#module.tunnel_close(stream);
			this.#turn();
		}
	}

	async #writeBody(stream, body) {
		let at = 0;
		const room = this.#module.tunnel_exchange_size();
		if (body) {
			await this.#until(() => {
				while (at < body.length) {
					const piece = body.subarray(at, at + room);
					this.#put(piece);
					const taken = this.#module.tunnel_write(stream, piece.length);
					if (taken < 0) throw new TunnelError("the request's body could not be sent");
					if (taken === 0) return undefined;
					at += taken;
				}
				return true;
			});
		}
		if (this.#module.tunnel_finish(stream) !== 1) throw new TunnelError("the request could not be finished");
		this.#turn();
	}

	#readBody(stream) {
		const pieces = [];
		return this.#until(() => {
			for (;;) {
				const length = this.#module.tunnel_read(stream);
				if (length === -2) throw new TunnelError("the response was cut off");
				if (length === -1) break;
				if (length === 0) return undefined;
				pieces.push(this.#bytes(this.#module.tunnel_exchange(), length).slice());
			}
			const whole = new Uint8Array(pieces.reduce((total, piece) => total + piece.length, 0));
			let at = 0;
			for (const piece of pieces) {
				whole.set(piece, at);
				at += piece.length;
			}
			return whole;
		});
	}

	/** Opens a WebSocket at `target`: resolved once the machine accepted it. */
	async socket(target, { authority = "machine", headers = {} } = {}) {
		await this.#until(() => {
			const takes = this.#module.tunnel_takes_sockets();
			if (takes === 0) throw new TunnelError("the machine takes no WebSockets");
			return takes === 1 ? true : undefined;
		});
		const given = encoder.encode(`${target}\0${authority}\0${Object.entries(headers).map(([name, value]) => `${name.toLowerCase()}\0${value}\0`).join("")}`);
		const stream = await this.#until(() => {
			this.#put(given);
			const opened = this.#module.tunnel_open_socket(given.length);
			if (opened === -2) throw new TunnelError("the WebSocket could not be opened");
			return opened === -1 ? undefined : opened;
		});
		const head = await this.#headOf(stream);
		if (head.status < 200 || head.status > 299) {
			this.#module.tunnel_close(stream);
			throw new TunnelError(`the machine refused the WebSocket: ${head.status}`);
		}
		const socket = new TunnelSocket(this, stream);
		this.#sockets.add(socket);
		return socket;
	}

	/** Sends a message on `socket`. */
	sendMessage(socket, opcode, bytes) {
		if (!this.#sockets.has(socket)) throw new TunnelError("the WebSocket is closed");
		const pointer = this.#module.tunnel_outgoing(bytes.length);
		if (pointer === 0) throw new TunnelError("no room for the message");
		this.#bytes(pointer, bytes.length).set(bytes);
		if (this.#module.tunnel_send_message(socket.stream, opcode) !== 1) throw new TunnelError("the message could not be sent");
		this.#turn();
	}

	/** Closes `socket`. */
	closeSocket(socket) {
		if (!this.#sockets.delete(socket)) return;
		this.#module.tunnel_close(socket.stream);
		socket.onclose?.();
		this.#turn();
	}

	#deliver() {
		for (const socket of [...this.#sockets]) {
			for (;;) {
				const kind = this.#module.tunnel_next_message(socket.stream);
				if (kind === 0) break;
				if (kind === OPCODE.CLOSE || kind < 0) {
					this.#sockets.delete(socket);
					this.#module.tunnel_close(socket.stream);
					socket.onclose?.();
					break;
				}
				const bytes = this.#bytes(this.#module.tunnel_message_pointer(), this.#module.tunnel_message_length()).slice();
				socket.onmessage?.(kind === OPCODE.TEXT ? decoder.decode(bytes) : bytes);
			}
		}
	}
}
