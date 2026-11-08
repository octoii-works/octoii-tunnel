//! The certificate an identity shows in its handshakes: a self-signed X.509 certificate holding the identity's Ed25519
//! public key, the same for every identity but for the key and the signature — no names, no dates that end — as peers
//! know each other by their keys alone, and a handshake's own signature proves the key is held. Both sides of a
//! session show one, the client's as the server asks it.
const std = @import("std");
const Identity = @import("Identity.zig");

/// The length of every identity's certificate.
pub const length = 211;

/// The certificate's TBSCertificate, as DER: version 3, serial number 1, Ed25519, the issuer and the subject both
/// "CN=octoii", valid from 1970 with no end (RFC 5280's 99991231235959Z), and the subject's key, which `make` fills.
const tbs_prefix = [_]u8{
    0x30, 0x81, 0x83, // TBSCertificate, 131 bytes
    0xa0, 0x03, 0x02, 0x01, 0x02, // version: v3
    0x02, 0x01, 0x01, // serialNumber: 1
    0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, // signature: Ed25519
} ++ name ++ validity ++ name ++ [_]u8{
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00, // subjectPublicKeyInfo: Ed25519, its key
};

/// "CN=octoii", the certificate's issuer and subject.
const name = [_]u8{ 0x30, 0x11, 0x31, 0x0f, 0x30, 0x0d, 0x06, 0x03, 0x55, 0x04, 0x03, 0x0c, 0x06 } ++ "octoii".*;

/// From 1970-01-01 with no end.
const validity = [_]u8{ 0x30, 0x20, 0x17, 0x0d } ++ "700101000000Z".* ++ [_]u8{ 0x18, 0x0f } ++ "99991231235959Z".*;

/// The certificate around the TBSCertificate: its outer sequence ahead, its signature's algorithm and bit string after.
const certificate_prefix = [_]u8{ 0x30, 0x81, 0xd0 };
const signature_prefix = [_]u8{ 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x41, 0x00 };

const tbs_length = tbs_prefix.len + Identity.PublicKey.length;

comptime {
    std.debug.assert(tbs_length == 3 + 0x83);
    std.debug.assert(length == certificate_prefix.len + tbs_length + signature_prefix.len + Identity.signature_length);
    std.debug.assert(length == 3 + 0xd0);
}

/// The certificate of `identity`, signed by it.
pub fn make(identity: Identity) ![length]u8 {
    var certificate: [length]u8 = undefined;
    const tbs = certificate[certificate_prefix.len..][0..tbs_length];
    certificate[0..certificate_prefix.len].* = certificate_prefix;
    tbs[0..tbs_prefix.len].* = tbs_prefix;
    tbs[tbs_prefix.len..].* = identity.publicKey().bytes;
    const signature = certificate[certificate_prefix.len + tbs_length ..];
    signature[0..signature_prefix.len].* = signature_prefix;
    signature[signature_prefix.len..].* = try identity.sign(tbs);
    return certificate;
}

/// The public key a peer's certificate holds; an error where it is not a certificate `make` gives — the same bytes but
/// for the key and the signature — so no peer's bytes are parsed beyond that.
pub fn publicKeyOf(certificate: []const u8) error{InvalidCertificate}!Identity.PublicKey {
    if (certificate.len != length) return error.InvalidCertificate;
    const tbs = certificate[certificate_prefix.len..][0..tbs_length];
    const signature = certificate[certificate_prefix.len + tbs_length ..];
    if (!std.mem.eql(u8, certificate[0..certificate_prefix.len], &certificate_prefix) or
        !std.mem.eql(u8, tbs[0..tbs_prefix.len], &tbs_prefix) or
        !std.mem.eql(u8, signature[0..signature_prefix.len], &signature_prefix)) return error.InvalidCertificate;
    return .{ .bytes = tbs[tbs_prefix.len..][0..Identity.PublicKey.length].* };
}

const testing = std.testing;

test "an identity's certificate holds its key, as a peer reads it" {
    const identity = Identity.generate(testing.io);
    const certificate = try make(identity);
    try testing.expect(identity.publicKey().eql(try publicKeyOf(&certificate)));
}

test "an identity's certificate is signed by it, as X.509 reads its signature" {
    const identity = Identity.generate(testing.io);
    const certificate = try make(identity);
    const parsed = try std.crypto.Certificate.parse(.{ .buffer = &certificate, .index = 0 });
    try parsed.verify(parsed, 0);
}

test "what is no certificate of an identity, cut short or changed, is refused" {
    try testing.expectError(error.InvalidCertificate, publicKeyOf("octoii"));
    var certificate = try make(Identity.generate(testing.io));
    try testing.expectError(error.InvalidCertificate, publicKeyOf(certificate[0 .. length - 10]));
    certificate[30] ^= 1;
    try testing.expectError(error.InvalidCertificate, publicKeyOf(&certificate));
}
