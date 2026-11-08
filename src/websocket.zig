//! WebSocket as a peer's link to a relay speaks it, the client's side of RFC 6455: the handshake's key and the
//! server's accept, frames written masked as a client masks them, and messages read whole from the server's frames —
//! unmasked, as a server sends them — a fragmented one gathered across the control frames between its frames.
const std = @import("std");

/// What a frame carries, by its opcode.
pub const Opcode = enum(u4) {
    continuation = 0,
    text = 1,
    binary = 2,
    close = 8,
    ping = 9,
    pong = 10,
    _,

    fn isControl(opcode: Opcode) bool {
        return @backingInt(opcode) >= 8;
    }
};

/// The handshake's key: sixteen random bytes in base64.
pub const Key = [24]u8;

/// The handshake's key of `random`.
pub fn keyOf(random: [16]u8) Key {
    var key: Key = undefined;
    _ = std.base64.standard.Encoder.encode(&key, &random);
    return key;
}

/// What the server answers the handshake's `key` with, as `Sec-WebSocket-Accept`.
pub fn acceptOf(key: []const u8) [28]u8 {
    var sha1 = std.crypto.hash.Sha1.init(.{});
    sha1.update(key);
    sha1.update("258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    var digest: [std.crypto.hash.Sha1.digest_length]u8 = undefined;
    sha1.final(&digest);
    var accept: [28]u8 = undefined;
    _ = std.base64.standard.Encoder.encode(&accept, &digest);
    return accept;
}

/// Writes one frame from the client: final, masked with `mask`.
pub fn writeFrame(writer: *std.Io.Writer, opcode: Opcode, payload: []const u8, mask: [4]u8) std.Io.Writer.Error!void {
    try writer.writeByte(0x80 | @as(u8, @backingInt(opcode)));
    if (payload.len < 126) {
        try writer.writeByte(0x80 | @as(u8, @intCast(payload.len)));
    } else if (payload.len <= std.math.maxInt(u16)) {
        try writer.writeByte(0x80 | 126);
        try writer.writeInt(u16, @intCast(payload.len), .big);
    } else {
        try writer.writeByte(0x80 | 127);
        try writer.writeInt(u64, payload.len, .big);
    }
    try writer.writeAll(&mask);
    var chunk: [512]u8 = undefined;
    var at: usize = 0;
    while (at < payload.len) {
        const length = @min(chunk.len, payload.len - at);
        for (chunk[0..length], payload[at..][0..length], at..) |*out, byte, index| out.* = byte ^ mask[index % 4];
        try writer.writeAll(chunk[0..length]);
        at += length;
    }
}

/// A message read whole: its kind and its bytes — a text's or a binary's in the buffer it was gathered into, a ping's
/// in the reading's own.
pub const Message = union(enum) {
    text: []u8,
    binary: []u8,
    /// A ping, its payload for the pong that answers it.
    ping: []const u8,
    pong,
    /// The server closed the socket.
    close,
};

pub const ReadError = std.Io.Reader.Error || error{ BadFrame, TooLong };

/// The reading of a socket's messages: a message's frames gathered so far, which a control frame between them leaves
/// in place for the next read to go on with.
pub const Reading = struct {
    gathered: usize = 0,
    kind: ?Opcode = null,
    control: [125]u8 = undefined,

    /// The next message from the server, its bytes gathered into `buffer` from as many frames as it came in; a control
    /// frame between them is told as it comes. Every read of one socket takes the same buffer.
    pub fn next(reading: *Reading, reader: *std.Io.Reader, buffer: []u8) ReadError!Message {
        while (true) {
            const head = try reader.takeArray(2);
            const opcode: Opcode = @fromBackingInt(@intCast(@as(u4, @truncate(head[0]))));
            const final = head[0] & 0x80 != 0;
            if (head[0] & 0x70 != 0 or head[1] & 0x80 != 0) return error.BadFrame;
            const length: u64 = switch (head[1] & 0x7f) {
                126 => try reader.takeInt(u16, .big),
                127 => try reader.takeInt(u64, .big),
                else => |short| short,
            };
            if (opcode.isControl()) return reading.controlOf(reader, opcode, final, length);
            if (opcode == .continuation) {
                if (reading.kind == null) return error.BadFrame;
            } else {
                if (reading.kind != null) return error.BadFrame;
                reading.kind = opcode;
            }
            if (length > buffer.len - reading.gathered) return error.TooLong;
            try reader.readSliceAll(buffer[reading.gathered..][0..@intCast(length)]);
            reading.gathered += @intCast(length);
            if (!final) continue;
            const bytes = buffer[0..reading.gathered];
            const kind = reading.kind.?;
            reading.* = .{};
            return switch (kind) {
                .text => .{ .text = bytes },
                .binary => .{ .binary = bytes },
                else => error.BadFrame,
            };
        }
    }

    fn controlOf(reading: *Reading, reader: *std.Io.Reader, opcode: Opcode, final: bool, length: u64) ReadError!Message {
        if (length > reading.control.len or !final) return error.BadFrame;
        const payload = reading.control[0..@intCast(length)];
        try reader.readSliceAll(payload);
        return switch (opcode) {
            .ping => .{ .ping = payload },
            .pong => .pong,
            .close => .close,
            else => error.BadFrame,
        };
    }
};

const testing = std.testing;

/// A server's frame, unmasked, as `readMessage` reads them.
fn serverFrame(writer: *std.Io.Writer, opcode: Opcode, final: bool, payload: []const u8) !void {
    try writer.writeByte(@as(u8, if (final) 0x80 else 0) | @backingInt(opcode));
    if (payload.len < 126) try writer.writeByte(@intCast(payload.len)) else {
        try writer.writeByte(126);
        try writer.writeInt(u16, @intCast(payload.len), .big);
    }
    try writer.writeAll(payload);
}

test "the server's accept of a key is RFC 6455's" {
    try testing.expectEqualStrings("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", &acceptOf("dGhlIHNhbXBsZSBub25jZQ=="));
}

test "a message comes whole from its frames, a ping between them told as it comes" {
    var bytes: [512]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&bytes);
    try serverFrame(&writer, .binary, false, "hello, ");
    try serverFrame(&writer, .ping, true, "are you there");
    try serverFrame(&writer, .continuation, true, "machine");
    try serverFrame(&writer, .text, true, "pong");
    try serverFrame(&writer, .close, true, "");
    var reader: std.Io.Reader = .fixed(writer.buffered());
    var buffer: [64]u8 = undefined;
    var reading: Reading = .{};
    try testing.expectEqualStrings("are you there", (try reading.next(&reader, &buffer)).ping);
    try testing.expectEqualStrings("hello, machine", (try reading.next(&reader, &buffer)).binary);
    try testing.expectEqualStrings("pong", (try reading.next(&reader, &buffer)).text);
    try testing.expectEqual(Message.close, try reading.next(&reader, &buffer));
}

test "a message longer than the buffer, a masked frame, or a continuation of nothing is refused" {
    var bytes: [512]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&bytes);
    try serverFrame(&writer, .binary, true, "longer than the buffer");
    var reader: std.Io.Reader = .fixed(writer.buffered());
    var small: [8]u8 = undefined;
    var reading: Reading = .{};
    try testing.expectError(error.TooLong, reading.next(&reader, &small));
    writer = .fixed(&bytes);
    try writeFrame(&writer, .binary, "masked", .{ 1, 2, 3, 4 });
    reader = .fixed(writer.buffered());
    var buffer: [64]u8 = undefined;
    reading = .{};
    try testing.expectError(error.BadFrame, reading.next(&reader, &buffer));
    writer = .fixed(&bytes);
    try serverFrame(&writer, .continuation, true, "orphan");
    reader = .fixed(writer.buffered());
    reading = .{};
    try testing.expectError(error.BadFrame, reading.next(&reader, &buffer));
}

test "a client's frame unmasks to its payload" {
    var bytes: [512]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&bytes);
    const payload = "a frame of the client's";
    try writeFrame(&writer, .binary, payload, .{ 9, 8, 7, 6 });
    const frame = writer.buffered();
    try testing.expectEqual(0x82, frame[0]);
    try testing.expectEqual(0x80 | payload.len, frame[1]);
    const mask = frame[2..6];
    for (frame[6..], 0..) |byte, index| try testing.expectEqual(payload[index], byte ^ mask[index % 4]);
}
