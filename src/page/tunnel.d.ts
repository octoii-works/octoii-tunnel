// The types of tunnel.js: a browser's session to a machine.

/** A failure of the session or of a request on it. */
export declare class TunnelError extends Error {}

/** A WebSocket opened over the session. */
export declare class TunnelSocket {
	onmessage: ((data: string | Uint8Array) => void) | null;
	onclose: (() => void) | null;
	/** Sends a message: a string as text, bytes as binary. */
	send(data: string | Uint8Array): void;
	close(): void;
}

/** How a request or a WebSocket is sent. */
export interface TunnelRequestOptions {
	readonly authority?: string;
	readonly headers?: Readonly<Record<string, string>>;
}

/** A response read whole. */
export interface TunnelResponse {
	readonly status: number;
	readonly headers: Headers;
	readonly body: Uint8Array;
}

/** A session from this page to a machine, through a relay. */
export declare class Tunnel {
	/** Opens a session to the machine of the key `machine`, for the device whose key is made from `seed`. */
	static open(options: { readonly module: WebAssembly.Module; readonly relay: string; readonly machine: string; readonly seed: Uint8Array }): Promise<Tunnel>;
	/** Where the session stands. */
	readonly state: "connecting" | "ready" | "ended" | "machine-away";
	/** The text of this device's key. */
	readonly key: string;
	/** Sends a request and reads its whole response. */
	request(method: string, target: string, options?: TunnelRequestOptions & { readonly body?: string | Uint8Array }): Promise<TunnelResponse>;
	/** Opens a WebSocket at `target`: resolved once the machine accepted it. */
	socket(target: string, options?: TunnelRequestOptions): Promise<TunnelSocket>;
	/** Ends the session. */
	close(): void;
}
