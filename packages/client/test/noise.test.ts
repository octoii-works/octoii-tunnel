import { describe, expect, it } from "bun:test";
import { x25519 } from "@noble/curves/ed25519.js";
import { type KeyPair, XXHandshake } from "../src/secure/noise.ts";

/** A test vector of the cacophony suite, as `vectors.json` holds it. */
type Vector = {
	readonly protocol_name: string;
	readonly init_prologue: string;
	readonly init_static: string;
	readonly init_ephemeral: string;
	readonly resp_prologue: string;
	readonly resp_static: string;
	readonly resp_ephemeral: string;
	readonly handshake_hash: string;
	readonly messages: readonly { readonly payload: string; readonly ciphertext: string }[];
};

const file: { readonly vectors: readonly Vector[] } = await Bun.file(new URL("vectors.json", import.meta.url)).json();
const vectors = file.vectors.filter((vector) => vector.protocol_name === "Noise_XX_25519_ChaChaPoly_SHA256");

function bytes(hex: string): Uint8Array {
	return Uint8Array.fromHex(hex);
}

function keyPair(privateKeyHex: string): KeyPair {
	const privateKey = bytes(privateKeyHex);
	return { publicKey: x25519.getPublicKey(privateKey), privateKey };
}

describe("Noise_XX_25519_ChaChaPoly_SHA256", () => {
	it("has test vectors to check against", () => {
		expect(vectors.length).toBeGreaterThan(0);
	});

	for (const [index, vector] of vectors.entries()) {
		it(`writes and reads the messages of test vector ${index} byte for byte`, () => {
			const initiator = new XXHandshake({
				initiator: true,
				staticKey: keyPair(vector.init_static),
				ephemeralKey: keyPair(vector.init_ephemeral),
				prologue: bytes(vector.init_prologue),
			});
			const responder = new XXHandshake({
				initiator: false,
				staticKey: keyPair(vector.resp_static),
				ephemeralKey: keyPair(vector.resp_ephemeral),
				prologue: bytes(vector.resp_prologue),
			});
			const handshake = vector.messages.slice(0, 3);
			const transport = vector.messages.slice(3);
			// Messages alternate, starting with the initiator's.
			for (const [step, message] of handshake.entries()) {
				const [writer, reader] = step % 2 === 0 ? [initiator, responder] : [responder, initiator];
				const written = writer.writeMessage(bytes(message.payload));
				expect(written.toHex()).toBe(message.ciphertext);
				expect(reader.readMessage(written).toHex()).toBe(message.payload);
			}
			expect(initiator.handshakeHash.toHex()).toBe(vector.handshake_hash);
			expect(responder.handshakeHash.toHex()).toBe(vector.handshake_hash);
			expect(initiator.remoteStaticKey).toEqual(keyPair(vector.resp_static).publicKey);
			expect(responder.remoteStaticKey).toEqual(keyPair(vector.init_static).publicKey);

			const initiatorCiphers = initiator.split();
			const responderCiphers = responder.split();
			for (const [step, message] of transport.entries()) {
				const [sender, receiver] = step % 2 === 0 ? [responderCiphers, initiatorCiphers] : [initiatorCiphers, responderCiphers];
				const ciphertext = sender.send.encryptWithAd(new Uint8Array(0), bytes(message.payload));
				expect(ciphertext.toHex()).toBe(message.ciphertext);
				expect(receiver.receive.decryptWithAd(new Uint8Array(0), ciphertext).toHex()).toBe(message.payload);
			}
		});
	}

	it("rekeys both sides alike, so the channel goes on", () => {
		const initiator = new XXHandshake({ initiator: true, staticKey: keyPair("11".repeat(32)), prologue: new Uint8Array(0) });
		const responder = new XXHandshake({ initiator: false, staticKey: keyPair("22".repeat(32)), prologue: new Uint8Array(0) });
		responder.readMessage(initiator.writeMessage(new Uint8Array(0)));
		initiator.readMessage(responder.writeMessage(new Uint8Array(0)));
		responder.readMessage(initiator.writeMessage(new Uint8Array(0)));
		const sending = initiator.split().send;
		const receiving = responder.split().receive;
		sending.rekey();
		receiving.rekey();
		const plaintext = Uint8Array.from([1, 2, 3]);
		expect(receiving.decryptWithAd(new Uint8Array(0), sending.encryptWithAd(new Uint8Array(0), plaintext))).toEqual(plaintext);
	});

	it("refuses a message out of turn", () => {
		const initiator = new XXHandshake({ initiator: true, staticKey: keyPair("11".repeat(32)), prologue: new Uint8Array(0) });
		expect(() => initiator.readMessage(new Uint8Array(32))).toThrow("out of turn");
	});
});
