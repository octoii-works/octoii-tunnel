import { relayOrigin, type Device } from "./device.ts";
import {
	decodeFrame,
	defaultLimits,
	encodeFrame,
	forwardedHeaders,
	jsonBytes,
	MAX_BUFFER,
	parseLimits,
	parseOpen,
	ProtocolError,
	ReceiveBody,
	SendWindow,
	sendBody,
	types,
	validDeviceId,
	validateReset,
	windowAmount,
	windowBytes,
	type Frame,
	type FrameType,
	type Limits,
} from "./protocol/index.ts";

export interface AgentOptions {
	relay: string;
	device: Device;
	handler: (request: Request) => Response | Promise<Response>;
	onError?: (error: Error) => void;
}
export interface AgentHandle {
	ready: Promise<void>;
	closed: Promise<void>;
	close(): void;
}
interface RequestStream {
	id: number;
	body: ReceiveBody;
	window: SendWindow;
	abort: AbortController;
	requestEnded: boolean;
	responseEnded: boolean;
	lastSeen: number;
}

export function connectAgent(options: AgentOptions): AgentHandle {
	if (!validDeviceId(options.device.deviceId)) throw new Error("Invalid device id");
	if (!/^[A-Za-z0-9_-]{43}$/.test(options.device.credential)) throw new Error("Invalid device credential");
	const url = new URL(`/v1/agent/${options.device.deviceId}`, relayOrigin(options.relay));
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	const expectedAddress = relayOrigin(options.relay);
	expectedAddress.hostname = `${options.device.deviceId}.${expectedAddress.hostname}`;
	if (options.device.address !== expectedAddress.origin) throw new Error("Unexpected device address");
	let socket: WebSocket | undefined;
	let stopped = false;
	let readyOnce = false;
	let welcomed = false;
	let attempt = 0;
	let openedAt = 0;
	let lastSeen = 0;
	let lastPing = 0;
	let limits: Limits = defaultLimits;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let readyResolve!: () => void;
	let readyReject!: (error: Error) => void;
	let closedResolve!: () => void;
	const ready = new Promise<void>((resolve, reject) => {
		readyResolve = resolve;
		readyReject = reject;
	});
	const closed = new Promise<void>((resolve) => {
		closedResolve = resolve;
	});
	const streams = new Map<number, RequestStream>();
	const report = (error: Error) => {
		try {
			options.onError?.(error);
		} catch {
			/* A callback cannot interrupt cleanup. */
		}
	};

	function send(type: FrameType, stream: number, payload?: Uint8Array): void {
		if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Relay disconnected");
		if (payload && payload.length > limits.maxFrame) throw new ProtocolError("Frame too large");
		const bytes = encodeFrame(type, stream, payload);
		if (socket.bufferedAmount + bytes.length > MAX_BUFFER) throw new Error("Connection send buffer exceeded");
		socket.send(bytes);
	}
	function fail(stream: RequestStream, error: Error): void {
		streams.delete(stream.id);
		stream.window.fail(error);
		stream.body.fail(error);
		stream.abort.abort(error);
	}
	function reset(stream: RequestStream, code: string): void {
		if (!streams.has(stream.id)) return;
		try {
			send(types.reset, stream.id, jsonBytes({ code, reason: "Stream ended" }));
		} catch {
			socket?.close(4004, "Send failed");
		}
		fail(stream, new Error(code));
	}
	function cleanup(): void {
		clearInterval(heartbeat);
		heartbeat = undefined;
		for (const stream of streams.values()) fail(stream, new Error("Relay disconnected"));
	}
	function finish(): void {
		stopped = true;
		clearTimeout(timer);
		cleanup();
		if (!readyOnce) readyReject(new Error("Agent stopped before connecting"));
		closedResolve();
	}

	async function serve(stream: RequestStream, payload: Uint8Array): Promise<void> {
		try {
			const open = parseOpen(payload);
			if (open.kind !== "http") throw new ProtocolError("Unsupported stream kind");
			const noBody = open.method === "GET" || open.method === "HEAD";
			const init = { method: open.method, headers: open.headers, signal: stream.abort.signal, ...(noBody ? {} : { body: stream.body.stream, duplex: "half" }) };
			const request = new Request(options.device.address + open.path, init);
			const response =
				new URL(request.url).pathname === "/.takotunnel/secure"
					? new Response("Secure channels are not implemented", { status: 501 })
					: await options.handler(request);
			if (stream.abort.signal.aborted) {
				await response.body?.cancel();
				return;
			}
			send(types.head, stream.id, jsonBytes({ status: response.status, headers: forwardedHeaders(response.headers) }));
			if (open.method === "HEAD") await response.body?.cancel();
			else
				await sendBody(
					response.body,
					stream.window,
					limits.maxFrame,
					(bytes) => {
						send(types.data, stream.id, bytes);
						stream.lastSeen = Date.now();
					},
					stream.abort.signal,
				);
			if (!streams.has(stream.id)) return;
			send(types.end, stream.id);
			stream.responseEnded = true;
			if (stream.requestEnded) {
				streams.delete(stream.id);
				stream.body.fail(new Error("Handler completed"));
			} else reset(stream, "cancelled");
		} catch {
			if (streams.has(stream.id)) reset(stream, "internal");
		}
	}

	function receive(frame: Frame): void {
		if (!welcomed) {
			if (frame.type !== types.welcome) throw new ProtocolError("Expected welcome");
			limits = parseLimits(frame.payload);
			welcomed = true;
			openedAt = Date.now();
			readyOnce = true;
			readyResolve();
			return;
		}
		if (frame.type === types.ping) {
			send(types.pong, 0, frame.payload);
			return;
		}
		if (frame.type === types.pong) return;
		if (!frame.stream) throw new ProtocolError("Unexpected connection frame");
		if (frame.type === types.open) {
			if (streams.has(frame.stream) || streams.size >= limits.maxStreams) throw new ProtocolError("Invalid open");
			const stream: RequestStream = {
				id: frame.stream,
				window: new SendWindow(limits.initialWindow),
				abort: new AbortController(),
				body: new ReceiveBody(
					limits.initialWindow,
					(size) => {
						if (streams.has(frame.stream)) send(types.window, frame.stream, windowBytes(size));
					},
					() => reset(stream, "cancelled"),
				),
				requestEnded: false,
				responseEnded: false,
				lastSeen: Date.now(),
			};
			streams.set(frame.stream, stream);
			void serve(stream, frame.payload);
			return;
		}
		const stream = streams.get(frame.stream);
		if (!stream) {
			if (frame.type !== types.reset) send(types.reset, frame.stream, jsonBytes({ code: "cancelled", reason: "Unknown stream" }));
			return;
		}
		stream.lastSeen = Date.now();
		try {
			switch (frame.type) {
				case types.data:
					stream.body.push(frame.payload);
					break;
				case types.end:
					if (frame.payload.length) throw new ProtocolError("Invalid end");
					stream.body.end();
					stream.requestEnded = true;
					if (stream.responseEnded) streams.delete(stream.id);
					break;
				case types.window:
					stream.window.grant(windowAmount(frame.payload));
					break;
				case types.reset:
					validateReset(frame.payload);
					fail(stream, new Error("Stream reset"));
					break;
				default:
					throw new ProtocolError("Unexpected stream frame");
			}
		} catch {
			reset(stream, "protocol");
		}
	}

	function connect(): void {
		if (stopped) return;
		welcomed = false;
		limits = defaultLimits;
		const connection = new WebSocket(url);
		socket = connection;
		connection.binaryType = "arraybuffer";
		lastSeen = Date.now();
		lastPing = lastSeen;
		connection.addEventListener("open", () => {
			if (stopped) {
				connection.close(1000);
				return;
			}
			send(types.hello, 0, jsonBytes({ version: 1, credential: options.device.credential, agent: "takotunnel/0.0.0" }));
		});
		connection.addEventListener("message", (event) => {
			try {
				if (!(event.data instanceof ArrayBuffer)) throw new ProtocolError("Expected binary frame");
				lastSeen = Date.now();
				receive(decodeFrame(new Uint8Array(event.data), limits.maxFrame));
			} catch {
				report(new Error("Invalid relay frame"));
				connection.close(4004, "Invalid frame");
			}
		});
		connection.addEventListener("error", () => report(new Error("Relay connection failed")));
		connection.addEventListener("close", (event) => {
			cleanup();
			if (stopped || [1000, 4000, 4001, 4002].includes(event.code)) {
				if (event.code !== 1000) report(new Error(`Agent connection closed (${event.code})`));
				finish();
				return;
			}
			if (welcomed && Date.now() - openedAt >= 60_000) attempt = 0;
			const cap = Math.min(60_000, 1000 * 2 ** Math.min(attempt++, 6));
			timer = setTimeout(connect, Math.random() * cap);
		});
		heartbeat = setInterval(() => {
			const now = Date.now();
			if ((!welcomed && now - lastSeen >= 10_000) || now - lastSeen >= limits.pingInterval * 3) {
				connection.close(4003, "Connection timeout");
				return;
			}
			if (welcomed && now - lastPing >= limits.pingInterval) {
				lastPing = now;
				try {
					send(types.ping, 0, new Uint8Array(8));
				} catch {
					connection.close(4004, "Send failed");
				}
			}
			for (const stream of streams.values()) if (now - stream.lastSeen >= limits.streamIdle) reset(stream, "idle");
		}, 1000);
	}
	connect();
	return {
		ready,
		closed,
		close: () => {
			if (stopped) return;
			finish();
			socket?.close(1000, "Agent stopped");
		},
	};
}
