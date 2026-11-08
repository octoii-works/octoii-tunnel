//! QUIC's variable-length integers (RFC 9000, section 16), which HTTP/3 writes its frames' types and lengths, its
//! settings and its streams' types in: the two high bits of the first byte tell how many bytes it takes — one, two,
//! four or eight — and the rest of them, in network order, its value.
const std = @import("std");

const Io = std.Io;

/// The largest value one holds.
pub const max: u64 = (1 << 62) - 1;

/// The most bytes one takes.
pub const max_length = 8;

/// How many bytes `value` takes, written as short as it goes.
pub fn lengthOf(value: u64) usize {
    std.debug.assert(value <= max);
    if (value < 1 << 6) return 1;
    if (value < 1 << 14) return 2;
    if (value < 1 << 30) return 4;
    return 8;
}

/// Writes `value` as short as it goes.
pub fn write(writer: *Io.Writer, value: u64) Io.Writer.Error!void {
    switch (lengthOf(value)) {
        1 => try writer.writeByte(@intCast(value)),
        2 => try writer.writeInt(u16, @as(u16, @intCast(value)) | 0x4000, .big),
        4 => try writer.writeInt(u32, @as(u32, @intCast(value)) | 0x8000_0000, .big),
        8 => try writer.writeInt(u64, value | 0xc000_0000_0000_0000, .big),
        else => unreachable,
    }
}

/// Reads one, taking none of its bytes where they have not all come.
pub fn read(reader: *Io.Reader) Io.Reader.Error!u64 {
    const length = @as(usize, 1) << @intCast((try reader.peekByte()) >> 6);
    const bytes = try reader.take(length);
    var value: u64 = bytes[0] & 0x3f;
    for (bytes[1..]) |byte| value = value << 8 | byte;
    return value;
}

const testing = std.testing;

fn decoded(bytes: []const u8) !u64 {
    var reader: Io.Reader = .fixed(bytes);
    const value = try read(&reader);
    try testing.expectEqual(bytes.len, reader.seek);
    return value;
}

test "the integers of RFC 9000's examples read as it reads them, whatever their length" {
    try testing.expectEqual(151_288_809_941_952_652, try decoded("\xc2\x19\x7c\x5e\xff\x14\xe8\x8c"));
    try testing.expectEqual(494_878_333, try decoded("\x9d\x7f\x3e\x7d"));
    try testing.expectEqual(15_293, try decoded("\x7b\xbd"));
    try testing.expectEqual(37, try decoded("\x25"));
    try testing.expectEqual(37, try decoded("\x40\x25"));
}

test "an integer is written as short as it goes, and reads back" {
    var buffer: [max_length]u8 = undefined;
    for ([_]u64{ 0, 63, 64, 16_383, 16_384, (1 << 30) - 1, 1 << 30, max }, [_]usize{ 1, 1, 2, 2, 4, 4, 8, 8 }) |value, length| {
        var writer: Io.Writer = .fixed(&buffer);
        try write(&writer, value);
        try testing.expectEqual(length, writer.buffered().len);
        try testing.expectEqual(value, try decoded(writer.buffered()));
    }
}

test "an integer cut short takes nothing of what came" {
    var reader: Io.Reader = .fixed("\x9d\x7f\x3e");
    try testing.expectError(error.EndOfStream, read(&reader));
    try testing.expectEqual(0, reader.seek);
}
