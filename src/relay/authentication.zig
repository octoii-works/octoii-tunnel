//! A peer showing a relay its key on a link that does not authenticate the peer itself, as a WebSocket does not: the
//! relay sets a fresh nonce, and the peer signs it with the relay's host by its identity, so no answer serves another
//! link or another relay.
const std = @import("std");
const Identity = @import("../Identity.zig");
const frame = @import("frame.zig");

/// What every answer's signature is of, ahead of the relay's host and the nonce.
const context = "octoii relay authentication";

/// The longest host a relay has, as DNS allows.
const max_host = 253;

/// The message a peer signs to answer the relay at `host` that set `nonce`.
fn messageOf(buffer: *[context.len + 1 + max_host + 1 + frame.nonce_length]u8, host: []const u8, challenge: [frame.nonce_length]u8) error{InvalidHost}![]const u8 {
    if (host.len == 0 or host.len > max_host) return error.InvalidHost;
    var writer: std.Io.Writer = .fixed(buffer);
    writer.writeAll(context ++ "\x00") catch unreachable;
    writer.writeAll(host) catch unreachable;
    writer.writeByte(0) catch unreachable;
    writer.writeAll(&challenge) catch unreachable;
    return writer.buffered();
}

/// A fresh nonce for a challenge, drawn from `io`.
pub fn nonce(io: std.Io) [frame.nonce_length]u8 {
    var drawn: [frame.nonce_length]u8 = undefined;
    io.random(&drawn);
    return drawn;
}

/// `identity`'s answer to the challenge of `nonce` set by the relay at `host`.
pub fn answer(identity: Identity, host: []const u8, challenge: [frame.nonce_length]u8) !frame.Answer {
    var buffer: [context.len + 1 + max_host + 1 + frame.nonce_length]u8 = undefined;
    return .{ .key = identity.publicKey(), .signature = try identity.sign(try messageOf(&buffer, host, challenge)) };
}

/// Checks that `given` answers the challenge of `nonce` that the relay at `host` set, by the key it names.
pub fn check(given: frame.Answer, host: []const u8, challenge: [frame.nonce_length]u8) !void {
    var buffer: [context.len + 1 + max_host + 1 + frame.nonce_length]u8 = undefined;
    try given.key.verify(try messageOf(&buffer, host, challenge), given.signature);
}

const testing = std.testing;

test "a peer's answer holds for the challenge and the relay it answered, and for no other" {
    const identity = Identity.generate(testing.io);
    const challenge = nonce(testing.io);
    const given = try answer(identity, "relay.octoii.dev", challenge);
    try testing.expect(given.key.eql(identity.publicKey()));
    try check(given, "relay.octoii.dev", challenge);
    try testing.expectError(error.SignatureVerificationFailed, check(given, "relay.elsewhere.dev", challenge));
    try testing.expectError(error.SignatureVerificationFailed, check(given, "relay.octoii.dev", nonce(testing.io)));
    var forged = given;
    forged.key = Identity.generate(testing.io).publicKey();
    try testing.expectError(error.SignatureVerificationFailed, check(forged, "relay.octoii.dev", challenge));
}

test "a relay of no host is refused" {
    try testing.expectError(error.InvalidHost, answer(Identity.generate(testing.io), "", nonce(testing.io)));
}
