//! The session for a browser, as a WebAssembly module: one page's session to one machine, through areas of the module's
//! memory the page writes into and reads back. The page holds the relay's WebSocket and the clock, and calls in with each
//! frame and each wake; everything the session does is here.
const std = @import("std");
const Page = @import("Page.zig");
const Identity = @import("Identity.zig");
const frame = @import("relay/frame.zig");
const authentication = @import("relay/authentication.zig");
const websocket = @import("websocket.zig");

const Field = std.http.Header;
const allocator = std.heap.c_allocator;

// What the C libraries call — the allocations they make and the crypto they are given.
comptime {
    _ = @import("allocation.zig");
    _ = @import("crypto.zig");
}

/// What the page and the module say to each other: a frame, a head's fields, a body's bytes.
var exchange: [frame.max_length]u8 = undefined;
/// A message the page sends: as long as the message.
var outgoing: std.ArrayList(u8) = .empty;
/// The message read last, good till the next is read.
var message: []const u8 = &.{};
var page: ?*Page = null;
/// The relay's host, as the page reached it, which its answer to the relay's challenge signs.
var relay_host: [253]u8 = undefined;

fn io() std.Io {
    return std.Io.Threaded.global_single_threaded.io();
}

fn microseconds(now: f64) u64 {
    return @intFromFloat(now);
}

export fn tunnel_exchange() [*]u8 {
    return &exchange;
}

export fn tunnel_exchange_size() usize {
    return exchange.len;
}

export fn tunnel_host() [*]u8 {
    return &relay_host;
}

/// Takes the frame in the exchange, `length` long, as the relay's handshake, its host `host_length` long: an answer to
/// its challenge written in the exchange, and its length; -1 for its welcome; 0 where it is neither.
export fn tunnel_admit(length: usize, host_length: usize) i32 {
    switch (frame.decode(exchange[0..length]) catch return 0) {
        .challenge => |nonce| {
            const answer = authentication.answer(page.?.endpoint.identity, relay_host[0..host_length], nonce) catch return 0;
            var writer: std.Io.Writer = .fixed(&exchange);
            frame.writeAnswer(&writer, answer) catch return 0;
            return @intCast(writer.buffered().len);
        },
        .welcome => return -1,
        else => return 0,
    }
}

/// Makes room for a message of `length` to send: where the page is to write it; 0 where there is no room.
export fn tunnel_outgoing(length: usize) usize {
    outgoing.resize(allocator, length) catch return 0;
    return @intFromPtr(outgoing.items.ptr);
}

export fn tunnel_message_pointer() usize {
    return @intFromPtr(message.ptr);
}

export fn tunnel_message_length() usize {
    return message.len;
}

/// Starts the page's session side, its identity's seed in the exchange: 1, or 0.
export fn tunnel_start(now: f64) u32 {
    const identity = Identity.fromSeed(exchange[0..Identity.seed_length].*) catch return 0;
    page = Page.init(allocator, io(), identity, microseconds(now)) catch return 0;
    return 1;
}

/// Writes in the exchange the text of the page's own key: its length.
export fn tunnel_key() usize {
    const text = page.?.endpoint.identity.publicKey().text();
    @memcpy(exchange[0..text.len], &text);
    return text.len;
}

/// Opens the session to the machine whose key's text is in the exchange: 1, or 0.
export fn tunnel_connect(now: f64) u32 {
    const key = Identity.PublicKey.parse(exchange[0..Identity.PublicKey.text_length]) catch return 0;
    page.?.connect(key, microseconds(now)) catch return 0;
    return 1;
}

/// Takes the frame in the exchange, `length` long.
export fn tunnel_take(length: usize, now: f64) void {
    page.?.take(exchange[0..length], microseconds(now));
}

/// Writes in the exchange the next frame to send the relay: its length; 0 where none is due.
export fn tunnel_next_frame(now: f64) usize {
    return (page.?.nextFrame(&exchange, microseconds(now)) catch return 0) orelse 0;
}

export fn tunnel_wake(now: f64) f64 {
    return @floatFromInt(page.?.wakeTime(microseconds(now)));
}

export fn tunnel_step(now: f64) void {
    page.?.step(microseconds(now));
}

export fn tunnel_state() u32 {
    return @backingInt(page.?.state());
}

/// The fields `bytes` hold, each a name and a value ended by a zero byte, in `fields`.
fn fieldsOf(bytes: []const u8, fields: []Field) ?[]Field {
    var parts = std.mem.splitScalar(u8, bytes, 0);
    var count: usize = 0;
    while (parts.next()) |name| {
        if (name.len == 0) break;
        const value = parts.next() orelse return null;
        if (count == fields.len) return null;
        fields[count] = .{ .name = name, .value = value };
        count += 1;
    }
    return fields[0..count];
}

/// Sends the head of a request, its fields in the exchange, `length` long: its stream; -1 where it cannot go yet, -2
/// where it failed.
export fn tunnel_open(length: usize) i32 {
    var fields: [64]Field = undefined;
    const given = fieldsOf(exchange[0..length], &fields) orelse return -2;
    return streamOf(page.?.open(given) catch return -2);
}

fn streamOf(stream: ?u64) i32 {
    return if (stream) |number| @intCast(number) else -1;
}

/// Writes the head of the response on `stream` in the exchange, as a request's head is written: its length; -1 till it
/// comes, -2 where the stream was reset.
export fn tunnel_head(stream: u32) i32 {
    const section = (page.?.head(stream) catch return -2) orelse return -1;
    var writer: std.Io.Writer = .fixed(&exchange);
    var lines = section.iterator();
    while (lines.next()) |field| writer.print("{s}\x00{s}\x00", .{ field.name, field.value }) catch return -2;
    return @intCast(writer.buffered().len);
}

/// Writes the exchange's first `length` bytes of the request's body: how many went, 0 where there is no room yet; -2
/// where the stream failed.
export fn tunnel_write(stream: u32, length: usize) i32 {
    return @intCast(page.?.write(stream, exchange[0..length]) catch return -2);
}

export fn tunnel_finish(stream: u32) u32 {
    page.?.finish(stream) catch return 0;
    return 1;
}

/// Reads into the exchange what came of the response's body: how many bytes, 0 where nothing more has come yet; -1 at
/// its end; -2 where the stream failed.
export fn tunnel_read(stream: u32) i32 {
    const length = (page.?.read(stream, &exchange) catch return -2) orelse return -1;
    return @intCast(length);
}

export fn tunnel_close(stream: u32) void {
    page.?.close(stream);
}

/// Whether the machine takes WebSockets: 1, 0, or -1 till its settings come.
export fn tunnel_takes_sockets() i32 {
    return if (page.?.takesSockets()) |takes| @intFromBool(takes) else -1;
}

/// Opens a WebSocket, the exchange holding its target, its authority and then its other fields, each ended by a zero
/// byte: its stream; -1 where it cannot go yet, -2 where it failed.
export fn tunnel_open_socket(length: usize) i32 {
    var parts = std.mem.splitScalar(u8, exchange[0..length], 0);
    const target = parts.next() orelse return -2;
    const authority = parts.next() orelse return -2;
    var fields: [32]Field = undefined;
    const extra = fieldsOf(parts.rest(), &fields) orelse return -2;
    return streamOf(page.?.openSocket(target, authority, extra) catch return -2);
}

/// Sends the message the page wrote where `tunnel_outgoing` said, of `opcode`: 1, or 0.
export fn tunnel_send_message(stream: u32, opcode: u32) u32 {
    page.?.sendMessage(stream, @fromBackingInt(@intCast(opcode)), outgoing.items) catch return 0;
    return 1;
}

/// The kind of the next message on the WebSocket, its bytes then told by the getters: 1 a text, 2 a binary, 8 the
/// machine ended it, 0 none has come yet, -2 it failed.
export fn tunnel_next_message(stream: u32) i32 {
    const next = (page.?.nextMessage(stream) catch return -2) orelse return 0;
    switch (next) {
        .text => |bytes| {
            message = bytes;
            return 1;
        },
        .binary => |bytes| {
            message = bytes;
            return 2;
        },
        .close => return 8,
        .ping, .pong => return 0,
    }
}
