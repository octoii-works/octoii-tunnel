//! The frames a peer and a relay say to each other, each whole in one message of the link between them: the datagrams
//! a peer sends another by its key, which the relay forwards as from the sender; that a key is not on the relay; and,
//! on a link that does not authenticate its peer itself, the challenge the relay sets and the peer's answer by its key.
const std = @import("std");
const Identity = @import("../Identity.zig");

const Key = Identity.PublicKey;

/// What a frame is, by its first byte.
pub const Type = enum(u8) {
    datagrams = 0x01,
    gone = 0x02,
    challenge = 0x10,
    answer = 0x11,
    welcome = 0x12,
    _,
};

/// The most bytes a frame holds: a batch of datagrams and their lengths.
pub const max_length = 64 * 1024;

/// The most bytes one datagram holds.
pub const max_datagram = 1500;

/// The length of a challenge's nonce.
pub const nonce_length = 32;

/// A frame, read from its bytes, which it points into.
pub const Frame = union(enum) {
    /// Datagrams of the peer of `key`: to it, from a peer; from it, from the relay.
    datagrams: Datagrams,
    /// The peer of this key is not on the relay.
    gone: Key,
    /// The nonce a peer signs to show the relay its key.
    challenge: [nonce_length]u8,
    /// A peer's answer to the challenge: its key and its signature.
    answer: Answer,
    /// The relay took the peer's answer: the peer is on the relay by its key.
    welcome,
};

/// Datagrams to or from a peer, as a frame holds them: each its length, two bytes in network order, then its bytes.
pub const Datagrams = struct {
    key: Key,
    /// The datagrams, as they lie in the frame, each length checked.
    packed_datagrams: []const u8,

    /// The datagrams one by one.
    pub fn iterator(datagrams: Datagrams) Iterator {
        return .{ .rest = datagrams.packed_datagrams };
    }

    pub const Iterator = struct {
        rest: []const u8,

        pub fn next(datagrams: *Iterator) ?[]const u8 {
            if (datagrams.rest.len == 0) return null;
            const length = std.mem.readInt(u16, datagrams.rest[0..2], .big);
            defer datagrams.rest = datagrams.rest[2 + length ..];
            return datagrams.rest[2..][0..length];
        }
    };
};

/// A peer's answer to a challenge.
pub const Answer = struct {
    key: Key,
    signature: [Identity.signature_length]u8,
};

/// The frame `bytes` are; an error where they are not one, each length within them and within bounds.
pub fn decode(bytes: []const u8) error{InvalidFrame}!Frame {
    if (bytes.len == 0 or bytes.len > max_length) return error.InvalidFrame;
    const body = bytes[1..];
    switch (@as(Type, @fromBackingInt(@intCast(bytes[0])))) {
        .datagrams => {
            if (body.len < Key.length) return error.InvalidFrame;
            const packed_datagrams = body[Key.length..];
            var rest = packed_datagrams;
            if (rest.len == 0) return error.InvalidFrame;
            while (rest.len > 0) {
                if (rest.len < 2) return error.InvalidFrame;
                const length = std.mem.readInt(u16, rest[0..2], .big);
                if (length == 0 or length > max_datagram or rest.len < 2 + length) return error.InvalidFrame;
                rest = rest[2 + length ..];
            }
            return .{ .datagrams = .{ .key = .{ .bytes = body[0..Key.length].* }, .packed_datagrams = packed_datagrams } };
        },
        .gone => return .{ .gone = .{ .bytes = (try exactly(body, Key.length)).* } },
        .challenge => return .{ .challenge = (try exactly(body, nonce_length)).* },
        .answer => {
            const answer = try exactly(body, Key.length + Identity.signature_length);
            return .{ .answer = .{ .key = .{ .bytes = answer[0..Key.length].* }, .signature = answer[Key.length..].* } };
        },
        .welcome => {
            _ = try exactly(body, 0);
            return .welcome;
        },
        _ => return error.InvalidFrame,
    }
}

fn exactly(body: []const u8, comptime length: usize) error{InvalidFrame}!*const [length]u8 {
    if (body.len != length) return error.InvalidFrame;
    return body[0..length];
}

/// Writes a frame of datagrams for the peer of `key`, as many of `datagrams` as fit, from the first; how many.
pub fn writeDatagrams(writer: *std.Io.Writer, key: Key, datagrams: []const []const u8) std.Io.Writer.Error!usize {
    try writer.writeByte(@backingInt(Type.datagrams));
    try writer.writeAll(&key.bytes);
    var length: usize = 1 + Key.length;
    for (datagrams, 0..) |datagram, index| {
        std.debug.assert(datagram.len > 0 and datagram.len <= max_datagram);
        if (index > 0 and length + 2 + datagram.len > max_length) return index;
        try writer.writeInt(u16, @intCast(datagram.len), .big);
        try writer.writeAll(datagram);
        length += 2 + datagram.len;
    }
    return datagrams.len;
}

/// Writes the frame telling that the peer of `key` is not on the relay.
pub fn writeGone(writer: *std.Io.Writer, key: Key) std.Io.Writer.Error!void {
    try writer.writeByte(@backingInt(Type.gone));
    try writer.writeAll(&key.bytes);
}

/// Writes a relay's challenge of `nonce`.
pub fn writeChallenge(writer: *std.Io.Writer, nonce: [nonce_length]u8) std.Io.Writer.Error!void {
    try writer.writeByte(@backingInt(Type.challenge));
    try writer.writeAll(&nonce);
}

/// Writes a peer's answer to a challenge.
pub fn writeAnswer(writer: *std.Io.Writer, answer: Answer) std.Io.Writer.Error!void {
    try writer.writeByte(@backingInt(Type.answer));
    try writer.writeAll(&answer.key.bytes);
    try writer.writeAll(&answer.signature);
}

/// Writes the frame telling a peer the relay took its answer.
pub fn writeWelcome(writer: *std.Io.Writer) std.Io.Writer.Error!void {
    try writer.writeByte(@backingInt(Type.welcome));
}

/// Makes a peer's frame of datagrams to another the relay's frame of them from the peer, in place: the key the frame
/// begins with is the sender's.
pub fn forwardFrom(bytes: []u8, sender: Key) void {
    std.debug.assert(bytes[0] == @backingInt(Type.datagrams));
    bytes[1..][0..Key.length].* = sender.bytes;
}

const testing = std.testing;

test "a frame of datagrams reads back as its datagrams, in order, for its key" {
    var buffer: [256]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&buffer);
    const key: Key = .{ .bytes = @splat(7) };
    try testing.expectEqual(3, try writeDatagrams(&writer, key, &.{ "one", "two", "three" }));
    const frame = try decode(writer.buffered());
    try testing.expect(frame.datagrams.key.eql(key));
    var datagrams = frame.datagrams.iterator();
    for ([_][]const u8{ "one", "two", "three" }) |expected| try testing.expectEqualStrings(expected, datagrams.next().?);
    try testing.expectEqual(null, datagrams.next());
}

test "a frame of datagrams takes as many as fit, the rest for the next" {
    var buffer: [max_length + 2048]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&buffer);
    const datagram: [max_datagram]u8 = @splat(1);
    const datagrams: [50][]const u8 = @splat(&datagram);
    const taken = try writeDatagrams(&writer, .{ .bytes = @splat(0) }, &datagrams);
    try testing.expect(taken > 1 and taken < datagrams.len);
    try testing.expect(writer.buffered().len <= max_length);
    _ = try decode(writer.buffered());
}

test "the frames of the challenge read back as written" {
    var buffer: [256]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&buffer);
    try writeChallenge(&writer, @splat(3));
    try testing.expectEqualSlices(u8, &@as([nonce_length]u8, @splat(3)), &(try decode(writer.buffered())).challenge);
    writer = .fixed(&buffer);
    const answer: Answer = .{ .key = .{ .bytes = @splat(4) }, .signature = @splat(5) };
    try writeAnswer(&writer, answer);
    try testing.expectEqual(answer, (try decode(writer.buffered())).answer);
    writer = .fixed(&buffer);
    try writeWelcome(&writer);
    try testing.expectEqual(Frame.welcome, try decode(writer.buffered()));
    writer = .fixed(&buffer);
    try writeGone(&writer, .{ .bytes = @splat(6) });
    try testing.expect((try decode(writer.buffered())).gone.eql(.{ .bytes = @splat(6) }));
}

test "a frame forwarded names its sender where it named its addressee" {
    var buffer: [64]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&buffer);
    _ = try writeDatagrams(&writer, .{ .bytes = @splat(1) }, &.{"hi"});
    const bytes = writer.buffered();
    forwardFrom(bytes, .{ .bytes = @splat(2) });
    const frame = try decode(bytes);
    try testing.expect(frame.datagrams.key.eql(.{ .bytes = @splat(2) }));
    var datagrams = frame.datagrams.iterator();
    try testing.expectEqualStrings("hi", datagrams.next().?);
}

test "what is no frame — empty, of no type, cut short, or a datagram's length past its end — is refused" {
    try testing.expectError(error.InvalidFrame, decode(""));
    try testing.expectError(error.InvalidFrame, decode("\x7f"));
    try testing.expectError(error.InvalidFrame, decode("\x02short"));
    try testing.expectError(error.InvalidFrame, decode("\x12extra"));
    var bytes: [1 + 32 + 2 + 1]u8 = @splat(0);
    bytes[0] = @backingInt(Type.datagrams);
    bytes[33] = 0;
    bytes[34] = 9;
    try testing.expectError(error.InvalidFrame, decode(&bytes));
    try testing.expectError(error.InvalidFrame, decode(bytes[0..33]));
}

fn repeated(comptime byte: u8, comptime count: usize) [count]u8 {
    return @splat(byte);
}

test "decoding takes whatever bytes it is given: a frame whole, or refused" {
    try testing.fuzz({}, fuzzDecode, .{ .corpus = &.{ "\x01" ++ repeated('k', 32) ++ "\x00\x02hi", "\x11" ++ repeated('a', 96), "\x12", "\x02" ++ repeated('g', 32) } });
}

fn fuzzDecode(_: void, smith: *testing.Smith) anyerror!void {
    var buffer: [4096]u8 = undefined;
    const frame = decode(buffer[0..smith.slice(&buffer)]) catch return;
    if (frame == .datagrams) {
        var datagrams = frame.datagrams.iterator();
        while (datagrams.next()) |datagram| try testing.expect(datagram.len > 0 and datagram.len <= max_datagram);
    }
}
