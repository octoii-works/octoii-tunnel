/** Where each side keeps its static key and the keys it has paired with. */
import { decodeBase64Url, encodeBase64Url, isJsonObject } from "@octoii/tunnel-protocol";
import { x25519 } from "@noble/curves/ed25519.js";
import { generateKeyPair, type KeyPair } from "./noise.ts";

/**
 * A small string store the service provides: on a phone, the app's storage or the browser's; on a device, a file. Both
 * the connector and the visitor keep their keys in one.
 */
export interface PairingStore {
	get(name: string): Promise<string | undefined>;
	set(name: string, value: string): Promise<void>;
	delete(name: string): Promise<void>;
	/** The names of the values kept under names that start with `prefix`. */
	names(prefix: string): Promise<string[]>;
}

/** A pairing store in memory, for tests and short-lived visitors. */
export class MemoryPairingStore implements PairingStore {
	private readonly values = new Map<string, string>();

	async get(name: string): Promise<string | undefined> {
		return this.values.get(name);
	}

	async set(name: string, value: string): Promise<void> {
		this.values.set(name, value);
	}

	async delete(name: string): Promise<void> {
		this.values.delete(name);
	}

	async names(prefix: string): Promise<string[]> {
		return [...this.values.keys()].filter((name) => name.startsWith(prefix));
	}
}

/** A visitor the connector has paired with. */
export type PairedVisitor = { readonly publicKey: string; readonly name: string; readonly pairedAt: number };

/** What a visitor keeps of a device it has paired with. */
export type Pairing = { readonly address: string; readonly connectorKey: string };

const KEY = "octoiitunnel:key";
const VISITOR_PREFIX = "octoiitunnel:visitor:";
const visitorEntry = (publicKey: string): string => VISITOR_PREFIX + publicKey;
const pairingEntry = (address: string): string => `octoiitunnel:pairing:${address}`;

/** This side's static key pair, made and kept the first time it is needed. */
export async function staticKeyOf(store: PairingStore): Promise<KeyPair> {
	const kept = await store.get(KEY);
	if (kept !== undefined) {
		const privateKey = decodeBase64Url(kept);
		return { privateKey, publicKey: x25519.getPublicKey(privateKey) };
	}
	const keyPair = generateKeyPair();
	await store.set(KEY, encodeBase64Url(keyPair.privateKey));
	return keyPair;
}

/** The visitor paired under `publicKey`, if any. */
export async function pairedVisitor(store: PairingStore, publicKey: string): Promise<PairedVisitor | undefined> {
	const kept = await store.get(visitorEntry(publicKey));
	if (kept === undefined) return undefined;
	let value: unknown;
	try {
		value = JSON.parse(kept);
	} catch {
		return undefined;
	}
	if (!isJsonObject(value) || typeof value["name"] !== "string" || typeof value["pairedAt"] !== "number") return undefined;
	return { publicKey, name: value["name"], pairedAt: value["pairedAt"] };
}

/** The visitors the connector has paired with, the earliest first. */
export async function pairedVisitors(store: PairingStore): Promise<PairedVisitor[]> {
	const names = await store.names(VISITOR_PREFIX);
	const visitors = await Promise.all(names.map((name) => pairedVisitor(store, name.slice(VISITOR_PREFIX.length))));
	return visitors.filter((visitor) => visitor !== undefined).sort((a, b) => a.pairedAt - b.pairedAt);
}

/** Keeps a visitor the connector has just paired with. */
export async function keepVisitor(store: PairingStore, visitor: PairedVisitor): Promise<void> {
	await store.set(visitorEntry(visitor.publicKey), JSON.stringify({ name: visitor.name, pairedAt: visitor.pairedAt }));
}

/** Forgets a visitor: its next handshake fails. */
export async function forgetVisitor(store: PairingStore, publicKey: string): Promise<void> {
	await store.delete(visitorEntry(publicKey));
}

/** The visitor's pairing with the device at `address`, if any. */
export async function pairingOf(store: PairingStore, address: string): Promise<Pairing | undefined> {
	const connectorKey = await store.get(pairingEntry(address));
	return connectorKey === undefined ? undefined : { address, connectorKey };
}

/** Keeps the visitor's pairing with a device. */
export async function keepPairing(store: PairingStore, pairing: Pairing): Promise<void> {
	await store.set(pairingEntry(pairing.address), pairing.connectorKey);
}
