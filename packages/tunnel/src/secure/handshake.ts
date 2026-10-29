/**
 * The Noise XX handshake of a secure channel, the visitor the initiator, with prologue `octoiitunnel/1`. The visitor
 * proves a pairing code or a paired key in its last message; the connector answers `ready` once it accepts.
 */
import { decodeBase64Url, decodeJsonObject, encodeBase64Url, encodeJson, encodeUtf8, isStringUpTo, SECURE_PATH } from "../protocol/index.ts";
import { SecureChannel, VisitorChannel } from "./channel.ts";
import { type KeyPair, XXHandshake } from "./noise.ts";
import type { PairingOffers } from "./offers.ts";
import { keepVisitor, type PairingStore, pairedVisitor } from "./store.ts";
import type { TunnelSocket } from "../websocket-stream.ts";

const PROLOGUE = encodeUtf8("octoiitunnel/1");
/** How long a handshake may take, `ready` included. */
const HANDSHAKE_TIMEOUT = 10_000;
/** The close code of a refused handshake, which tells a stranger nothing more. */
const REFUSED = 4401;
const MAX_NAME_LENGTH = 128;

/** What the connector's side of a handshake needs. */
export type ResponderOptions = {
	readonly key: KeyPair;
	readonly store: PairingStore;
	readonly offers: PairingOffers;
	/** The device's address, which requests over the channel are made against. */
	readonly address: string;
	readonly handler: (request: Request) => Response | Promise<Response>;
	/** Called with each channel the connector accepts. */
	readonly accepted: (channel: SecureChannel) => void;
};

/** Runs the connector's side of a handshake on a visitor's WebSocket, and hands over the channel once it accepts. */
export function respond(socket: TunnelSocket, options: ResponderOptions): void {
	const handshake = new XXHandshake({ initiator: false, staticKey: options.key, prologue: PROLOGUE });
	const timeout = setTimeout(() => socket.close(REFUSED, ""), HANDSHAKE_TIMEOUT);
	let step = 0;
	const refuse = (): void => {
		clearTimeout(timeout);
		socket.onmessage = undefined;
		socket.close(REFUSED, "");
	};
	socket.onclose = () => clearTimeout(timeout);
	socket.onmessage = (message) => {
		if (typeof message === "string" || step > 1) return refuse();
		try {
			if (step++ === 0) {
				handshake.readMessage(message);
				socket.send(handshake.writeMessage(new Uint8Array(0)));
				return;
			}
			const proof = handshake.readMessage(message);
			socket.onmessage = undefined;
			void accept(socket, handshake, proof, options).then((channel) => {
				clearTimeout(timeout);
				if (channel === undefined) return refuse();
				socket.onmessage = (data) => (typeof data === "string" ? channel.close(REFUSED, "") : channel.received(data));
				socket.onclose = (code, reason) => channel.socketClosed(code, reason);
				channel.ready();
				options.accepted(channel);
			}, refuse);
		} catch {
			refuse();
		}
	};
}

/** The channel for a finished handshake whose visitor proved a pairing code or a paired key; `undefined` otherwise. */
async function accept(socket: TunnelSocket, handshake: XXHandshake, proof: Uint8Array, options: ResponderOptions): Promise<SecureChannel | undefined> {
	const remote = handshake.remoteStaticKey;
	if (remote === undefined) return undefined;
	const publicKey = encodeBase64Url(remote);
	const value = decodeJsonObject(proof.length === 0 ? encodeJson({}) : proof);
	const pair = value["pair"];
	const name = isStringUpTo(value["name"], MAX_NAME_LENGTH) ? value["name"] : "";
	const known = await pairedVisitor(options.store, publicKey);
	if (typeof pair === "string") {
		if (!options.offers.redeem(pair)) return undefined;
		await keepVisitor(options.store, { publicKey, name, pairedAt: Date.now() });
	} else if (known === undefined) return undefined;
	const link = { send: (bytes: Uint8Array) => socket.send(bytes), close: (code: number, reason: string) => socket.close(code, reason) };
	return new SecureChannel(link, handshake.split(), { publicKey, name: known?.name ?? name }, options.address, options.handler);
}

/**
 * Runs the visitor's side of a handshake with the device at `address`, whose connector must hold `connectorKey`, and
 * resolves to the channel once the connector sends `ready`.
 */
export function initiate(
	address: string,
	key: KeyPair,
	connectorKey: string,
	proof: { readonly pair?: string; readonly name?: string },
): Promise<VisitorChannel> {
	const expected = decodeBase64Url(connectorKey);
	const socket = new WebSocket(address.replace(/^http/, "ws") + SECURE_PATH);
	socket.binaryType = "arraybuffer";
	const handshake = new XXHandshake({ initiator: true, staticKey: key, prologue: PROLOGUE });
	return new Promise<VisitorChannel>((resolve, reject) => {
		const fail = (error: Error): void => {
			clearTimeout(timeout);
			socket.close();
			reject(error);
		};
		const timeout = setTimeout(() => fail(new Error("The device did not finish the handshake")), HANDSHAKE_TIMEOUT);
		let channel: VisitorChannel | undefined;
		const send = (bytes: Uint8Array): void => socket.send(new Uint8Array(bytes));
		socket.addEventListener("open", () => send(handshake.writeMessage(new Uint8Array(0))));
		socket.addEventListener("message", (event) => {
			const data = event.data;
			if (!(data instanceof ArrayBuffer)) return fail(new Error("The device sent text during the handshake"));
			if (channel !== undefined) return channel.received(new Uint8Array(data));
			try {
				handshake.readMessage(new Uint8Array(data));
				if (!sameKey(handshake.remoteStaticKey, expected)) return fail(new Error("The device is not the one this pairing is with"));
				send(handshake.writeMessage(encodeJson(proof)));
				const opened = new VisitorChannel({ send, close: (code, reason) => socket.close(code, reason) }, handshake.split());
				channel = opened;
				opened.opened.then(() => {
					clearTimeout(timeout);
					resolve(opened);
				}, fail);
			} catch {
				fail(new Error("The handshake failed"));
			}
		});
		socket.addEventListener("close", (event) => {
			channel?.socketClosed(event.code, event.reason);
			fail(new Error(`The device closed the channel (${event.code})`));
		});
	});
}

function sameKey(actual: Uint8Array | undefined, expected: Uint8Array): boolean {
	if (actual === undefined || actual.length !== expected.length) return false;
	let difference = 0;
	for (let index = 0; index < actual.length; index++) difference |= (actual[index] ?? 0) ^ (expected[index] ?? 0);
	return difference === 0;
}
