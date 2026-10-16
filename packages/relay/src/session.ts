import {
	credentialHash,
	decodeFrame,
	defaultLimits,
	encodeFrame,
	equalSecrets,
	forwardedHeaders,
	jsonBytes,
	parseHead,
	parseHello,
	parseLimits,
	ProtocolError,
	ReceiveBody,
	SendWindow,
	sendBody,
	types,
	validateReset,
	windowAmount,
	windowBytes,
	type Frame,
	type FrameType,
	type Limits,
} from "@klein-works/takotunnel/protocol";
import {
	authorize,
	errorResponse,
	recordMeter,
	type AgentConnection,
	type RelayOptions,
	type RelaySocket,
	type RequestContext,
	type SessionHost,
} from "./host.ts";

interface Agent {
	socket: RelaySocket;
	authenticated: boolean;
	closed: boolean;
	started: number;
	lastSeen: number;
	lastPing: number;
}
interface Exchange {
	id: number;
	method: string;
	window: SendWindow;
	body: ReceiveBody;
	abort: AbortController;
	resolve: (response: Response) => void;
	head: boolean;
	requestEnded: boolean;
	responseEnded: boolean;
	responseConsumed: boolean;
	noBody: boolean;
	started: number;
	lastSeen: number;
	bytesIn: number;
	bytesOut: number;
	unlisten: () => void;
}

export class DeviceSession {
	private readonly limits: Limits;
	private current: Agent | undefined;
	private readonly agents = new Set<Agent>();
	private readonly exchanges = new Map<number, Exchange>();
	private nextId = 1;
	private cancelTimer: (() => void) | undefined;
	private revision = 0;
	private removing = false;
	constructor(
		readonly id: string,
		private readonly host: SessionHost,
		private readonly options: RelayOptions,
	) {
		this.limits = parseLimits(jsonBytes({ ...defaultLimits, ...options.limits }));
	}

	async fetch(request: Request, context: RequestContext): Promise<Response | undefined> {
		const record = await this.host.store.get(this.id);
		if (!record || this.removing) return errorResponse(404, "not_found", "Unknown device");
		const url = new URL(request.url);
		if (url.host === new URL(this.options.origin).host) {
			if (url.pathname === `/v1/devices/${this.id}` && request.method === "DELETE") {
				const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
				if (!token || !equalSecrets(credentialHash(token), record.credentialHash)) return errorResponse(401, "unauthorized", "Invalid credential");
				this.revision++;
				this.removing = true;
				try {
					await this.host.store.remove(this.id);
				} catch (error) {
					this.removing = false;
					throw error;
				}
				this.shutdown(4001, "Device removed");
				return new Response(null, { status: 204 });
			}
			if (url.pathname === `/v1/agent/${this.id}` && request.method === "GET") {
				if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return errorResponse(426, "invalid", "WebSocket required");
				if (this.agents.size >= 4) return errorResponse(429, "quota", "Too many pending connections");
				return context.upgrade((socket) => this.accept(socket));
			}
			return errorResponse(404, "not_found", "Unknown route");
		}
		if (request.headers.get("upgrade")) return errorResponse(501, "unsupported", "Visitor WebSockets are not implemented");
		const decision = await authorize(this.options, { kind: "visitor", deviceId: this.id, request });
		if (!decision.allowed) return errorResponse(decision.status, decision.status === 429 ? "quota" : "forbidden", "Stream refused");
		if (!this.current) return errorResponse(502, "offline", "Device is offline");
		if (this.exchanges.size >= this.limits.maxStreams) {
			return new Response("Too many streams", { status: 503, headers: { "retry-after": "1" } });
		}
		return this.open(request, context.address);
	}

	accept(socket: RelaySocket): AgentConnection {
		const now = this.host.scheduler.now();
		const agent: Agent = { socket, authenticated: false, closed: false, started: now, lastSeen: now, lastPing: now };
		this.agents.add(agent);
		this.schedule();
		return this.connection(agent);
	}

	private connection(agent: Agent): AgentConnection {
		let receiving = false;
		return {
			message: async (bytes) => {
				if (agent.closed) return;
				// Only hello performs asynchronous work. Frames before it completes are invalid.
				if (receiving) {
					this.close(agent, 4004, "Handshake in progress");
					return;
				}
				receiving = true;
				try {
					const frame = decodeFrame(bytes, this.limits.maxFrame);
					agent.lastSeen = this.host.scheduler.now();
					if (!agent.authenticated) await this.hello(agent, frame);
					else this.receive(agent, frame);
				} catch {
					this.close(agent, 4004, "Invalid frame");
				} finally {
					receiving = false;
					this.schedule();
				}
			},
			closed: () => this.disconnected(agent),
		};
	}

	shutdown(code = 1012, reason = "Relay restarting"): void {
		for (const agent of this.agents) this.close(agent, code, reason);
		this.cancelTimer?.();
		this.cancelTimer = undefined;
	}

	private async hello(agent: Agent, frame: Frame): Promise<void> {
		if (frame.type !== types.hello) throw new ProtocolError("Expected hello");
		const hello = parseHello(frame.payload);
		if (hello.version !== 1) {
			this.close(agent, 4002, "Unsupported version");
			return;
		}
		const revision = this.revision;
		const record = await this.host.store.get(this.id);
		if (this.removing || !record || !equalSecrets(credentialHash(hello.credential), record.credentialHash)) {
			this.close(agent, 4001, "Invalid credential");
			return;
		}
		const decision = await authorize(this.options, { kind: "agent", deviceId: this.id });
		if (!decision.allowed || this.removing || revision !== this.revision) {
			this.close(agent, 4001, "Connection refused");
			return;
		}
		if (agent.closed) return;
		if (this.current) this.close(this.current, 4000, "Connection replaced");
		this.current = agent;
		agent.authenticated = true;
		this.nextId = 1;
		agent.socket.send(encodeFrame(types.welcome, 0, jsonBytes(this.limits)));
	}

	private receive(agent: Agent, frame: Frame): void {
		if (agent !== this.current) throw new ProtocolError("Inactive agent");
		if (frame.type === types.ping) {
			this.send(types.pong, 0, frame.payload);
			return;
		}
		if (frame.type === types.pong) return;
		if (!frame.stream) throw new ProtocolError("Unexpected connection frame");
		const exchange = this.exchanges.get(frame.stream);
		if (!exchange) {
			if (frame.type !== types.reset) this.send(types.reset, frame.stream, jsonBytes({ code: "cancelled", reason: "Unknown stream" }));
			return;
		}
		exchange.lastSeen = this.host.scheduler.now();
		try {
			switch (frame.type) {
				case types.head: {
					if (exchange.head) throw new ProtocolError("Duplicate head");
					const { status, headers } = parseHead(frame.payload);
					const noBody = exchange.method === "HEAD" || status === 204 || status === 205 || status === 304;
					exchange.noBody = noBody;
					const response = new Response(noBody ? null : exchange.body.stream, { status, headers: forwardedHeaders(new Headers(headers)) });
					exchange.head = true;
					exchange.resolve(response);
					break;
				}
				case types.data:
					if (!exchange.head || exchange.noBody) throw new ProtocolError("Unexpected body data");
					exchange.body.push(frame.payload);
					exchange.bytesOut += frame.payload.length;
					break;
				case types.end:
					if (!exchange.head || frame.payload.length) throw new ProtocolError("Invalid end");
					exchange.body.end();
					exchange.responseEnded = true;
					this.complete(exchange);
					break;
				case types.window:
					exchange.window.grant(windowAmount(frame.payload));
					break;
				case types.reset:
					validateReset(frame.payload);
					if (exchange.responseEnded) {
						const error = new Error("Agent stopped the request body");
						exchange.window.fail(error);
						exchange.abort.abort(error);
						exchange.requestEnded = true;
						this.complete(exchange);
					} else this.fail(exchange, new Error("Agent reset the stream"));
					break;
				default:
					throw new ProtocolError("Unexpected stream frame");
			}
		} catch {
			this.reset(exchange, "protocol", "Invalid stream frame");
		}
	}

	private open(request: Request, address: string): Promise<Response> {
		if (this.nextId > 0xffff_ffff) {
			this.shutdown();
			return Promise.resolve(errorResponse(503, "offline", "Reconnecting"));
		}
		const id = this.nextId++;
		const now = this.host.scheduler.now();
		return new Promise<Response>((resolve) => {
			const exchange: Exchange = {
				id,
				method: request.method,
				window: new SendWindow(this.limits.initialWindow),
				abort: new AbortController(),
				body: new ReceiveBody(
					this.limits.initialWindow,
					(size) => {
						if (this.exchanges.has(id)) this.send(types.window, id, windowBytes(size));
					},
					() => this.reset(exchange, "cancelled", "Response cancelled"),
					() => {
						exchange.responseConsumed = true;
						this.complete(exchange);
					},
				),
				resolve,
				head: false,
				requestEnded: false,
				responseEnded: false,
				responseConsumed: false,
				noBody: false,
				started: now,
				lastSeen: now,
				bytesIn: 0,
				bytesOut: 0,
				unlisten: () => request.signal.removeEventListener("abort", aborted),
			};
			const aborted = () => this.reset(exchange, "cancelled", "Request cancelled");
			this.exchanges.set(id, exchange);
			this.schedule();
			request.signal.addEventListener("abort", aborted, { once: true });
			if (request.signal.aborted) {
				aborted();
				return;
			}
			const url = new URL(request.url);
			const headers = forwardedHeaders(request.headers);
			headers.push(["x-forwarded-for", address], ["x-forwarded-proto", new URL(this.options.origin).protocol.slice(0, -1)], ["x-forwarded-host", url.host]);
			try {
				this.send(types.open, id, jsonBytes({ kind: "http", method: request.method, path: url.pathname + url.search, headers, remote: { address } }));
			} catch {
				this.fail(exchange, new Error("Request headers too large"));
				return;
			}
			void sendBody(
				request.body,
				exchange.window,
				this.limits.maxFrame,
				(bytes) => {
					this.send(types.data, id, bytes);
					exchange.bytesIn += bytes.length;
					exchange.lastSeen = this.host.scheduler.now();
				},
				exchange.abort.signal,
			)
				.then(() => {
					if (!this.exchanges.has(id)) return;
					this.send(types.end, id);
					exchange.requestEnded = true;
					this.complete(exchange);
				})
				.catch(() => {
					if (this.exchanges.has(id) && !exchange.requestEnded) this.reset(exchange, "internal", "Request failed");
				});
		});
	}

	private send(type: FrameType, stream: number, payload?: Uint8Array): void {
		const agent = this.current;
		if (!agent) throw new Error("Agent disconnected");
		if (payload && payload.length > this.limits.maxFrame) throw new ProtocolError("Frame too large");
		const frame = encodeFrame(type, stream, payload);
		try {
			agent.socket.send(frame);
		} catch (error) {
			this.close(agent, 1011, "Send failed");
			throw error;
		}
	}
	private reset(exchange: Exchange, code: string, reason: string): void {
		if (!this.exchanges.has(exchange.id)) return;
		try {
			this.send(types.reset, exchange.id, jsonBytes({ code, reason }));
		} catch {
			/* Connection cleanup already fails its streams. */
		}
		this.fail(exchange, new Error(reason));
	}
	private fail(exchange: Exchange, error: Error): void {
		if (!this.exchanges.has(exchange.id)) return;
		exchange.body.fail(error);
		exchange.window.fail(error);
		exchange.abort.abort(error);
		if (!exchange.head) exchange.resolve(errorResponse(502, "stream_failed", error.message));
		this.remove(exchange);
	}
	private complete(exchange: Exchange): void {
		if (exchange.requestEnded && exchange.responseEnded && exchange.responseConsumed) this.remove(exchange);
	}
	private remove(exchange: Exchange): void {
		if (!this.exchanges.delete(exchange.id)) return;
		exchange.unlisten();
		recordMeter(this.options, {
			deviceId: this.id,
			kind: "http",
			bytesIn: exchange.bytesIn,
			bytesOut: exchange.bytesOut,
			duration: this.host.scheduler.now() - exchange.started,
		});
	}
	private close(agent: Agent, code: number, reason: string): void {
		if (agent.closed) return;
		this.disconnected(agent);
		try {
			agent.socket.close(code, reason);
		} catch {
			/* Already closed by the host. */
		}
	}
	private disconnected(agent: Agent): void {
		if (agent.closed) return;
		agent.closed = true;
		this.agents.delete(agent);
		if (this.current === agent) {
			this.current = undefined;
			for (const exchange of this.exchanges.values()) this.fail(exchange, new Error("Agent disconnected"));
		}
		recordMeter(this.options, { deviceId: this.id, kind: "connection", bytesIn: 0, bytesOut: 0, duration: this.host.scheduler.now() - agent.started });
		if (!this.agents.size) {
			this.cancelTimer?.();
			this.cancelTimer = undefined;
		}
	}
	private schedule(): void {
		this.cancelTimer?.();
		this.cancelTimer = undefined;
		if (!this.agents.size) return;
		let deadline = Number.POSITIVE_INFINITY;
		for (const agent of this.agents) {
			deadline = Math.min(
				deadline,
				agent.authenticated ? Math.min(agent.lastPing + this.limits.pingInterval, agent.lastSeen + this.limits.pingInterval * 3) : agent.started + 10_000,
			);
		}
		for (const exchange of this.exchanges.values()) deadline = Math.min(deadline, exchange.lastSeen + this.limits.streamIdle);
		this.cancelTimer = this.host.scheduler.schedule(deadline, () => {
			this.cancelTimer = undefined;
			const now = this.host.scheduler.now();
			for (const agent of this.agents) {
				if (!agent.authenticated) {
					if (now - agent.started >= 10_000) this.close(agent, 4003, "Hello timeout");
					continue;
				}
				if (now - agent.lastSeen >= this.limits.pingInterval * 3) {
					this.close(agent, 1011, "Heartbeat timeout");
					continue;
				}
				if (now - agent.lastPing >= this.limits.pingInterval) {
					agent.lastPing = now;
					try {
						this.send(types.ping, 0, new Uint8Array(8));
					} catch {
						/* Send failure closes the connection. */
					}
				}
			}
			for (const exchange of this.exchanges.values()) {
				if (now - exchange.lastSeen >= this.limits.streamIdle) this.reset(exchange, "idle", "Stream idle");
			}
			if (this.agents.size) this.schedule();
		});
	}
}
