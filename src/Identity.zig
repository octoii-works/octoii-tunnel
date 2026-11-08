//! An identity: the Ed25519 key pair a machine or a person's device is known by — its public key the name its peers
//! reach it by and check it against, its seed kept by its owner.
const Identity = @This();
const std = @import("std");

const Ed25519 = std.crypto.sign.Ed25519;

key_pair: Ed25519.KeyPair,

/// The length of the seed an identity is kept by.
pub const seed_length = Ed25519.KeyPair.seed_length;

/// The length of a signature.
pub const signature_length = Ed25519.Signature.encoded_length;

/// A new identity, its seed drawn from `io`.
pub fn generate(io: std.Io) Identity {
    return .{ .key_pair = .generate(io) };
}

/// The identity `seed` keeps, as `seed` gives it back.
pub fn fromSeed(kept: [seed_length]u8) error{IdentityElement}!Identity {
    return .{ .key_pair = try .generateDeterministic(kept) };
}

/// The seed the identity is kept by.
pub fn seed(identity: Identity) [seed_length]u8 {
    return identity.key_pair.secret_key.seed();
}

/// The public key the identity's peers know it by.
pub fn publicKey(identity: Identity) PublicKey {
    return .{ .bytes = identity.key_pair.public_key.toBytes() };
}

/// The identity's signature of `message`.
pub fn sign(identity: Identity, message: []const u8) ![signature_length]u8 {
    return (try identity.key_pair.sign(message, null)).toBytes();
}

/// A public key: an identity as its peers know it.
pub const PublicKey = struct {
    bytes: [length]u8,

    /// The length of a public key.
    pub const length = Ed25519.PublicKey.encoded_length;

    /// The length of a public key as text.
    pub const text_length = (length * 8 + 4) / 5;

    /// The alphabet of a key's text: base32's, lowercase.
    const alphabet = "abcdefghijklmnopqrstuvwxyz234567";

    /// Checks that `signature` is this key's of `message`.
    pub fn verify(key: PublicKey, message: []const u8, signature: [signature_length]u8) !void {
        try Ed25519.Signature.fromBytes(signature).verify(message, try .fromBytes(key.bytes));
    }

    /// Whether the two keys are the same.
    pub fn eql(key: PublicKey, other: PublicKey) bool {
        return std.mem.eql(u8, &key.bytes, &other.bytes);
    }

    /// The key as text: its bytes in base32, lowercase and unpadded — a name for links, hosts and logs, one DNS
    /// label long.
    pub fn text(key: PublicKey) [text_length]u8 {
        var out: [text_length]u8 = undefined;
        var bits: u16 = 0;
        var held: u4 = 0;
        var index: usize = 0;
        for (key.bytes) |byte| {
            bits = (bits << 8) | byte;
            held += 8;
            while (held >= 5) {
                held -= 5;
                out[index] = alphabet[(bits >> held) & 0x1f];
                index += 1;
            }
        }
        if (held > 0) out[index] = alphabet[(bits << (5 - held)) & 0x1f];
        return out;
    }

    /// The key `written` is the text of; an error where it is not one, its every character of the alphabet and its
    /// last one's unused bits clear.
    pub fn parse(written: []const u8) error{InvalidKey}!PublicKey {
        if (written.len != text_length) return error.InvalidKey;
        var key: PublicKey = undefined;
        var bits: u16 = 0;
        var held: u4 = 0;
        var index: usize = 0;
        for (written) |character| {
            const value = std.mem.indexOfScalar(u8, alphabet, character) orelse return error.InvalidKey;
            bits = (bits << 5) | @as(u16, @intCast(value));
            held += 5;
            if (held >= 8) {
                held -= 8;
                key.bytes[index] = @truncate(bits >> held);
                index += 1;
            }
        }
        if (bits & ((@as(u16, 1) << held) - 1) != 0) return error.InvalidKey;
        return key;
    }

    /// Writes the key's text.
    pub fn format(key: PublicKey, writer: *std.Io.Writer) std.Io.Writer.Error!void {
        try writer.writeAll(&key.text());
    }
};

const testing = std.testing;

test "an identity kept by its seed is the same identity" {
    const identity = generate(testing.io);
    const kept = try fromSeed(identity.seed());
    try testing.expect(identity.publicKey().eql(kept.publicKey()));
}

test "a public key checks its identity's signature and no other's" {
    const identity = generate(testing.io);
    const signature = try identity.sign("octoii");
    try identity.publicKey().verify("octoii", signature);
    try testing.expectError(error.SignatureVerificationFailed, identity.publicKey().verify("octoiI", signature));
    try testing.expectError(error.SignatureVerificationFailed, generate(testing.io).publicKey().verify("octoii", signature));
}

test "a key's text is base32, lowercase and unpadded, and reads back as the key" {
    const key: PublicKey = .{ .bytes = @splat(0xff) };
    const written = key.text();
    try testing.expectEqualStrings("777777777777777777777777777777777777777777777777777q", &written);
    try testing.expect(key.eql(try PublicKey.parse(&written)));
    const identity = generate(testing.io);
    try testing.expect(identity.publicKey().eql(try PublicKey.parse(&identity.publicKey().text())));
}

test "text that is no key's is refused" {
    try testing.expectError(error.InvalidKey, PublicKey.parse("short"));
    try testing.expectError(error.InvalidKey, PublicKey.parse("777777777777777777777777777777777777777777777777777A"));
    try testing.expectError(error.InvalidKey, PublicKey.parse("7777777777777777777777777777777777777777777777777777"));
}
