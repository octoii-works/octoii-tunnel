import type { Limits } from "@klein-works/takotunnel/protocol";

export interface DeviceRecord {
	id: string;
	credentialHash: string;
	name: string;
}
export interface DeviceStore {
	create(record: DeviceRecord): Promise<boolean>;
	get(id: string): Promise<DeviceRecord | undefined>;
	remove(id: string): Promise<void>;
}
export interface RelaySocket {
	send(bytes: Uint8Array): void;
	close(code: number, reason: string): void;
}
export interface AgentConnection {
	message(bytes: Uint8Array): Promise<void>;
	closed(): void;
}
export interface Scheduler {
	now(): number;
	schedule(deadline: number, callback: () => void): () => void;
}
export interface SessionHost {
	store: DeviceStore;
	scheduler: Scheduler;
}
export interface RequestContext {
	address: string;
	upgrade(accept: (socket: RelaySocket) => AgentConnection): Response | undefined;
}
export type Authorization =
	{ kind: "register"; request: Request } | { kind: "agent"; deviceId: string } | { kind: "visitor"; deviceId: string; request: Request };
export type Decision = { allowed: true } | { allowed: false; status: 403 | 429 };
export interface MeterEvent {
	deviceId: string;
	kind: "http" | "connection";
	bytesIn: number;
	bytesOut: number;
	duration: number;
}
export interface RelayOptions {
	origin: string;
	registrationToken: string;
	authorize?: (event: Authorization) => Decision | Promise<Decision>;
	meter?: (event: MeterEvent) => void | Promise<void>;
	limits?: Partial<Limits>;
}
export interface RelayDirectory {
	create(record: DeviceRecord): Promise<boolean>;
	dispatch(id: string, request: Request): Promise<Response | undefined>;
}

export function errorResponse(status: number, code: string, message: string): Response {
	return Response.json({ error: { code, message } }, { status });
}

export async function authorize(options: RelayOptions, event: Authorization): Promise<Decision> {
	try {
		return (await options.authorize?.(event)) ?? { allowed: true };
	} catch {
		return { allowed: false, status: 403 };
	}
}

export function recordMeter(options: RelayOptions, event: MeterEvent): void {
	// Metering failures must not alter traffic or expose request contents.
	try {
		void Promise.resolve(options.meter?.(event)).catch(() => {});
	} catch {
		/* Isolate hook failure. */
	}
}
