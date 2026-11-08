//! QPACK (RFC 9204) as the tunnel's HTTP/3 speaks it: field sections by the static table alone — a dynamic table of
//! no capacity, so no encoder or decoder stream ever carries anything and no section waits on one. A section is written
//! each field line by the table's index where the table holds it whole, by the index of its name where the table
//! holds that, and else literally, no string by Huffman's code; and read whole from a HEADERS frame's payload, every
//! field line checked, a field's name and value then pointing into the payload or the table.
const std = @import("std");
const static_table = @import("static_table.zig");
const ProtocolError = @import("code.zig").ProtocolError;

const Io = std.Io;
const Field = std.http.Header;

/// Writes the field section of the fields of `groups`, in order, each name as HTTP/3 spells it, in lowercase.
pub fn write(writer: *Io.Writer, groups: []const []const Field) Io.Writer.Error!void {
    // Required Insert Count and Base, both none: the section refers to no dynamic table.
    try writer.writeAll(&.{ 0x00, 0x00 });
    for (groups) |fields| for (fields) |field| switch (match(field)) {
        .field => |index| try writeInteger(writer, 0b1100_0000, 6, index),
        .name => |index| {
            try writeInteger(writer, 0b0101_0000, 4, index);
            try writeString(writer, field.value);
        },
        .none => {
            try writeInteger(writer, 0b0010_0000, 3, field.name.len);
            for (field.name) |char| try writer.writeByte(std.ascii.toLower(char));
            try writeString(writer, field.value);
        },
    };
}

/// What the static table holds of a field: the field whole, its name, or nothing.
const Match = union(enum) { field: u64, name: u64, none };

fn match(field: Field) Match {
    var name: ?u64 = null;
    for (static_table.entries, 0..) |entry, index| {
        if (!std.ascii.eqlIgnoreCase(entry.name, field.name)) continue;
        if (std.mem.eql(u8, entry.value, field.value)) return .{ .field = index };
        name = name orelse index;
    }
    return if (name) |index| .{ .name = index } else .none;
}

/// Writes `value`, a string not of Huffman's code.
fn writeString(writer: *Io.Writer, value: []const u8) Io.Writer.Error!void {
    try writeInteger(writer, 0, 7, value.len);
    try writer.writeAll(value);
}

/// Writes `value` as an integer of an `n`-bit prefix (RFC 7541, section 5.1), the first byte's other bits `flags`.
fn writeInteger(writer: *Io.Writer, flags: u8, comptime n: u4, value: u64) Io.Writer.Error!void {
    const mask: u8 = @intCast((@as(u16, 1) << n) - 1);
    if (value < mask) return writer.writeByte(flags | @as(u8, @intCast(value)));
    try writer.writeByte(flags | mask);
    var rest = value - mask;
    while (rest >= 0x80) : (rest >>= 7) try writer.writeByte(@as(u8, @truncate(rest)) | 0x80);
    try writer.writeByte(@intCast(rest));
}

/// A field section read from a HEADERS frame's payload, every field line of it checked.
pub const Section = struct {
    /// The field lines, as they lie in the payload.
    lines: []const u8,

    /// The section `payload` holds; `DecompressionFailed` where it does not decode by the static table alone.
    pub fn decode(payload: []const u8) ProtocolError!Section {
        var reader: Io.Reader = .fixed(payload);
        // Required Insert Count, none where no line refers to the dynamic table; and Base, of no meaning then.
        if (try readInteger(&reader, try takeByte(&reader), 8) != 0) return error.DecompressionFailed;
        _ = try readInteger(&reader, try takeByte(&reader), 7);
        const section: Section = .{ .lines = payload[reader.seek..] };
        var lines = section.iterator();
        while (try lines.nextChecked()) |_| {}
        return section;
    }

    /// The section's fields, one by one.
    pub fn iterator(section: Section) Iterator {
        return .{ .reader = .fixed(section.lines) };
    }

    pub const Iterator = struct {
        reader: Io.Reader,

        pub fn next(lines: *Iterator) ?Field {
            return lines.nextChecked() catch unreachable;
        }

        fn nextChecked(lines: *Iterator) ProtocolError!?Field {
            const reader = &lines.reader;
            const first = reader.takeByte() catch return null;
            if (first & 0b1000_0000 != 0) {
                if (first & 0b0100_0000 == 0) return error.DecompressionFailed;
                return try entryOf(try readInteger(reader, first, 6));
            }
            if (first & 0b0100_0000 != 0) {
                if (first & 0b0001_0000 == 0) return error.DecompressionFailed;
                const entry = try entryOf(try readInteger(reader, first, 4));
                return .{ .name = entry.name, .value = try readString(reader) };
            }
            if (first & 0b0010_0000 != 0) {
                const name = try readStringOf(reader, first, 3);
                return .{ .name = name, .value = try readString(reader) };
            }
            // A field line by a post-base index, of the dynamic table.
            return error.DecompressionFailed;
        }
    };
};

fn entryOf(index: u64) ProtocolError!Field {
    if (index >= static_table.entries.len) return error.DecompressionFailed;
    const entry = static_table.entries[@intCast(index)];
    return .{ .name = entry.name, .value = entry.value };
}

/// Reads a string whose length is an integer of a 7-bit prefix.
fn readString(reader: *Io.Reader) ProtocolError![]const u8 {
    return readStringOf(reader, try takeByte(reader), 7);
}

fn takeByte(reader: *Io.Reader) ProtocolError!u8 {
    return reader.takeByte() catch error.DecompressionFailed;
}

/// Reads a string whose length is an integer of an `n`-bit prefix, the bit above it telling Huffman's code, which
/// the tunnel's peers do not use.
fn readStringOf(reader: *Io.Reader, first: u8, comptime n: u4) ProtocolError![]const u8 {
    if (first & (@as(u8, 1) << n) != 0) return error.DecompressionFailed;
    const length = try readInteger(reader, first, n);
    if (length > reader.bufferedLen()) return error.DecompressionFailed;
    return reader.take(@intCast(length)) catch unreachable;
}

/// Reads an integer of an `n`-bit prefix, `first` its first byte.
fn readInteger(reader: *Io.Reader, first: u8, comptime n: u4) ProtocolError!u64 {
    const mask: u8 = @intCast((@as(u16, 1) << n) - 1);
    var value: u64 = first & mask;
    if (value < mask) return value;
    var shift: u6 = 0;
    while (true) {
        const byte = try takeByte(reader);
        if (shift > 56) return error.DecompressionFailed;
        value = std.math.add(u64, value, @as(u64, byte & 0x7f) << shift) catch return error.DecompressionFailed;
        if (byte & 0x80 == 0) return value;
        shift += 7;
    }
}

const testing = std.testing;

fn encoded(fields: []const Field, buffer: []u8) ![]const u8 {
    var writer: Io.Writer = .fixed(buffer);
    try write(&writer, &.{fields});
    return writer.buffered();
}

test "a field the table holds the name of is written as RFC 9204's example writes it" {
    var buffer: [64]u8 = undefined;
    try testing.expectEqualSlices(u8, "\x00\x00\x51\x0b/index.html", try encoded(&.{.{ .name = ":path", .value = "/index.html" }}, &buffer));
}

test "a section reads back as written: fields the table holds by its index, their names by it, the rest literally" {
    var buffer: [256]u8 = undefined;
    const fields = [_]Field{
        .{ .name = ":method", .value = "GET" },
        .{ .name = ":status", .value = "200" },
        .{ .name = ":authority", .value = "machine" },
        .{ .name = "X-Octoii-Long-Name-Of-Its-Own", .value = "a value longer than a prefix of seven bits takes, and then some, to be sure of it" },
    };
    const bytes = try encoded(&fields, &buffer);
    try testing.expectEqual(0xc0 | 17, bytes[2]);
    try testing.expectEqual(0xc0 | 25, bytes[3]);
    const section = try Section.decode(bytes);
    var lines = section.iterator();
    for (fields) |field| {
        const line = lines.next().?;
        var lowercase: [64]u8 = undefined;
        try testing.expectEqualStrings(std.ascii.lowerString(&lowercase, field.name), line.name);
        try testing.expectEqualStrings(field.value, line.value);
    }
    try testing.expectEqual(null, lines.next());
}

test "a section of the dynamic table, of Huffman's code, of an index past the table, or cut short is refused" {
    try testing.expectError(error.DecompressionFailed, Section.decode("\x01\x00"));
    try testing.expectEqual(0, (try Section.decode("\x00\x7f\x05")).lines.len);
    try testing.expectError(error.DecompressionFailed, Section.decode("\x00\x00\x80"));
    try testing.expectError(error.DecompressionFailed, Section.decode("\x00\x00\x10"));
    try testing.expectError(error.DecompressionFailed, Section.decode("\x00\x00\x40\x01v"));
    try testing.expectError(error.DecompressionFailed, Section.decode("\x00\x00\x51\x81\x00"));
    try testing.expectError(error.DecompressionFailed, Section.decode("\x00\x00\xff\x7f"));
    try testing.expectError(error.DecompressionFailed, Section.decode("\x00\x00\x51\x0b/index"));
    try testing.expectError(error.DecompressionFailed, Section.decode("\x00"));
}

test "decoding takes whatever bytes it is given: a section whole, or refused" {
    try testing.fuzz({}, fuzzDecode, .{ .corpus = &.{ "\x00\x00\xd1\x51\x0b/index.html", "\x00\x00\x27\x01x-custom\x01v" } });
}

fn fuzzDecode(_: void, smith: *testing.Smith) anyerror!void {
    var buffer: [4096]u8 = undefined;
    const section = Section.decode(buffer[0..smith.slice(&buffer)]) catch return;
    var lines = section.iterator();
    while (lines.next()) |_| {}
}
