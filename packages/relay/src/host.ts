/**
 * What the relay core asks of the host that runs it, and how the host configures it. A host routes each device's
 * requests to that device's session and gives the session its record, its sockets and a clock.
 */
import type { Limits } from "@klein-works/takotunnel-protocol";

/** What the relay keeps of a device. */
export type DeviceRecord = { readonly id: string; readonly name: string; readonly credentialHash: string };

/** The host's side of the router: creating devices, and handing a device's requests to its session. */
export interface RelayHost {
	/** Creates the device; false when its id is taken. */
	createDevice(record: DeviceRecord): Promise<boolean>;
	/** Hands a request for the device to its session; `undefined` when the host upgraded it to a WebSocket. */
	forward(deviceId: string, request: Request): Promise<Response | undefined>;
}

/** One device's record, as its session reads and removes it. */
export interface DeviceRecords {
	/** The record, or `undefined` when the device does not exist. */
	get(): Promise<DeviceRecord | undefined>;
	delete(): Promise<void>;
}

/** What a session keeps on a socket so it can continue after the host suspends and wakes it. */
export type SocketAttachment = {
	readonly role: "connector";
	/** Whether the connector authenticated on this socket. */
	readonly authenticated: boolean;
	/** The next stream id to open on this connection. */
	readonly nextStream: number;
	/** When the relay sent `welcome`, which counts as the first heartbeat. */
	readonly welcomedAt: number;
};

/** A WebSocket as the session uses it. */
export interface SessionSocket {
	/** Sends a binary message. */
	send(bytes: Uint8Array): void;
	/** Sends a text message. */
	sendText(text: string): void;
	close(code: number, reason: string): void;
	/** How many bytes wait to be sent. */
	bufferedAmount(): number;
	/** What the session keeps on this socket. */
	attachment(): SocketAttachment | undefined;
	attach(attachment: SocketAttachment): void;
}

/** The session's sockets, as the host keeps them. */
export interface SessionSockets {
	/** The sockets still open, as after the session wakes. */
	live(): readonly SessionSocket[];
	/** When the host last answered a heartbeat on `socket` without waking the session, if it does. */
	lastHeartbeat(socket: SessionSocket): number | undefined;
}

/** The time, and timers that only need to fire while the session is awake. */
export interface Clock {
	now(): number;
	/** Calls `callback` after `delay` milliseconds; returns what cancels it. */
	after(delay: number, callback: () => void): () => void;
}

/** What a host gives one device's session. */
export type SessionHost = { readonly records: DeviceRecords; readonly sockets: SessionSockets; readonly clock: Clock };

/** What a host tells a session about one request, and how it upgrades it. */
export type RequestContext = {
	/** The visitor's address, as the host saw it. */
	readonly address: string;
	/** Upgrades the request to a WebSocket for a connector; the host calls `DeviceSession.opened` once it is open. */
	acceptConnector(): Response | undefined;
};

/** A request the hooks are asked about. */
export type Authorization =
	| { readonly kind: "register"; readonly request: Request }
	| { readonly kind: "connector"; readonly deviceId: string }
	| { readonly kind: "visitor"; readonly deviceId: string; readonly request: Request };

/** What `authorize` decides. */
export type Decision = { readonly allowed: true } | { readonly allowed: false; readonly status: 403 | 429 };

/** What `meter` receives as a stream or a connection ends. */
export type MeterEvent = {
	readonly deviceId: string;
	readonly kind: "http" | "connection";
	/** Bytes from visitors to the device. */
	readonly bytesIn: number;
	/** Bytes from the device to visitors. */
	readonly bytesOut: number;
	/** Milliseconds from start to end. */
	readonly duration: number;
};

/** How a relay is configured. */
export type RelayOptions = {
	/** The relay's own origin on the base domain, such as `https://takotunnel.dev`. */
	readonly origin: string;
	/** The secret a device presents to register. */
	readonly registrationToken: string;
	/** May refuse registrations, connector connections and visitor streams. */
	readonly authorize?: (event: Authorization) => Decision | Promise<Decision>;
	/** Receives counters as streams and connections end. */
	readonly meter?: (event: MeterEvent) => void | Promise<void>;
	/** Overrides of the limits the relay announces. */
	readonly limits?: Partial<Limits>;
};
