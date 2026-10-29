import { expect, test } from "bun:test";
import type { Platform } from "../src/platform.ts";
import { OFFER_LIFETIME, PairingOffers, parseOffer } from "../src/secure/offers.ts";
import { webPlatform } from "../src/web.ts";

/** 2026-10-16T00:00:00Z, in milliseconds. */
const START = 1_792_108_800_000;

/** A platform whose clock stands still until the test moves it; its timers never fire. */
function fakePlatform(): Platform & { advance(ms: number): void } {
	let time = START;
	return {
		clock: { now: () => time, setTimer: () => () => undefined },
		randomBytes: webPlatform.randomBytes,
		advance: (ms) => {
			time += ms;
		},
	};
}

test("an offer's code works once, and only until it expires", () => {
	const platform = fakePlatform();
	const offers = new PairingOffers(platform);
	const key = new Uint8Array(32).fill(7);
	const offer = offers.create("https://device.relay.test", key);
	expect(offer.expiresAt).toBe(START + OFFER_LIFETIME);
	const first = parseOffer(offer.url);
	expect(first.address).toBe("https://device.relay.test");
	expect(offers.redeem(first.code)).toBe(true);
	expect(offers.redeem(first.code)).toBe(false);
	const second = parseOffer(offers.create("https://device.relay.test", key).url);
	platform.advance(OFFER_LIFETIME + 1);
	expect(offers.redeem(second.code)).toBe(false);
});

test("five wrong codes in a minute stop pairing until the minute passes", () => {
	const platform = fakePlatform();
	const offers = new PairingOffers(platform);
	const good = parseOffer(offers.create("https://device.relay.test", new Uint8Array(32)).url);
	for (let attempt = 0; attempt < 5; attempt++) expect(offers.redeem("A".repeat(22))).toBe(false);
	expect(offers.redeem(good.code)).toBe(false);
	platform.advance(61_000);
	expect(offers.redeem(good.code)).toBe(true);
});

test("an offer's code comes from the platform's randomness", () => {
	const offers = new PairingOffers({ clock: webPlatform.clock, randomBytes: (length) => new Uint8Array(length).fill(0xff) });
	expect(parseOffer(offers.create("https://device.relay.test", new Uint8Array(32)).url).code).toBe("_".repeat(21) + "w");
});
