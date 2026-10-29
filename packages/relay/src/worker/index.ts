/**
 * The relay on hosts with the Workers and Durable Object APIs. The Worker runs the router and sends each device's
 * requests to the Durable Object named by its device id, which holds the device session and keeps the device's record
 * in its storage. Sockets are hibernating WebSockets whose attachments let the session resume, and heartbeats are
 * answered automatically, so an idle device's object sleeps.
 *
 * ```ts
 * const relay = defineRelay();
 * export default relay.worker;
 * export const DeviceObject = relay.DeviceObject;
 * ```
 */
import { PING, PONG, sameSecret } from "@octoii-works/tunnel/protocol";
import { errorResponse } from "../hooks.ts";
import type { DeviceRecord, RelayOptions, SessionHost, SessionSocket, SocketAttachment } from "../host.ts";
import { createRelay } from "../router.ts";
import { DeviceSession } from "../session.ts";

/** The bindings and variables the relay's Worker and objects read. */
export type RelayEnv = {
	/** The Durable Object namespace of device sessions. */
	readonly DEVICES: DurableObjectNamespace;
	/** The relay's origin on the base domain, such as `https://octoiitunnel.com`. */
	readonly RELAY_ORIGIN: string;
	/** The secret a device presents to register. */
	readonly REGISTRATION_TOKEN: string;
};

/** What a deployment adds to the relay: its hooks and limits. */
export type RelayHooks = Pick<RelayOptions, "authorize" | "meter" | "limits">;

/**
 * The path where the Worker creates a device's record in its object. Visitor requests reach the object too, so the
 * request also carries the registration token, which only the Worker knows.
 */
const CREATE_PATH = "/.octoiitunnel/create";
/** The header that carries the registration token on a create. */
const CREATE_HEADER = "x-octoiitunnel-registration";
/** The storage key of the device's record. */
const RECORD_KEY = "device";

/** A relay deployment: the Worker to export as the default, and the Durable Object class to export by its binding's name. */
export type RelayDeployment = {
	readonly worker: ExportedHandler<RelayEnv>;
	readonly DeviceObject: new (ctx: DurableObjectState, env: RelayEnv) => DeviceSessionObject;
};

/** The relay's Worker and its Durable Object class, with `hooks` in both. */
export function defineRelay(hooks: RelayHooks = {}): RelayDeployment {
	const worker: ExportedHandler<RelayEnv> = {
		async fetch(request, env) {
			const objectOf = (deviceId: string) => env.DEVICES.get(env.DEVICES.idFromName(deviceId));
			try {
				const response = await createRelay(optionsOf(env, hooks)).handle(request, {
					createDevice: async (record) => (await objectOf(record.id).fetch(createRequest(record, env.REGISTRATION_TOKEN))).status === 201,
					forward: (deviceId, forwarded) => objectOf(deviceId).fetch(forwarded),
				});
				return response ?? errorResponse("internal", "The relay failed");
			} catch {
				return errorResponse("internal", "The relay failed");
			}
		},
	};

	/** The Durable Object class of device sessions, with `hooks`. */
	class DeviceObject extends DeviceSessionObject {
		constructor(ctx: DurableObjectState, env: RelayEnv) {
			super(ctx, env, hooks);
		}
	}

	return { worker, DeviceObject };
}

/** One device's session, in the Durable Object named by its device id; `defineRelay` gives it the deployment's hooks. */
export class DeviceSessionObject implements DurableObject {
	private readonly ctx: DurableObjectState;
	private readonly options: RelayOptions;
	private readonly sockets = new WeakMap<WebSocket, WorkerSessionSocket>();
	private record: DeviceRecord | undefined;
	private session: DeviceSession | undefined;

	constructor(ctx: DurableObjectState, env: RelayEnv, hooks: RelayHooks) {
		this.ctx = ctx;
		this.options = optionsOf(env, hooks);
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
		void ctx.blockConcurrencyWhile(async () => {
			this.record = await ctx.storage.get<DeviceRecord>(RECORD_KEY);
			// Woken from hibernation: the session rebuilds itself from the sockets still open.
			this.sessionOf()?.resume();
		});
	}

	async fetch(request: Request): Promise<Response> {
		if (new URL(request.url).pathname === CREATE_PATH && sameSecret(request.headers.get(CREATE_HEADER) ?? "", this.options.registrationToken)) {
			return this.create(request);
		}
		const session = this.sessionOf();
		if (session === undefined) return errorResponse("not_found", "Unknown device");
		const response = await session.fetch(request, {
			address: request.headers.get("cf-connecting-ip") ?? "",
			acceptWebSocket: (attachment, protocol) => this.accept(session, attachment, protocol),
		});
		return response ?? errorResponse("internal", "The relay failed");
	}

	async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
		await this.sessionOf()?.message(this.wrap(socket), typeof message === "string" ? message : new Uint8Array(message));
	}

	async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
		this.sessionOf()?.closed(this.wrap(socket), code, reason);
	}

	async webSocketError(socket: WebSocket): Promise<void> {
		this.sessionOf()?.closed(this.wrap(socket), 1006, "");
	}

	/** The device's session, once it has a record. */
	private sessionOf(): DeviceSession | undefined {
		const record = this.record;
		if (record === undefined) return undefined;
		this.session ??= new DeviceSession(record.id, this.host(), this.options);
		return this.session;
	}

	private host(): SessionHost {
		return {
			records: {
				get: async () => this.record,
				delete: async () => {
					this.record = undefined;
					await this.ctx.storage.deleteAll();
				},
			},
			sockets: {
				live: () => this.ctx.getWebSockets().map((socket) => this.wrap(socket)),
				lastHeartbeat: (socket) => (socket instanceof WorkerSessionSocket ? this.ctx.getWebSocketAutoResponseTimestamp(socket.socket)?.getTime() : undefined),
			},
			clock: {
				now: () => Date.now(),
				setTimer: (callback, delayMs) => {
					const timer = setTimeout(callback, delayMs);
					return () => clearTimeout(timer);
				},
			},
		};
	}

	/** Creates the device's record, once; a second create for the same id is refused. */
	private async create(request: Request): Promise<Response> {
		if (this.record !== undefined) return new Response(null, { status: 409 });
		const record: DeviceRecord = await request.json();
		await this.ctx.storage.put(RECORD_KEY, record);
		this.record = record;
		return new Response(null, { status: 201 });
	}

	private accept(session: DeviceSession, attachment: SocketAttachment, protocol: string | undefined): Response {
		const pair = new WebSocketPair();
		const [client, server] = [pair[0], pair[1]];
		this.ctx.acceptWebSocket(server);
		server.serializeAttachment(attachment);
		session.opened(this.wrap(server));
		return new Response(null, { status: 101, webSocket: client, ...(protocol === undefined ? {} : { headers: { "sec-websocket-protocol": protocol } }) });
	}

	/** The one wrapper of a socket, so the session sees the same object every time. */
	private wrap(socket: WebSocket): WorkerSessionSocket {
		let wrapped = this.sockets.get(socket);
		if (wrapped === undefined) {
			wrapped = new WorkerSessionSocket(socket);
			this.sockets.set(socket, wrapped);
		}
		return wrapped;
	}
}

/** A hibernating WebSocket as a session uses it; its attachment survives hibernation. */
class WorkerSessionSocket implements SessionSocket {
	readonly socket: WebSocket;

	constructor(socket: WebSocket) {
		this.socket = socket;
	}

	send(bytes: Uint8Array): void {
		this.socket.send(bytes);
	}

	sendText(text: string): void {
		this.socket.send(text);
	}

	close(code: number, reason: string): void {
		this.socket.close(code, reason);
	}

	bufferedAmount(): number {
		// Hibernating sockets do not report what waits to be sent; flow control bounds it.
		return 0;
	}

	attachment(): SocketAttachment | undefined {
		const attachment: unknown = this.socket.deserializeAttachment();
		return isAttachment(attachment) ? attachment : undefined;
	}

	attach(attachment: SocketAttachment): void {
		this.socket.serializeAttachment(attachment);
	}
}

/** The relay's options in a deployment: its origin and token from the environment, with the deployment's hooks. */
function optionsOf(env: RelayEnv, hooks: RelayHooks): RelayOptions {
	return { origin: env.RELAY_ORIGIN, registrationToken: env.REGISTRATION_TOKEN, ...hooks };
}

/** The request with which the Worker creates a device's record in its object. */
function createRequest(record: DeviceRecord, registrationToken: string): Request {
	return new Request(`https://device${CREATE_PATH}`, { method: "POST", headers: { [CREATE_HEADER]: registrationToken }, body: JSON.stringify(record) });
}

function isAttachment(value: unknown): value is SocketAttachment {
	return typeof value === "object" && value !== null && "role" in value && (value.role === "connector" || value.role === "visitor");
}
