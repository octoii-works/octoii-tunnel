import { describe, expect, test } from "bun:test";
import {
	CLOSE_CODE,
	DEFAULT_LIMITS,
	decodeFrame,
	encodeFrame,
	encodeHello,
	FRAME_TYPE,
	hashCredential,
	MAX_FRAME_SIZE,
	newCredential,
	newDeviceId,
	PING,
	PONG,
} from "@klein-works/takotunnel-protocol";
import { DeviceSession, type SessionSocket, type SocketAttachment } from "../src/index.ts";

const ORIGIN = "https://relay.test";

/** A socket that records what the session sends and how it closes it. */
class FakeSocket implements SessionSocket {
	readonly sent: (Uint8Array | string)[] = [];
	closedWith: number | undefined;
	private kept: SocketAttachment | undefined;
	constructor(attachment?: SocketAttachment) {
		this.kept = attachment;
	}
	send(bytes: Uint8Array): void {
		this.sent.push(bytes);
	}
	sendText(text: string): void {
		this.sent.push(text);
	}
	close(code: number): void {
		this.closedWith ??= code;
	}
	bufferedAmount(): number {
		return 0;
	}
	attachment(): SocketAttachment | undefined {
		return this.kept;
	}
	attach(attachment: SocketAttachment): void {
		this.kept = attachment;
	}
	/** The types of the frames sent. */
	frameTypes(): number[] {
		return this.sent.flatMap((message) => (typeof message === "string" ? [] : [decodeFrame(message, MAX_FRAME_SIZE).type]));
	}
}

/** A session on a fake host whose clock moves only when told. */
function fakeSession(options: { live?: FakeSocket[]; authorize?: () => Promise<{ allowed: true }> } = {}) {
	const deviceId = newDeviceId();
	const credential = newCredential();
	let record: { id: string; name: string; credentialHash: string } | undefined = { id: deviceId, name: "", credentialHash: hashCredential(credential) };
	let now = 1_000_000;
	const timers: { at: number; callback: () => void }[] = [];
	const session = new DeviceSession(
		deviceId,
		{
			records: { get: async () => record, delete: async () => (record = undefined) },
			sockets: { live: () => options.live ?? [], lastHeartbeat: () => undefined },
			clock: {
				now: () => now,
				after: (delay, callback) => {
					const timer = { at: now + delay, callback };
					timers.push(timer);
					return () => timers.splice(timers.indexOf(timer), 1);
				},
			},
		},
		{ origin: ORIGIN, registrationToken: "token", ...(options.authorize === undefined ? {} : { authorize: options.authorize }) },
	);
	const advance = (ms: number) => {
		now += ms;
		for (const timer of timers.filter((candidate) => candidate.at <= now)) {
			timers.splice(timers.indexOf(timer), 1);
			timer.callback();
		}
	};
	const connect = async (secret = credential): Promise<FakeSocket> => {
		const socket = new FakeSocket();
		session.opened(socket);
		await session.message(socket, encodeFrame(FRAME_TYPE.HELLO, 0, encodeHello({ version: 1, credential: secret, connector: "test/1" })));
		return socket;
	};
	const visit = (path = "/") =>
		session.fetch(new Request(`https://${deviceId}.relay.test${path}`), { address: "203.0.113.1", acceptConnector: () => undefined });
	return { session, deviceId, credential, advance, connect, visit };
}

describe("device sessions", () => {
	test("welcome a connector with the right credential and close one with a wrong one", async () => {
		const { connect } = fakeSession();
		const good = await connect();
		expect(good.frameTypes()).toEqual([FRAME_TYPE.WELCOME]);
		expect(good.attachment()).toMatchObject({ role: "connector", authenticated: true, nextStream: 1 });
		const bad = await connect(newCredential());
		expect(bad.closedWith).toBe(CLOSE_CODE.UNAUTHORIZED);
		expect(good.closedWith).toBeUndefined();
	});

	test("answer a ping with a pong, and close on any other text", async () => {
		const { session, connect } = fakeSession();
		const socket = await connect();
		await session.message(socket, PING);
		expect(socket.sent.at(-1)).toBe(PONG);
		await session.message(socket, "hello?");
		expect(socket.closedWith).toBe(CLOSE_CODE.MALFORMED);
	});

	test("close a connection that sends no hello in time", () => {
		const { session, advance } = fakeSession();
		const socket = new FakeSocket();
		session.opened(socket);
		advance(9_999);
		expect(socket.closedWith).toBeUndefined();
		advance(1);
		expect(socket.closedWith).toBe(CLOSE_CODE.HELLO_TIMEOUT);
	});

	test("call a device offline, and close its connection, once its heartbeats stop", async () => {
		const { session, connect, advance, visit } = fakeSession();
		const socket = await connect();
		advance(2 * DEFAULT_LIMITS.heartbeat);
		await session.message(socket, PING);
		advance(3 * DEFAULT_LIMITS.heartbeat);
		const pending = visit();
		await Bun.sleep(0);
		expect(socket.frameTypes()).toContain(FRAME_TYPE.OPEN);
		void pending;
		advance(1);
		expect((await visit())?.status).toBe(502);
		expect(socket.closedWith).toBe(CLOSE_CODE.INTERNAL_ERROR);
	});

	test("resume an authenticated connection from its attachment, and close one that had not authenticated", async () => {
		const authenticated = new FakeSocket({ role: "connector", authenticated: true, nextStream: 7, welcomedAt: 1_000_000 });
		const unauthenticated = new FakeSocket({ role: "connector", authenticated: false, nextStream: 1, welcomedAt: 0 });
		const { session, visit } = fakeSession({ live: [authenticated, unauthenticated] });
		session.resume();
		expect(unauthenticated.closedWith).toBe(CLOSE_CODE.HELLO_TIMEOUT);
		void visit();
		await Bun.sleep(0);
		const open = authenticated.sent.find((message) => typeof message !== "string" && decodeFrame(message, MAX_FRAME_SIZE).type === FRAME_TYPE.OPEN);
		expect(open === undefined || typeof open === "string" ? undefined : decodeFrame(open, MAX_FRAME_SIZE).stream).toBe(7);
		expect(authenticated.attachment()?.nextStream).toBe(8);
	});

	test("refuse an authentication still in flight when the device is removed", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const { session, deviceId, credential, connect } = fakeSession({ authorize: () => gate.then(() => ({ allowed: true as const })) });
		const connecting = connect();
		await Bun.sleep(0);
		const removal = await session.fetch(
			new Request(`${ORIGIN}/v1/devices/${deviceId}`, { method: "DELETE", headers: { authorization: `Bearer ${credential}` } }),
			{
				address: "",
				acceptConnector: () => undefined,
			},
		);
		expect(removal?.status).toBe(204);
		release();
		expect((await connecting).closedWith).toBe(CLOSE_CODE.UNAUTHORIZED);
	});
});
