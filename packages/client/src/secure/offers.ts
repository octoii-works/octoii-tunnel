/**
 * Pairing offers: a one-time code and the connector's public key in the fragment of the device's address, which a
 * browser never sends, so the relay never learns either.
 */
import { decodeBase64Url, encodeBase64Url, ProtocolError, sameSecret } from "@octoii/tunnel-protocol";

/** How long an offer may be used, in milliseconds. */
export const OFFER_LIFETIME = 5 * 60_000;
/** How many wrong codes within `FAILURE_WINDOW` stop new pairings until it passes. */
const MAX_FAILURES = 5;
const FAILURE_WINDOW = 60_000;
const CODE_BYTES = 16;
const PAIR_PARAMETER = "octoiitunnel-pair";
const KEY_PARAMETER = "key";

/** An offer the connector shows, usually as a QR code. */
export type PairingOffer = { readonly url: string; readonly expiresAt: number };

/** What a visitor reads from an offer's URL. */
export type ParsedOffer = { readonly address: string; readonly code: string; readonly connectorKey: string };

/** The connector's open offers, each used at most once. */
export class PairingOffers {
	private readonly codes = new Map<string, number>();
	private failures: number[] = [];

	/** A new offer for the device at `address`, from the connector's public key. */
	create(address: string, connectorKey: Uint8Array): PairingOffer {
		const code = encodeBase64Url(crypto.getRandomValues(new Uint8Array(CODE_BYTES)));
		const expiresAt = Date.now() + OFFER_LIFETIME;
		this.codes.set(code, expiresAt);
		return { url: `${address}/#${PAIR_PARAMETER}=${code}&${KEY_PARAMETER}=${encodeBase64Url(connectorKey)}`, expiresAt };
	}

	/**
	 * Spends `code` if it is an open offer's, comparing in constant time; false for any other code, and for every code
	 * while too many wrong ones came in the last minute.
	 */
	redeem(code: string): boolean {
		const now = Date.now();
		this.failures = this.failures.filter((at) => now - at < FAILURE_WINDOW);
		if (this.failures.length >= MAX_FAILURES) return false;
		for (const [open, expiresAt] of this.codes) {
			if (expiresAt <= now) this.codes.delete(open);
			else if (sameSecret(open, code)) {
				this.codes.delete(open);
				return true;
			}
		}
		this.failures.push(now);
		return false;
	}
}

/** The device address, code and connector key in an offer's URL; throws a `ProtocolError` for any other URL. */
export function parseOffer(url: string): ParsedOffer {
	const hash = url.indexOf("#");
	if (hash < 0) throw new ProtocolError("Not a pairing offer");
	const address = url.slice(0, hash).replace(/\/$/, "");
	const parameters = new Map<string, string>();
	for (const pair of url.slice(hash + 1).split("&")) {
		const equals = pair.indexOf("=");
		if (equals > 0) parameters.set(pair.slice(0, equals), pair.slice(equals + 1));
	}
	const code = parameters.get(PAIR_PARAMETER);
	const connectorKey = parameters.get(KEY_PARAMETER);
	if (code === undefined || connectorKey === undefined || decodeBase64Url(code).length !== CODE_BYTES || decodeBase64Url(connectorKey).length !== 32) {
		throw new ProtocolError("Not a pairing offer");
	}
	return { address, code, connectorKey };
}
