/** A visitor's side of secure mode: pairing from an offer, and opening secure channels to a paired device. */
import type { VisitorChannel } from "./channel.ts";
import { initiate } from "./handshake.ts";
import { parseOffer } from "./offers.ts";
import { keepPairing, type Pairing, type PairingStore, staticKeyOf } from "./store.ts";

/**
 * Pairs with the device whose offer `offerUrl` is, as scanned from its QR code: proves the offer's one-time code, and
 * keeps the device's key, which every later channel must match.
 */
export async function pairWith(offerUrl: string, options: { readonly store: PairingStore; readonly name?: string }): Promise<Pairing> {
	const offer = parseOffer(offerUrl);
	const key = await staticKeyOf(options.store);
	const channel = await initiate(offer.address, key, offer.connectorKey, { pair: offer.code, ...(options.name === undefined ? {} : { name: options.name }) });
	const pairing = { address: offer.address, connectorKey: offer.connectorKey };
	await keepPairing(options.store, pairing);
	channel.close(1000, "Paired");
	return pairing;
}

/** Opens a secure channel to a device the visitor has paired with. */
export async function openSecureChannel(pairing: Pairing, options: { readonly store: PairingStore }): Promise<VisitorChannel> {
	return initiate(pairing.address, await staticKeyOf(options.store), pairing.connectorKey, {});
}
