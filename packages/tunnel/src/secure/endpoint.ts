/**
 * The device's side of secure mode, apart from any connection: its static key and paired visitors, its pairing offers,
 * and the handshake on each socket it is given, from the relay or from a direct listener.
 */
import type { Handler } from "../http-stream.ts";
import type { Platform } from "../platform.ts";
import type { TunnelSocket } from "../websocket-stream.ts";
import type { SecureChannel } from "./channel.ts";
import { respond } from "./handshake.ts";
import type { KeyPair } from "./noise.ts";
import { type PairingOffer, PairingOffers } from "./offers.ts";
import { forgetVisitor, type PairedVisitor, pairedVisitors, type PairingStore, staticKeyOf } from "./store.ts";

/** The close code of a forgotten visitor's channels: as for a refused handshake, the visitor is not paired. */
const FORGOTTEN = 4401;

/** How a secure endpoint is set up. */
export type SecureEndpointOptions = {
	/** The device's address, which its pairing offers carry and its channels' requests are made against. */
	readonly address: string;
	/** Where the endpoint keeps its static key and the visitors it paired with. */
	readonly store: PairingStore;
	/** Answers each fetch-style request a paired visitor sends over a channel. */
	readonly handler: Handler;
	/** The clock, timers and randomness the endpoint runs on. */
	readonly platform: Platform;
};

/** Makes a device's secure endpoint. */
export function createSecureEndpoint(options: SecureEndpointOptions): SecureEndpoint {
	return new SecureEndpoint(options);
}

/** A device's side of secure mode: it offers pairings, accepts channels however they arrive, and forgets visitors. */
export class SecureEndpoint {
	private readonly options: SecureEndpointOptions;
	private readonly offers: PairingOffers;
	private readonly listeners = new Set<(channel: SecureChannel) => void>();
	/** The channels open now, so forgetting a visitor closes its own. */
	private readonly channels = new Set<SecureChannel>();
	private key: Promise<KeyPair> | undefined;

	constructor(options: SecureEndpointOptions) {
		this.options = options;
		this.offers = new PairingOffers(options.platform);
	}

	/** A pairing offer to show a visitor, as a link or a QR code of it; it works once, for five minutes. */
	async offerPairing(): Promise<PairingOffer> {
		return this.offers.create(this.options.address, (await this.staticKey()).publicKey);
	}

	/**
	 * Runs the handshake on the socket `open` gives, once the static key is at hand; the channel goes to the listeners if
	 * the visitor proves a pairing.
	 */
	async accept(open: () => TunnelSocket): Promise<void> {
		const key = await this.staticKey();
		const { store, platform, address, handler } = this.options;
		respond(open(), { key, store, platform, offers: this.offers, address, handler, accepted: (channel) => this.accepted(channel) });
	}

	/** Calls `listener` with each secure channel a paired visitor opens; returns what stops it. */
	onSecureChannel(listener: (channel: SecureChannel) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** The visitors this device has paired with, the earliest first. */
	async visitors(): Promise<PairedVisitor[]> {
		return pairedVisitors(this.options.store);
	}

	/** Forgets a paired visitor: its open channels close, and its next one is refused. */
	async forgetVisitor(publicKey: string): Promise<void> {
		await forgetVisitor(this.options.store, publicKey);
		for (const channel of this.channels) if (channel.visitor.publicKey === publicKey) channel.close(FORGOTTEN, "The visitor was forgotten");
	}

	private staticKey(): Promise<KeyPair> {
		this.key ??= staticKeyOf(this.options.store, this.options.platform.randomBytes);
		return this.key;
	}

	private accepted(channel: SecureChannel): void {
		this.channels.add(channel);
		void channel.done.then(() => this.channels.delete(channel));
		for (const listener of this.listeners) listener(channel);
	}
}
