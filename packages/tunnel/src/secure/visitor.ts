/** A visitor's side of secure mode: pairing from an offer, and opening secure channels to a paired device. */
import type { Platform } from "../platform.ts";
import type { VisitorChannel } from "./channel.ts";
import { initiate } from "./handshake.ts";
import { parseOffer } from "./offers.ts";
import { keepPairing, type Pairing, type PairingStore, staticKeyOf } from "./store.ts";

/** How a visitor pairs: where it keeps its key and pairings, the name the device shows for it, and its platform. */
export type PairingOptions = { readonly store: PairingStore; readonly name?: string; readonly platform: Platform };

/** How a visitor opens a secure channel: where it keeps its key, and its platform. */
export type SecureChannelOptions = { readonly store: PairingStore; readonly platform: Platform };

/**
 * Pairs with the device whose offer `offerUrl` is, as scanned from its QR code: proves the offer's one-time code, and
 * keeps the device's key, which every later channel must match.
 */
export async function pairWith(offerUrl: string, options: PairingOptions): Promise<Pairing> {
	const offer = parseOffer(offerUrl);
	const key = await staticKeyOf(options.store, options.platform.randomBytes);
	const proof = { pair: offer.code, ...(options.name === undefined ? {} : { name: options.name }) };
	const channel = await initiate(offer.address, key, offer.connectorKey, proof, options.platform);
	const pairing = { address: offer.address, connectorKey: offer.connectorKey };
	await keepPairing(options.store, pairing);
	channel.close(1000, "Paired");
	return pairing;
}

/** Opens a secure channel to a device the visitor has paired with. */
export async function openSecureChannel(pairing: Pairing, options: SecureChannelOptions): Promise<VisitorChannel> {
	return initiate(pairing.address, await staticKeyOf(options.store, options.platform.randomBytes), pairing.connectorKey, {}, options.platform);
}
