/**
 * One connector connection: it authenticates with `hello`, waits for `welcome`, sends a heartbeat every interval, and
 * gives up on a connection that answers nothing for three.
 */
import {
	CLOSE_CODE,
	DEFAULT_LIMITS,
	decodeFrame,
	decodeWelcome,
	encodeFrame,
	encodeHello,
	FRAME_TYPE,
	type Frame,
	type FrameType,
	HELLO_TIMEOUT,
	type Limits,
	MAX_FRAME_SIZE,
	MISSED_HEARTBEATS,
	PING,
	PONG,
	PROTOCOL_VERSION,
	ProtocolError,
} from "./protocol/index.ts";
import { type Clock, repeat } from "./platform.ts";

/** What a connection tells its connector. */
export type ConnectionEvents = {
	/** The relay accepted the connection, with these limits. */
	readonly welcomed: (limits: Limits) => void;
	/** A stream frame arrived. */
	readonly frame: (frame: Frame) => void;
	/** The connection closed, with this code. */
	readonly closed: (code: number) => void;
	/** Something went wrong that the connector may report. */
	readonly error: (error: Error) => void;
};

/** How the connector names itself in `hello`. */
const CONNECTOR_NAME = "octoiitunnel/0.0.0";
/** Bytes the socket may have waiting beyond what flow control allows, for control frames. */
const SOCKET_BUFFER_SLACK = 1024 * 1024;
/** How often the connection checks whether a heartbeat is due, or the relay has gone silent. */
const HEARTBEAT_CHECK_INTERVAL = 1000;

/** One WebSocket from the connector to the relay. */
export class ConnectorConnection {
	/** The relay's limits; the defaults until `welcome`. */
	limits: Limits = DEFAULT_LIMITS;
	private readonly socket: WebSocket;
	private readonly events: ConnectionEvents;
	private readonly clock: Clock;
	private welcomed = false;
	private lastHeard: number;
	private lastPing = 0;
	private readonly stopHeartbeat: () => void;

	constructor(url: string, credential: string, clock: Clock, events: ConnectionEvents) {
		this.events = events;
		this.clock = clock;
		this.lastHeard = clock.now();
		this.socket = new WebSocket(url);
		this.socket.binaryType = "arraybuffer";
		this.socket.addEventListener("open", () =>
			this.socket.send(encodeFrame(FRAME_TYPE.HELLO, 0, encodeHello({ version: PROTOCOL_VERSION, credential, connector: CONNECTOR_NAME }))),
		);
		this.socket.addEventListener("message", (event) => this.message(event.data));
		this.socket.addEventListener("error", () => this.events.error(new Error("The relay connection failed")));
		this.socket.addEventListener("close", (event) => {
			this.stopHeartbeat();
			this.events.closed(event.code);
		});
		this.stopHeartbeat = repeat(clock, () => this.checkHeartbeat(), HEARTBEAT_CHECK_INTERVAL);
	}

	/** Sends a stream frame; throws when the connection is not open or its send buffer is full. */
	send(type: FrameType, stream: number, payload?: Uint8Array): void {
		if (this.socket.readyState !== WebSocket.OPEN || !this.welcomed) throw new Error("The relay connection is not open");
		if (payload !== undefined && payload.length > this.limits.maxFrame) throw new ProtocolError("Frame too large");
		if (this.socket.bufferedAmount > this.limits.maxStreams * this.limits.initialCredit + SOCKET_BUFFER_SLACK) {
			this.close(CLOSE_CODE.GOING_AWAY, "Send buffer full");
			throw new Error("The relay connection's send buffer is full");
		}
		this.socket.send(encodeFrame(type, stream, payload));
	}

	close(code: number, reason: string): void {
		this.stopHeartbeat();
		this.socket.close(code, reason);
	}

	private message(data: unknown): void {
		this.lastHeard = this.clock.now();
		if (data === PONG) return;
		try {
			if (!(data instanceof ArrayBuffer)) throw new ProtocolError("Unexpected text message");
			this.receive(decodeFrame(new Uint8Array(data), this.welcomed ? this.limits.maxFrame : MAX_FRAME_SIZE));
		} catch (error) {
			this.events.error(error instanceof Error ? error : new Error("Invalid relay message"));
			this.close(CLOSE_CODE.MALFORMED, "Malformed message");
		}
	}

	private receive(frame: Frame): void {
		if (this.welcomed) return this.events.frame(frame);
		if (frame.type !== FRAME_TYPE.WELCOME) throw new ProtocolError("Expected welcome");
		this.limits = decodeWelcome(frame.payload);
		this.welcomed = true;
		this.events.welcomed(this.limits);
	}

	/**
	 * Sends a heartbeat every interval, busy or not, so the relay always knows the connector is there; and gives up on a
	 * relay that has been silent too long.
	 */
	private checkHeartbeat(): void {
		const now = this.clock.now();
		const limit = this.welcomed ? MISSED_HEARTBEATS * this.limits.heartbeat : HELLO_TIMEOUT;
		if (now - this.lastHeard >= limit) return this.close(CLOSE_CODE.GOING_AWAY, "The relay stopped answering");
		if (!this.welcomed || now - this.lastPing < this.limits.heartbeat || this.socket.readyState !== WebSocket.OPEN) return;
		this.lastPing = now;
		this.socket.send(PING);
	}
}
