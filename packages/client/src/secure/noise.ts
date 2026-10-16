/**
 * The Noise protocol framework (revision 34, https://noiseprotocol.org/noise.html), only as far as one protocol
 * needs it: Noise_XX_25519_ChaChaPoly_SHA256. Names follow the specification's.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { encodeUtf8 } from "@klein-works/takotunnel-protocol";

export const PROTOCOL_NAME = "Noise_XX_25519_ChaChaPoly_SHA256";
/** The longest Noise message, handshake or transport. */
export const MAX_MESSAGE_LENGTH = 65535;
/** What ChaChaPoly adds to every plaintext it encrypts. */
export const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const EMPTY = new Uint8Array(0);

/** An x25519 key pair. */
export type KeyPair = { readonly publicKey: Uint8Array; readonly privateKey: Uint8Array };

/** A new x25519 key pair, from the platform's secure randomness. */
export function generateKeyPair(): KeyPair {
	const privateKey = crypto.getRandomValues(new Uint8Array(KEY_LENGTH));
	return { publicKey: x25519.getPublicKey(privateKey), privateKey };
}

/** A key and the count of messages it has handled, which is each message's nonce. */
export class CipherState {
	private key: Uint8Array;
	private nonce = 0;

	constructor(key: Uint8Array) {
		this.key = key;
	}

	/** Encrypts `plaintext`, authenticating `ad` with it, under the next nonce. */
	encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
		const ciphertext = chacha20poly1305(this.key, this.nonceBytes(), ad).encrypt(plaintext);
		this.nonce += 1;
		return ciphertext;
	}

	/**
	 * Replaces the key with one derived from it (Noise's `Rekey`), so a long-lived channel does not keep one key for
	 * ever; both sides rekey after the same number of messages.
	 */
	rekey(): void {
		const maxNonce = new Uint8Array(12).fill(0xff, 4);
		this.key = chacha20poly1305(this.key, maxNonce, EMPTY).encrypt(new Uint8Array(KEY_LENGTH)).slice(0, KEY_LENGTH);
	}

	/** Throws when the ciphertext does not authenticate; the nonce then stays as it was. */
	decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
		const plaintext = chacha20poly1305(this.key, this.nonceBytes(), ad).decrypt(ciphertext);
		this.nonce += 1;
		return plaintext;
	}

	/** Four zero bytes, then the nonce as 64 bits, little-endian. */
	private nonceBytes(): Uint8Array {
		if (this.nonce >= Number.MAX_SAFE_INTEGER) throw new Error("The cipher has used up its nonces");
		const bytes = new Uint8Array(12);
		const view = new DataView(bytes.buffer);
		view.setUint32(4, this.nonce % 2 ** 32, true);
		view.setUint32(8, Math.floor(this.nonce / 2 ** 32), true);
		return bytes;
	}
}

type Token = "e" | "s" | "ee" | "es" | "se";

/** The XX pattern: `-> e`, `<- e, ee, s, es`, `-> s, se`. */
const XX: readonly (readonly Token[])[] = [["e"], ["e", "ee", "s", "es"], ["s", "se"]];

/** How a side starts an XX handshake. */
export type HandshakeOptions = {
	readonly initiator: boolean;
	readonly staticKey: KeyPair;
	readonly prologue: Uint8Array;
	/** A fixed ephemeral key instead of a new one; only for test vectors. */
	readonly ephemeralKey?: KeyPair;
};

/** The two CipherStates a finished handshake splits into, one for each direction. */
export type TransportCiphers = { readonly send: CipherState; readonly receive: CipherState };

/** A HandshakeState for the XX pattern, with its SymmetricState folded in. */
export class XXHandshake {
	private readonly initiator: boolean;
	private readonly staticKey: KeyPair;
	private ephemeralKey: KeyPair | undefined;
	private remoteEphemeralKey: Uint8Array | undefined;
	private remoteStatic: Uint8Array | undefined;
	private chainingKey: Uint8Array;
	private hash: Uint8Array;
	private cipher: CipherState | undefined;
	/** The index in the pattern of the next message. */
	private step = 0;

	constructor(options: HandshakeOptions) {
		if (options.staticKey.privateKey.length !== KEY_LENGTH || options.staticKey.publicKey.length !== KEY_LENGTH) {
			throw new Error("A static key must be an x25519 key pair of 32-byte keys");
		}
		this.initiator = options.initiator;
		this.staticKey = options.staticKey;
		this.ephemeralKey = options.ephemeralKey;
		// The protocol name is exactly HASHLEN bytes, so it is h as it is.
		this.hash = encodeUtf8(PROTOCOL_NAME);
		this.chainingKey = this.hash;
		this.mixHash(options.prologue);
	}

	/** The other side's static public key, once a message has carried it. */
	get remoteStaticKey(): Uint8Array | undefined {
		return this.remoteStatic;
	}

	/** h, which identifies the handshake once it is finished. */
	get handshakeHash(): Uint8Array {
		return this.hash;
	}

	/** Writes this side's next handshake message, carrying `payload`. */
	writeMessage(payload: Uint8Array): Uint8Array {
		const tokens = this.nextTokens(true);
		const parts: Uint8Array[] = [];
		for (const token of tokens) {
			if (token === "e") {
				this.ephemeralKey ??= generateKeyPair();
				parts.push(this.ephemeralKey.publicKey);
				this.mixHash(this.ephemeralKey.publicKey);
			} else if (token === "s") {
				parts.push(this.encryptAndHash(this.staticKey.publicKey));
			} else {
				this.mixKey(this.dh(token));
			}
		}
		parts.push(this.encryptAndHash(payload));
		const message = concat(parts);
		if (message.length > MAX_MESSAGE_LENGTH) throw new Error("A handshake message was too long");
		return message;
	}

	/** Reads the other side's next message and returns its payload; throws on anything malformed. */
	readMessage(message: Uint8Array): Uint8Array {
		if (message.length > MAX_MESSAGE_LENGTH) throw new Error("A handshake message was too long");
		const tokens = this.nextTokens(false);
		let offset = 0;
		const take = (length: number): Uint8Array => {
			if (offset + length > message.length) throw new Error("A handshake message was too short");
			const bytes = message.slice(offset, offset + length);
			offset += length;
			return bytes;
		};
		for (const token of tokens) {
			if (token === "e") {
				this.remoteEphemeralKey = take(KEY_LENGTH);
				this.mixHash(this.remoteEphemeralKey);
			} else if (token === "s") {
				this.remoteStatic = this.decryptAndHash(take(this.cipher === undefined ? KEY_LENGTH : KEY_LENGTH + TAG_LENGTH));
			} else {
				this.mixKey(this.dh(token));
			}
		}
		return this.decryptAndHash(take(message.length - offset));
	}

	/** The transport CipherStates, once every message of the pattern has been written or read. */
	split(): TransportCiphers {
		if (this.step !== XX.length) throw new Error("The handshake is not finished");
		const [first, second] = hkdf(this.chainingKey, EMPTY);
		const initiatorToResponder = new CipherState(first);
		const responderToInitiator = new CipherState(second);
		return this.initiator ? { send: initiatorToResponder, receive: responderToInitiator } : { send: responderToInitiator, receive: initiatorToResponder };
	}

	/** The tokens of the next message, which must be this side's to write or the other's to read. */
	private nextTokens(writing: boolean): readonly Token[] {
		const tokens = XX[this.step];
		if (tokens === undefined) throw new Error("The handshake is already finished");
		const initiatorsTurn = this.step % 2 === 0;
		if (initiatorsTurn !== (this.initiator === writing)) throw new Error("A handshake message came out of turn");
		this.step += 1;
		return tokens;
	}

	/** DH for `ee`, `es` or `se`, from this side's point of view: the first letter is the initiator's key. */
	private dh(token: Exclude<Token, "e" | "s">): Uint8Array {
		const initiatorKey = token[0] === "e" ? "e" : "s";
		const responderKey = token[1] === "e" ? "e" : "s";
		const local = this.initiator ? initiatorKey : responderKey;
		const remote = this.initiator ? responderKey : initiatorKey;
		const privateKey = local === "e" ? this.ephemeralKey?.privateKey : this.staticKey.privateKey;
		const publicKey = remote === "e" ? this.remoteEphemeralKey : this.remoteStatic;
		if (privateKey === undefined || publicKey === undefined) throw new Error(`The keys for ${token} are missing`);
		return x25519.getSharedSecret(privateKey, publicKey);
	}

	private mixKey(inputKeyMaterial: Uint8Array): void {
		const [chainingKey, key] = hkdf(this.chainingKey, inputKeyMaterial);
		this.chainingKey = chainingKey;
		this.cipher = new CipherState(key);
	}

	private mixHash(data: Uint8Array): void {
		this.hash = sha256(concat([this.hash, data]));
	}

	private encryptAndHash(plaintext: Uint8Array): Uint8Array {
		const ciphertext = this.cipher === undefined ? plaintext : this.cipher.encryptWithAd(this.hash, plaintext);
		this.mixHash(ciphertext);
		return ciphertext;
	}

	private decryptAndHash(ciphertext: Uint8Array): Uint8Array {
		const plaintext = this.cipher === undefined ? ciphertext : this.cipher.decryptWithAd(this.hash, ciphertext);
		this.mixHash(ciphertext);
		return plaintext;
	}
}

/** Noise's HKDF with two outputs, on HMAC-SHA256. */
function hkdf(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array): readonly [Uint8Array, Uint8Array] {
	const tempKey = hmac(sha256, chainingKey, inputKeyMaterial);
	const first = hmac(sha256, tempKey, Uint8Array.of(1));
	const second = hmac(sha256, tempKey, concat([first, Uint8Array.of(2)]));
	return [first, second];
}

/** The parts, one after another, in one array. */
export function concat(parts: readonly Uint8Array[]): Uint8Array {
	const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		result.set(part, offset);
		offset += part.length;
	}
	return result;
}
