/**
 * A device's connector: it keeps a connector connection to the relay, reconnecting with backoff, and serves each
 * stream the relay opens through the service's handler.
 */
import {
	CLOSE_CODE,
	connectPath,
	decodeOpen,
	encodeReset,
	FINAL_CLOSE_CODES,
	FRAME_TYPE,
	type Frame,
	type FrameType,
	isCredential,
	isDeviceId,
	parseRelayOrigin,
	SECURE_PATH,
	deviceAddress,
} from "@klein-works/takotunnel-protocol";
import { reconnectDelay, STABLE_CONNECTION } from "./backoff.ts";
import { ConnectorConnection } from "./connection.ts";
import type { Device } from "./device.ts";
import { type Handler, ServedHttpStream } from "./http-stream.ts";
import { ServedWebSocketStream, type TunnelSocket, type WebSocketHandler } from "./websocket-stream.ts";
import type { SecureChannel } from "./secure/channel.ts";
import { respond } from "./secure/handshake.ts";
import { type PairingOffer, PairingOffers } from "./secure/offers.ts";
import { forgetVisitor, type PairingStore, staticKeyOf } from "./secure/store.ts";

/** How a connector is set up. */
export type ConnectorOptions = {
	/** The relay's origin, such as `https://takotunnel.dev`. */
	readonly relay: string;
	readonly device: Device;
	/** Answers each visitor's request. */
	readonly handler: Handler;
	/** Accepts or refuses each visitor's WebSocket; without it, WebSockets are refused. */
	readonly websocket?: WebSocketHandler;
	/** Where the connector keeps its key and the visitors it paired with; without it, there is no secure mode. */
	readonly store?: PairingStore;
	/** Hears about failures the connector recovers from or stops on. */
	readonly onError?: (error: Error) => void;
};

/** Starts a device's connector. */
export function connectDevice(options: ConnectorOptions): Connector {
	return new Connector(options);
}

/** A device's connector, connected to its relay until `close`. */
export class Connector {
	/** Settles when the relay first accepts the connector; rejects if it stops before. */
	readonly ready: Promise<void>;
	/** Settles when the connector stops for good: closed, replaced, or refused. */
	readonly closed: Promise<void>;
	private readonly options: ConnectorOptions;
	private readonly url: string;
	private readonly address: string;
	private readonly streams = new Map<number, ServedHttpStream | ServedWebSocketStream>();
	private readonly offers = new PairingOffers();
	private readonly channelListeners = new Set<(channel: SecureChannel) => void>();
	private connection: ConnectorConnection | undefined;
	private connectedAt = 0;
	private attempt = 0;
	private stopped = false;
	private reconnect: ReturnType<typeof setTimeout> | undefined;
	private sweep: ReturnType<typeof setInterval> | undefined;
	private settleReady: { resolve: () => void; reject: (error: Error) => void } | undefined;
	private settleClosed: () => void = () => undefined;

	constructor(options: ConnectorOptions) {
		const { deviceId, credential, address } = options.device;
		const relay = parseRelayOrigin(options.relay);
		if (!isDeviceId(deviceId) || !isCredential(credential) || address !== deviceAddress(relay, deviceId)) throw new Error("Not a device of this relay");
		this.options = options;
		this.address = address;
		this.url = `${relay.scheme === "https" ? "wss" : "ws"}://${relay.host}${connectPath(deviceId)}`;
		this.ready = new Promise((resolve, reject) => {
			this.settleReady = { resolve, reject };
		});
		this.closed = new Promise((resolve) => {
			this.settleClosed = resolve;
		});
		this.connect();
	}

	/** A pairing offer to show a visitor, usually as a QR code; it works once, for five minutes. */
	async offerPairing(): Promise<PairingOffer> {
		const store = this.requireStore();
		return this.offers.create(this.address, (await staticKeyOf(store)).publicKey);
	}

	/** Calls `listener` with each secure channel a paired visitor opens; returns what stops it. */
	onSecureChannel(listener: (channel: SecureChannel) => void): () => void {
		this.channelListeners.add(listener);
		return () => this.channelListeners.delete(listener);
	}

	/** Forgets a paired visitor: its next channel is refused. */
	async forgetVisitor(publicKey: string): Promise<void> {
		await forgetVisitor(this.requireStore(), publicKey);
	}

	/** Stops the connector and closes its connection. */
	close(): void {
		if (this.stopped) return;
		this.connection?.close(CLOSE_CODE.NORMAL, "The connector stopped");
		this.stop();
	}

	private connect(): void {
		if (this.stopped) return;
		this.connection = new ConnectorConnection(this.url, this.options.device.credential, {
			welcomed: () => {
				this.connectedAt = Date.now();
				this.settleReady?.resolve();
				this.settleReady = undefined;
			},
			frame: (frame) => this.receive(frame),
			closed: (code) => this.connectionClosed(code),
			error: (error) => this.report(error),
		});
	}

	private connectionClosed(code: number): void {
		this.connection = undefined;
		for (const stream of this.streams.values()) stream.fail(new Error("The relay connection closed"));
		if (this.stopped) return;
		if (FINAL_CLOSE_CODES.has(code)) {
			if (code !== CLOSE_CODE.NORMAL) this.report(new Error(`The relay closed the connector for good (${code})`));
			return this.stop();
		}
		if (this.connectedAt !== 0 && Date.now() - this.connectedAt >= STABLE_CONNECTION) this.attempt = 0;
		this.connectedAt = 0;
		this.reconnect = setTimeout(() => this.connect(), reconnectDelay(this.attempt++));
	}

	private receive(frame: Frame): void {
		const connection = this.connection;
		if (connection === undefined) return;
		const existing = this.streams.get(frame.stream);
		if (existing !== undefined) return existing.receive(frame);
		if (frame.type !== FRAME_TYPE.OPEN) {
			if (frame.type !== FRAME_TYPE.RESET) this.trySend(connection, frame.stream, "Unknown stream");
			return;
		}
		if (this.streams.size >= connection.limits.maxStreams) return this.trySend(connection, frame.stream, "Too many streams");
		const open = decodeOpen(frame.payload);
		const link = this.linkFor(connection);
		const stream = open.kind === "http" ? new ServedHttpStream(frame.stream, open, link) : new ServedWebSocketStream(frame.stream, open, link);
		this.streams.set(stream.id, stream);
		if (stream instanceof ServedHttpStream) this.startSweep(connection);
		stream.start();
	}

	private linkFor(connection: ConnectorConnection) {
		return {
			limits: connection.limits,
			address: this.address,
			handler: this.options.handler,
			websocket: (request: Request, accept: (protocol?: string) => TunnelSocket) => this.websocket(request, accept),
			send: (type: FrameType, stream: number, payload?: Uint8Array) => connection.send(type, stream, payload),
			done: (stream: ServedHttpStream | ServedWebSocketStream) => {
				this.streams.delete(stream.id);
				if (![...this.streams.values()].some((candidate) => candidate instanceof ServedHttpStream)) this.stopSweep();
			},
		};
	}

	/** A visitor's WebSocket: the secure path runs a handshake, any other goes to the service's handler. */
	private websocket(request: Request, accept: (protocol?: string) => TunnelSocket): void | Response | Promise<void | Response> {
		if (new URL(request.url).pathname !== SECURE_PATH) return this.options.websocket?.(request, accept) ?? new Response(null, { status: 501 });
		const store = this.options.store;
		if (store === undefined) return new Response(null, { status: 501 });
		return staticKeyOf(store).then((key) => {
			respond(accept(), {
				key,
				store,
				offers: this.offers,
				address: this.address,
				handler: this.options.handler,
				accepted: (channel) => {
					for (const listener of this.channelListeners) listener(channel);
				},
			});
		});
	}

	private requireStore(): PairingStore {
		if (this.options.store === undefined) throw new Error("Secure mode needs a pairing store");
		return this.options.store;
	}

	/** Resets an unknown or refused stream, ignoring a connection that is already gone. */
	private trySend(connection: ConnectorConnection, stream: number, reason: string): void {
		try {
			connection.send(FRAME_TYPE.RESET, stream, encodeReset({ code: "refused", reason }));
		} catch {
			// The connection closed; there is nothing to refuse on.
		}
	}

	/** Resets idle HTTP streams, checking every quarter of `streamIdle` while any is open. */
	private startSweep(connection: ConnectorConnection): void {
		if (this.sweep !== undefined) return;
		const { streamIdle } = connection.limits;
		this.sweep = setInterval(() => {
			const now = Date.now();
			for (const stream of this.streams.values()) {
				if (stream instanceof ServedHttpStream && stream.idleAt(now, streamIdle)) stream.reset("idle", "The stream was idle");
			}
		}, streamIdle / 4);
	}

	private stopSweep(): void {
		clearInterval(this.sweep);
		this.sweep = undefined;
	}

	private stop(): void {
		this.stopped = true;
		clearTimeout(this.reconnect);
		this.stopSweep();
		this.settleReady?.reject(new Error("The connector stopped before the relay accepted it"));
		this.settleReady = undefined;
		this.settleClosed();
	}

	private report(error: Error): void {
		try {
			this.options.onError?.(error);
		} catch {
			// A failing callback must not stop the connector.
		}
	}
}
