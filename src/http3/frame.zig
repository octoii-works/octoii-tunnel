//! HTTP/3's frames (RFC 9114, section 7): each its type and its payload's length, two variable-length integers, then
//! its payload. A stream's frames are read as its bytes come — a frame of a type HTTP/3 knows whole, a DATA frame's
//! payload as much of it as has come, a frame of a type it does not know skipped — and written; and the payloads of the
//! frames the session's control stream carries read and written: its settings, and the identifiers the others name.
const std = @import("std");
const varint = @import("varint.zig");
const ProtocolError = @import("code.zig").ProtocolError;

const Io = std.Io;

/// What a frame is, by its type.
pub const Type = enum(u64) {
    data = 0x00,
    headers = 0x01,
    cancel_push = 0x03,
    settings = 0x04,
    push_promise = 0x05,
    goaway = 0x07,
    max_push_id = 0x0d,
    _,

    /// Whether the type is one HTTP/2 had and HTTP/3 has not, which no frame may have.
    fn isReserved(type_: Type) bool {
        return switch (@backingInt(type_)) {
            0x02, 0x06, 0x08, 0x09 => true,
            else => false,
        };
    }
};

/// The most bytes a frame's type and length take.
pub const max_head = 2 * varint.max_length;

/// Writes the head of a frame of `type_` whose payload is `length` bytes.
pub fn writeHead(writer: *Io.Writer, type_: Type, length: u64) Io.Writer.Error!void {
    try varint.write(writer, @backingInt(type_));
    try varint.write(writer, length);
}

/// Writes a frame whole: its head, then `payload`.
pub fn write(writer: *Io.Writer, type_: Type, payload: []const u8) Io.Writer.Error!void {
    try writeHead(writer, type_, payload.len);
    try writer.writeAll(payload);
}

/// A frame of a type HTTP/3 knows, other than DATA, whole: its type and its payload.
pub const Frame = struct {
    type: Type,
    payload: []const u8,
};

/// What the next of a stream's bytes are.
pub const Piece = union(enum) {
    /// Bytes of a DATA frame's payload: as many as came, or as were asked for.
    data: []const u8,
    /// A frame other than DATA, whole.
    frame: Frame,
    /// Nothing whole: more is to come.
    incomplete,
};

/// A piece read, and how many of the bytes it was read from it took — every one of them the reader's to let go, a
/// piece's own after it is done with them.
pub const Step = struct {
    consumed: usize,
    piece: Piece,
};

/// The reading of one stream's frames as its bytes come: where in a frame the reading is, between one frame and the
/// next, or within a DATA frame's payload or a skipped frame's — its frames' heads, and every frame taken whole, read
/// only once all their bytes have come.
pub const Framing = struct {
    within: Within = .between,
    /// The longest payload of a frame taken whole.
    max_whole: usize,

    const Within = union(enum) {
        between,
        /// What is left of a DATA frame's payload.
        data: u64,
        /// What is left of the payload of a frame of a type HTTP/3 does not know.
        skipped: u64,
    };

    /// A reading of frames, those taken whole at most `max_whole` bytes long.
    pub fn init(max_whole: usize) Framing {
        return .{ .max_whole = max_whole };
    }

    /// The next piece of `bytes`, the stream's bytes not yet taken, a DATA frame's at most `most` of them; what the
    /// reading skips on the way is taken with it.
    pub fn next(framing: *Framing, bytes: []const u8, most: usize) ProtocolError!Step {
        std.debug.assert(most > 0);
        var consumed: usize = 0;
        while (true) {
            const rest = bytes[consumed..];
            switch (framing.within) {
                .data => |left| {
                    const length: usize = @intCast(@min(left, rest.len, most));
                    if (length == 0) return .{ .consumed = consumed, .piece = .incomplete };
                    framing.within = if (length == left) .between else .{ .data = left - length };
                    return .{ .consumed = consumed + length, .piece = .{ .data = rest[0..length] } };
                },
                .skipped => |left| {
                    const length: usize = @intCast(@min(left, rest.len));
                    consumed += length;
                    if (length < left) {
                        framing.within = .{ .skipped = left - length };
                        return .{ .consumed = consumed, .piece = .incomplete };
                    }
                    framing.within = .between;
                },
                .between => {
                    var reader: Io.Reader = .fixed(rest);
                    const type_: Type = @fromBackingInt(varint.read(&reader) catch return .{ .consumed = consumed, .piece = .incomplete });
                    const length = varint.read(&reader) catch return .{ .consumed = consumed, .piece = .incomplete };
                    const head = reader.seek;
                    if (type_.isReserved()) return error.FrameUnexpected;
                    switch (type_) {
                        .data => {
                            consumed += head;
                            if (length > 0) framing.within = .{ .data = length };
                        },
                        .headers, .cancel_push, .settings, .push_promise, .goaway, .max_push_id => {
                            if (length > framing.max_whole) return error.ExcessiveLoad;
                            if (rest.len - head < length) return .{ .consumed = consumed, .piece = .incomplete };
                            const payload = rest[head..][0..@intCast(length)];
                            return .{ .consumed = consumed + head + payload.len, .piece = .{ .frame = .{ .type = type_, .payload = payload } } };
                        },
                        _ => {
                            consumed += head;
                            if (length > 0) framing.within = .{ .skipped = length };
                        },
                    }
                },
            }
        }
    }

    /// Whether the reading is between frames, where a stream may end.
    pub fn isBetween(framing: Framing) bool {
        return framing.within == .between;
    }
};

/// An endpoint's settings (RFC 9114, section 7.2.4; RFC 9204, section 5; RFC 8441, section 3), each at its initial
/// value till the endpoint says otherwise.
pub const Settings = struct {
    /// The capacity of QPACK's dynamic table the endpoint's decoder allows.
    qpack_max_table_capacity: u64 = 0,
    /// The largest field section the endpoint takes; null for no limit.
    max_field_section_size: ?u64 = null,
    /// How many streams the endpoint's decoder lets wait on its dynamic table.
    qpack_blocked_streams: u64 = 0,
    /// Whether the endpoint takes a CONNECT naming the protocol it opens, as a WebSocket over HTTP/3 is opened.
    enable_connect_protocol: bool = false,

    /// The identifiers of the settings HTTP/3 knows.
    const Identifier = enum(u64) {
        qpack_max_table_capacity = 0x01,
        max_field_section_size = 0x06,
        qpack_blocked_streams = 0x07,
        enable_connect_protocol = 0x08,
        _,

        /// Whether the identifier is one HTTP/2 had and HTTP/3 has not, which no endpoint may send.
        fn isReserved(identifier: Identifier) bool {
            return switch (@backingInt(identifier)) {
                0x00, 0x02, 0x03, 0x04, 0x05 => true,
                else => false,
            };
        }
    };

    /// The settings a SETTINGS frame's `payload` says, each HTTP/3 does not know ignored.
    pub fn decode(payload: []const u8) ProtocolError!Settings {
        var settings: Settings = .{};
        var seen: std.EnumSet(std.meta.FieldEnum(Settings)) = .empty;
        var reader: Io.Reader = .fixed(payload);
        while (reader.seek < payload.len) {
            const identifier: Identifier = @fromBackingInt(varint.read(&reader) catch return error.MalformedFrame);
            const value = varint.read(&reader) catch return error.MalformedFrame;
            if (identifier.isReserved()) return error.BadSettings;
            const field: std.meta.FieldEnum(Settings) = switch (identifier) {
                .qpack_max_table_capacity => .qpack_max_table_capacity,
                .max_field_section_size => .max_field_section_size,
                .qpack_blocked_streams => .qpack_blocked_streams,
                .enable_connect_protocol => .enable_connect_protocol,
                _ => continue,
            };
            if (seen.contains(field)) return error.BadSettings;
            seen.insert(field);
            switch (field) {
                .qpack_max_table_capacity => settings.qpack_max_table_capacity = value,
                .max_field_section_size => settings.max_field_section_size = value,
                .qpack_blocked_streams => settings.qpack_blocked_streams = value,
                .enable_connect_protocol => settings.enable_connect_protocol = switch (value) {
                    0 => false,
                    1 => true,
                    else => return error.BadSettings,
                },
            }
        }
        return settings;
    }

    /// Writes a SETTINGS frame of the settings not at their initial values.
    pub fn write(settings: Settings, writer: *Io.Writer) Io.Writer.Error!void {
        var buffer: [4 * 2 * varint.max_length]u8 = undefined;
        var payload: Io.Writer = .fixed(&buffer);
        const initial: Settings = .{};
        inline for (.{ "qpack_max_table_capacity", "qpack_blocked_streams" }) |name| {
            if (@field(settings, name) != @field(initial, name)) {
                varint.write(&payload, @backingInt(@field(Identifier, name))) catch unreachable;
                varint.write(&payload, @field(settings, name)) catch unreachable;
            }
        }
        if (settings.max_field_section_size) |size| {
            varint.write(&payload, @backingInt(Identifier.max_field_section_size)) catch unreachable;
            varint.write(&payload, size) catch unreachable;
        }
        if (settings.enable_connect_protocol) {
            varint.write(&payload, @backingInt(Identifier.enable_connect_protocol)) catch unreachable;
            varint.write(&payload, 1) catch unreachable;
        }
        try write_(writer, .settings, payload.buffered());
    }
};

const write_ = write;

/// The identifier a GOAWAY, MAX_PUSH_ID or CANCEL_PUSH frame's `payload` is: one variable-length integer, all of it.
pub fn identifierOf(payload: []const u8) ProtocolError!u64 {
    var reader: Io.Reader = .fixed(payload);
    const identifier = varint.read(&reader) catch return error.MalformedFrame;
    if (reader.seek != payload.len) return error.MalformedFrame;
    return identifier;
}

/// Writes a frame of `type_` whose payload is `identifier`, as a GOAWAY is.
pub fn writeIdentifier(writer: *Io.Writer, type_: Type, identifier: u64) Io.Writer.Error!void {
    try writeHead(writer, type_, varint.lengthOf(identifier));
    try varint.write(writer, identifier);
}

const testing = std.testing;

/// The pieces of `bytes`, read as they come one byte at a time, DATA frames' bytes joined; each frame's payload
/// copied into `frames`.
fn readTrickled(bytes: []const u8, data: *Io.Writer, frames: *std.ArrayList(Frame), arena: std.mem.Allocator) !void {
    var framing: Framing = .init(64);
    var taken: usize = 0;
    var came: usize = 0;
    while (came <= bytes.len) {
        const step = try framing.next(bytes[taken..came], 1024);
        taken += step.consumed;
        switch (step.piece) {
            .data => |piece| try data.writeAll(piece),
            .frame => |frame| try frames.append(arena, .{ .type = frame.type, .payload = try arena.dupe(u8, frame.payload) }),
            .incomplete => came += 1,
        }
    }
    try testing.expect(framing.isBetween());
    try testing.expectEqual(bytes.len, taken);
}

test "a stream's frames read as they come, a byte at a time: DATA as it comes, the others whole, unknown ones skipped" {
    var arena_state: std.heap.ArenaAllocator = .init(testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var buffer: [256]u8 = undefined;
    var writer: Io.Writer = .fixed(&buffer);
    try write(&writer, .headers, "head");
    try write(&writer, .data, "hello, ");
    try write(&writer, @fromBackingInt(0x21), "a grease frame, of no meaning");
    try write(&writer, .data, "");
    try write(&writer, .data, "machine");
    try writeIdentifier(&writer, .goaway, 16_384);
    var data_buffer: [64]u8 = undefined;
    var data: Io.Writer = .fixed(&data_buffer);
    var frames: std.ArrayList(Frame) = .empty;
    try readTrickled(writer.buffered(), &data, &frames, arena);
    try testing.expectEqualStrings("hello, machine", data.buffered());
    try testing.expectEqual(2, frames.items.len);
    try testing.expectEqual(Type.headers, frames.items[0].type);
    try testing.expectEqualStrings("head", frames.items[0].payload);
    try testing.expectEqual(16_384, try identifierOf(frames.items[1].payload));
}

test "a DATA frame's payload is read no more than asked for at a time" {
    var buffer: [64]u8 = undefined;
    var writer: Io.Writer = .fixed(&buffer);
    try write(&writer, .data, "abcdef");
    var framing: Framing = .init(64);
    const bytes = writer.buffered();
    const first = try framing.next(bytes, 4);
    try testing.expectEqualStrings("abcd", first.piece.data);
    try testing.expect(!framing.isBetween());
    const second = try framing.next(bytes[first.consumed..], 4);
    try testing.expectEqualStrings("ef", second.piece.data);
    try testing.expect(framing.isBetween());
}

test "a frame of a type HTTP/2 had, or too long to take whole, is refused" {
    var framing: Framing = .init(8);
    try testing.expectError(error.FrameUnexpected, framing.next("\x02\x00", 1));
    framing = .init(8);
    try testing.expectError(error.ExcessiveLoad, framing.next("\x01\x09", 1));
}

test "settings read back as written, those HTTP/3 does not know ignored" {
    var buffer: [64]u8 = undefined;
    var writer: Io.Writer = .fixed(&buffer);
    const settings: Settings = .{ .max_field_section_size = 65_536, .enable_connect_protocol = true };
    try settings.write(&writer);
    var framing: Framing = .init(64);
    const frame = (try framing.next(writer.buffered(), 1)).piece.frame;
    try testing.expectEqual(Type.settings, frame.type);
    try testing.expectEqual(settings, try Settings.decode(frame.payload));
    try testing.expectEqual(Settings{ .qpack_blocked_streams = 3 }, try Settings.decode("\x21\x05\x07\x03"));
}

test "settings named twice, reserved, of a value they cannot have, or cut short are refused" {
    try testing.expectError(error.BadSettings, Settings.decode("\x06\x01\x06\x02"));
    try testing.expectError(error.BadSettings, Settings.decode("\x02\x00"));
    try testing.expectError(error.BadSettings, Settings.decode("\x08\x02"));
    try testing.expectError(error.MalformedFrame, Settings.decode("\x06"));
    try testing.expectError(error.MalformedFrame, identifierOf("\x01\x02"));
}

test "reading takes whatever bytes it is given: pieces of them, or refused" {
    try testing.fuzz({}, fuzzFraming, .{ .corpus = &.{ "\x01\x04head\x00\x02hi", "\x04\x04\x06\x01\x08\x01", "\x21\x01x\x07\x01\x00" } });
}

fn fuzzFraming(_: void, smith: *testing.Smith) anyerror!void {
    var buffer: [4096]u8 = undefined;
    const bytes = buffer[0..smith.slice(&buffer)];
    var framing: Framing = .init(256);
    var taken: usize = 0;
    while (true) {
        const step = framing.next(bytes[taken..], 100) catch return;
        try testing.expect(step.consumed <= bytes.len - taken);
        taken += step.consumed;
        switch (step.piece) {
            .data => |data| try testing.expect(data.len > 0 and data.len <= 100),
            .frame => |frame| {
                try testing.expect(frame.payload.len <= 256);
                if (frame.type == .settings) _ = Settings.decode(frame.payload) catch {};
            },
            .incomplete => return,
        }
    }
}
