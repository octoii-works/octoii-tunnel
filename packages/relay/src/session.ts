/**
 * One device's session: the only owner of its connector connection and its streams. It authenticates the connector,
 * answers heartbeats, opens a stream per visitor request, and rebuilds itself from its sockets when its host wakes it.
 */
import {
	CLOSE_CODE,
	DEFAULT_LIMITS,
	checkLimits,
	decodeFrame,
	decodeHello,
	encodeFrame,
	encodeReset,
	encodeWelcome,
	FRAME_TYPE,
	type Frame,
	type FrameType,
	HELLO_TIMEOUT,
	hashCredential,
	isCredential,
	type Limits,
	MISSED_HEARTBEATS,
	PING,
	PONG,
	PROTOCOL_VERSION,
	ProtocolError,
	sameSecret,
} from "@octoii-works/tunnel/protocol";
import { authorize, errorResponse, meter, refusal } from "./hooks.ts";
import type { RelayOptions, RequestContext, SessionHost, SessionSocket } from "./host.ts";
import { HttpStream } from "./http-stream.ts";
import { WebSocketStream, type WebSocketLink } from "./websocket-stream.ts";

/** The most connector connections that may wait to authenticate at once. */
const MAX_PENDING_CONNECTIONS = 4;
/** Bytes a connector socket may have waiting beyond what flow control allows, for control frames. */
const SOCKET_BUFFER_SLACK = 1024 * 1024;

/** The authenticated connector connection. */
type Connector = { readonly socket: SessionSocket; readonly connectedAt: number; heartbeatAt: number };

/** A connector connection that has not authenticated yet. */
type Pending = { readonly cancelTimeout: () => void; authenticating: boolean };

/** A stream of either kind. */
type Stream = HttpStream | WebSocketStream;

/** One device's session on the relay. */
export class DeviceSession {
	readonly deviceId: string;
	private readonly host: SessionHost;
	private readonly options: RelayOptions;
	private readonly limits: Limits;
	private readonly origin: URL;
	private readonly pending = new Map<SessionSocket, Pending>();
	private readonly streams = new Map<number, Stream>();
	private readonly link: WebSocketLink & { done: (stream: Stream) => void };
	private connector: Connector | undefined;
	private nextStream = 1;
	private stopSweep: (() => void) | undefined;
	private removed = false;
	/** Bumped by every change that must cancel an authentication in flight. */
	private revision = 0;

	constructor(deviceId: string, host: SessionHost, options: RelayOptions) {
		this.deviceId = deviceId;
		this.host = host;
		this.options = options;
		this.limits = checkLimits({ ...DEFAULT_LIMITS, ...options.limits });
		this.origin = new URL(options.origin);
		this.link = {
			limits: this.limits,
			send: (type, stream, payload) => this.send(type, stream, payload),
			now: () => this.host.clock.now(),
			setTimer: (callback, delayMs) => this.host.clock.setTimer(callback, delayMs),
			done: (stream: Stream) => this.streamDone(stream),
		};
	}

	/**
	 * Rebuilds the session from the host's live sockets after the host woke it: the authenticated connector connection,
	 * then each visitor's WebSocket, whose stream starts again with its full credit as a quiet stream has it.
	 */
	resume(): void {
		const sockets = this.host.sockets.live();
		for (const socket of sockets) {
			const attachment = socket.attachment();
			if (attachment?.role !== "connector") continue;
			if (attachment.authenticated && this.connector === undefined) {
				this.connector = { socket, connectedAt: attachment.welcomedAt, heartbeatAt: attachment.welcomedAt };
				this.nextStream = attachment.nextStream;
			} else {
				// A connection that had not authenticated cannot continue safely; its connector reconnects.
				socket.close(CLOSE_CODE.HELLO_TIMEOUT, "Authenticate again");
			}
		}
		for (const socket of sockets) {
			const attachment = socket.attachment();
			if (attachment?.role !== "visitor") continue;
			if (this.connector === undefined) socket.close(1011, "The device's connection ended");
			else this.streams.set(attachment.stream, WebSocketStream.resumed(attachment.stream, socket, this.link));
		}
	}

	/** Answers a request for this device: its removal, its connector's upgrade, or a visitor's stream. */
	async fetch(request: Request, context: RequestContext): Promise<Response | undefined> {
		const record = await this.host.records.get();
		if (record === undefined || this.removed) return errorResponse("not_found", "Unknown device");
		const url = new URL(request.url);
		if (url.host !== this.origin.host) return this.visit(request, context);
		if (url.pathname === `/v1/devices/${this.deviceId}` && request.method === "DELETE") return this.remove(request, record.credentialHash);
		if (url.pathname === `/v1/connect/${this.deviceId}` && request.method === "GET") return this.connect(request, context);
		return errorResponse("not_found", "Unknown route");
	}

	/**
	 * A socket the host opened after `acceptWebSocket`: a connector connection, which has `HELLO_TIMEOUT` to
	 * authenticate, or a visitor's WebSocket, which joins its stream.
	 */
	opened(socket: SessionSocket): void {
		const attachment = socket.attachment();
		if (attachment?.role === "visitor") {
			const stream = this.streams.get(attachment.stream);
			if (stream instanceof WebSocketStream) stream.attach(socket);
			else socket.close(1011, "The stream ended");
			return;
		}
		const cancelTimeout = this.host.clock.setTimer(() => this.close(socket, CLOSE_CODE.HELLO_TIMEOUT, "No hello in time"), HELLO_TIMEOUT);
		this.pending.set(socket, { cancelTimeout, authenticating: false });
	}

	/** Handles a message on one of the session's sockets. */
	async message(socket: SessionSocket, data: Uint8Array | string): Promise<void> {
		const attachment = socket.attachment();
		if (attachment?.role === "visitor") {
			const stream = this.streams.get(attachment.stream);
			if (stream instanceof WebSocketStream) stream.fromVisitor(data);
			return;
		}
		// Any message from the connector shows it is there, as a heartbeat does.
		if (this.connector?.socket === socket) this.connector.heartbeatAt = this.host.clock.now();
		if (typeof data === "string") return this.text(socket, data);
		let frame: Frame;
		try {
			frame = decodeFrame(data, this.limits.maxFrame);
		} catch {
			return this.close(socket, CLOSE_CODE.MALFORMED, "Malformed frame");
		}
		const pending = this.pending.get(socket);
		if (pending !== undefined) return this.authenticate(socket, pending, frame);
		if (this.connector?.socket === socket) this.receive(frame);
	}

	/** One of the session's sockets closed, with the close code and reason the host saw. */
	closed(socket: SessionSocket, code = 1005, reason = ""): void {
		const attachment = socket.attachment();
		if (attachment?.role === "visitor") {
			const stream = this.streams.get(attachment.stream);
			if (stream instanceof WebSocketStream) stream.visitorClosed(code, reason);
			return;
		}
		const pending = this.pending.get(socket);
		if (pending !== undefined) {
			pending.cancelTimeout();
			this.pending.delete(socket);
		}
		if (this.connector?.socket !== socket) return;
		const { connectedAt } = this.connector;
		this.connector = undefined;
		for (const stream of this.streams.values()) stream.fail(new Error("The connector disconnected"));
		meter(this.options, { deviceId: this.deviceId, kind: "connection", bytesIn: 0, bytesOut: 0, duration: this.host.clock.now() - connectedAt });
	}

	/** Closes every connection, with 1012 unless told otherwise, so connectors reconnect. */
	shutdown(code: number = CLOSE_CODE.RESTART, reason = "The relay is restarting"): void {
		for (const socket of this.pending.keys()) this.close(socket, code, reason);
		if (this.connector !== undefined) this.close(this.connector.socket, code, reason);
	}

	private async remove(request: Request, credentialHash: string): Promise<Response> {
		const credential = request.headers.get("authorization")?.replace(/^Bearer /, "");
		if (!isCredential(credential) || !sameSecret(hashCredential(credential), credentialHash)) {
			return errorResponse("unauthorized", "Invalid credential");
		}
		this.removed = true;
		this.revision++;
		try {
			await this.host.records.delete();
		} catch (error) {
			this.removed = false;
			throw error;
		}
		this.shutdown(CLOSE_CODE.UNAUTHORIZED, "The device was removed");
		return new Response(null, { status: 204 });
	}

	private connect(request: Request, context: RequestContext): Response | undefined {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return errorResponse("upgrade_required", "A connector connects with a WebSocket");
		if (this.pending.size >= MAX_PENDING_CONNECTIONS) return errorResponse("quota", "Too many connections waiting to authenticate");
		return context.acceptWebSocket({ role: "connector", authenticated: false, nextStream: 1, welcomedAt: 0 });
	}

	private async visit(request: Request, context: RequestContext): Promise<Response | undefined> {
		const decision = await authorize(this.options, { kind: "visitor", deviceId: this.deviceId, request });
		if (!decision.allowed) return refusal(decision, "Stream refused");
		if (!this.connectorAlive()) return errorResponse("offline", "The device is offline");
		if (this.streams.size >= this.limits.maxStreams) return errorResponse("busy", "Too many open streams", { "retry-after": "1" });
		const upgrade = request.headers.get("upgrade");
		if (upgrade === null) return this.visitHttp(request, context.address);
		if (upgrade.toLowerCase() !== "websocket") return errorResponse("invalid", "Only WebSocket upgrades are carried");
		return this.visitWebSocket(request, context);
	}

	private async visitWebSocket(request: Request, context: RequestContext): Promise<Response | undefined> {
		const stream = new WebSocketStream(this.takeStreamId(), this.link);
		this.streams.set(stream.id, stream);
		try {
			stream.start(request, context.address, this.origin);
		} catch {
			stream.fail(new Error("The stream could not be opened"));
		}
		const answer = await stream.answer;
		if ("failed" in answer)
			return answer.failed === "timeout" ? errorResponse("timeout", "The device did not answer") : errorResponse("offline", "The device is offline");
		if (!answer.accept) return new Response("The device refused the WebSocket", { status: answer.status });
		return context.acceptWebSocket({ role: "visitor", stream: stream.id }, answer.protocol);
	}

	private visitHttp(request: Request, address: string): Promise<Response> {
		const stream = new HttpStream(this.takeStreamId(), request.method, this.link);
		this.streams.set(stream.id, stream);
		this.startSweep();
		try {
			stream.start(request, address, this.origin);
		} catch {
			stream.fail(new Error("The stream could not be opened"));
		}
		return stream.response;
	}

	/** Whether a connector is connected and has sent a heartbeat lately; closes it when its heartbeats stopped. */
	private connectorAlive(): boolean {
		const connector = this.connector;
		if (connector === undefined) return false;
		const answered = this.host.sockets.lastHeartbeat(connector.socket) ?? 0;
		const lastHeartbeat = Math.max(connector.heartbeatAt, answered);
		if (this.host.clock.now() - lastHeartbeat <= MISSED_HEARTBEATS * this.limits.heartbeat) return true;
		this.close(connector.socket, CLOSE_CODE.INTERNAL_ERROR, "No heartbeat");
		return false;
	}

	private takeStreamId(): number {
		const id = this.nextStream++;
		const connector = this.connector;
		const attachment = connector?.socket.attachment();
		if (connector !== undefined && attachment?.role === "connector") connector.socket.attach({ ...attachment, nextStream: this.nextStream });
		return id;
	}

	private text(socket: SessionSocket, text: string): void {
		const connector = this.connector;
		if (text !== PING || connector?.socket !== socket) return this.close(socket, CLOSE_CODE.MALFORMED, "Unexpected text message");
		socket.sendText(PONG);
	}

	private async authenticate(socket: SessionSocket, pending: Pending, frame: Frame): Promise<void> {
		if (pending.authenticating || frame.type !== FRAME_TYPE.HELLO) return this.close(socket, CLOSE_CODE.MALFORMED, "Expected hello");
		pending.authenticating = true;
		let credential: string;
		try {
			const hello = decodeHello(frame.payload);
			if (hello.version !== PROTOCOL_VERSION) return this.close(socket, CLOSE_CODE.UNSUPPORTED_VERSION, "Unsupported version");
			credential = hello.credential;
		} catch {
			return this.close(socket, CLOSE_CODE.MALFORMED, "Malformed hello");
		}
		const revision = this.revision;
		const record = await this.host.records.get();
		if (record === undefined || this.removed || !sameSecret(hashCredential(credential), record.credentialHash)) {
			return this.close(socket, CLOSE_CODE.UNAUTHORIZED, "Invalid credential");
		}
		const decision = await authorize(this.options, { kind: "connector", deviceId: this.deviceId });
		if (!decision.allowed || revision !== this.revision || !this.pending.has(socket)) {
			return this.close(socket, CLOSE_CODE.UNAUTHORIZED, "Connection refused");
		}
		this.welcome(socket, pending);
	}

	private welcome(socket: SessionSocket, pending: Pending): void {
		pending.cancelTimeout();
		this.pending.delete(socket);
		if (this.connector !== undefined) this.close(this.connector.socket, CLOSE_CODE.REPLACED, "Replaced by a newer connection");
		const now = this.host.clock.now();
		this.connector = { socket, connectedAt: now, heartbeatAt: now };
		this.nextStream = 1;
		socket.attach({ role: "connector", authenticated: true, nextStream: 1, welcomedAt: now });
		socket.send(encodeFrame(FRAME_TYPE.WELCOME, 0, encodeWelcome(this.limits)));
	}

	private receive(frame: Frame): void {
		if (frame.type === FRAME_TYPE.HELLO || frame.type === FRAME_TYPE.WELCOME || frame.type === FRAME_TYPE.OPEN) {
			const socket = this.connector?.socket;
			if (socket !== undefined) this.close(socket, CLOSE_CODE.MALFORMED, "Unexpected frame");
			return;
		}
		const stream = this.streams.get(frame.stream);
		if (stream !== undefined) return stream.receive(frame);
		if (frame.type !== FRAME_TYPE.RESET) this.send(FRAME_TYPE.RESET, frame.stream, encodeReset({ code: "cancelled", reason: "Unknown stream" }));
	}

	private send(type: FrameType, stream: number, payload?: Uint8Array): void {
		const connector = this.connector;
		if (connector === undefined) throw new Error("The connector disconnected");
		if (payload !== undefined && payload.length > this.limits.maxFrame) throw new ProtocolError("Frame too large");
		if (connector.socket.bufferedAmount() > this.limits.maxStreams * this.limits.initialCredit + SOCKET_BUFFER_SLACK) {
			this.close(connector.socket, CLOSE_CODE.INTERNAL_ERROR, "Send buffer full");
			throw new Error("The connector's send buffer is full");
		}
		connector.socket.send(encodeFrame(type, stream, payload));
	}

	private streamDone(stream: Stream): void {
		if (!this.streams.delete(stream.id)) return;
		meter(this.options, {
			deviceId: this.deviceId,
			kind: stream instanceof HttpStream ? "http" : "websocket",
			bytesIn: stream.bytesIn,
			bytesOut: stream.bytesOut,
			duration: this.host.clock.now() - stream.startedAt,
		});
		if (![...this.streams.values()].some((candidate) => candidate instanceof HttpStream)) this.stopSweeping();
	}

	/** Checks for idle HTTP streams every quarter of `streamIdle` while any is open; WebSocket streams have no idle limit. */
	private startSweep(): void {
		if (this.stopSweep !== undefined) return;
		this.stopSweep = this.host.clock.setTimer(() => {
			this.stopSweep = undefined;
			const now = this.host.clock.now();
			for (const stream of this.streams.values()) {
				if (stream instanceof HttpStream && stream.idleAt(now, this.limits.streamIdle)) stream.reset("idle", "The stream was idle");
			}
			if ([...this.streams.values()].some((stream) => stream instanceof HttpStream)) this.startSweep();
		}, this.limits.streamIdle / 4);
	}

	private stopSweeping(): void {
		this.stopSweep?.();
		this.stopSweep = undefined;
	}

	private close(socket: SessionSocket, code: number, reason: string): void {
		try {
			socket.close(code, reason);
		} catch {
			// The host closed it already.
		}
		this.closed(socket);
	}
}
