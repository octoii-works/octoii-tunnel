import { afterEach, expect, setSystemTime, test } from "bun:test";
import { OFFER_LIFETIME, PairingOffers, parseOffer } from "../src/secure/offers.ts";

afterEach(() => setSystemTime());

test("an offer's code works once, and only until it expires", () => {
	setSystemTime(new Date("2026-10-16T00:00:00Z"));
	const offers = new PairingOffers();
	const key = new Uint8Array(32).fill(7);
	const first = parseOffer(offers.create("https://device.relay.test", key).url);
	expect(first.address).toBe("https://device.relay.test");
	expect(offers.redeem(first.code)).toBe(true);
	expect(offers.redeem(first.code)).toBe(false);
	const second = parseOffer(offers.create("https://device.relay.test", key).url);
	setSystemTime(new Date(Date.parse("2026-10-16T00:00:00Z") + OFFER_LIFETIME + 1));
	expect(offers.redeem(second.code)).toBe(false);
});

test("five wrong codes in a minute stop pairing until the minute passes", () => {
	setSystemTime(new Date("2026-10-16T00:00:00Z"));
	const offers = new PairingOffers();
	const good = parseOffer(offers.create("https://device.relay.test", new Uint8Array(32)).url);
	for (let attempt = 0; attempt < 5; attempt++) expect(offers.redeem("A".repeat(22))).toBe(false);
	expect(offers.redeem(good.code)).toBe(false);
	setSystemTime(new Date(Date.parse("2026-10-16T00:00:00Z") + 61_000));
	expect(offers.redeem(good.code)).toBe(true);
});
