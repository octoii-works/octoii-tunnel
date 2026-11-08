//! A session: one QUIC connection between an endpoint's identity and a peer's, its streams carrying bytes both ways,
//! its peer known by the key its handshake checked. The endpoint holds it till its host releases it after its
//! `closed` event.
const Connection = @This();
const std = @import("std");
const c = @import("quic");
const host_ = @import("host.zig");
const Identity = @import("Identity.zig");
const Endpoint = @import("Endpoint.zig");

endpoint: *Endpoint,
/// picoquic's connection, till picoquic is done with it.
cnx: ?*c.picoquic_cnx_t,
side: Side,
/// The peer's key: the one expected, where this endpoint opened the session; the one the peer showed, where the
/// peer did, from its certificate on.
peer: Identity.PublicKey,
state: State = .handshaking,
/// What came on each stream, not yet read.
streams: std.AutoArrayHashMapUnmanaged(u64, Stream) = .empty,

/// Which side of the session the endpoint is: the one that opened it, or the one its peer opened it to.
pub const Side = enum { client, server };

/// Where the session is: in its handshake, ready, or ended.
pub const State = enum { handshaking, ready, closed };

/// The most bytes written to a stream and not yet sent: past them, a write takes none till the session sends some.
pub const max_pending = 256 * 1024;

/// A stream's two ways: what came on it, not yet read, and whether the peer ended it; what was written to it, not yet
/// sent, and whether this endpoint ended it, and gave picoquic its end.
const Stream = struct {
    received: std.ArrayList(u8) = .empty,
    /// How many of `received` were read.
    read: usize = 0,
    peer_ended: bool = false,
    pending: std.ArrayList(u8) = .empty,
    /// How many of `pending` were sent.
    sent: usize = 0,
    ending: bool = false,
    end_sent: bool = false,

    fn deinit(stream: *Stream, allocator: std.mem.Allocator) void {
        stream.received.deinit(allocator);
        stream.pending.deinit(allocator);
    }

    /// Whether both ways are over: all that came read after the peer's end, and this endpoint's end sent.
    fn over(stream: *const Stream) bool {
        return stream.peer_ended and stream.read == stream.received.items.len and stream.end_sent;
    }
};

/// A session of `endpoint` on picoquic's `cnx`.
pub fn create(endpoint: *Endpoint, cnx: *c.picoquic_cnx_t, side: Side, peer: Identity.PublicKey) !*Connection {
    const connection = try endpoint.allocator.create(Connection);
    connection.* = .{ .endpoint = endpoint, .cnx = cnx, .side = side, .peer = peer };
    return connection;
}

/// Frees what the session holds; picoquic's connection is its endpoint's to end.
pub fn destroy(connection: *Connection) void {
    const allocator = connection.endpoint.allocator;
    for (connection.streams.values()) |*stream| stream.deinit(allocator);
    connection.streams.deinit(allocator);
    allocator.destroy(connection);
}

/// The identifier of a new stream of the session, one this endpoint opens by writing to it.
pub fn openStream(connection: *Connection) error{Closed}!u64 {
    const cnx = connection.cnx orelse return error.Closed;
    return c.picoquic_get_next_local_stream_id(cnx, 0);
}

/// Writes as much of `bytes` on `stream` as room there is, to be sent as the session can: how many it took, none
/// where `max_pending` bytes wait to be sent already.
pub fn write(connection: *Connection, stream: u64, bytes: []const u8) error{ Closed, Ended, OutOfMemory }!usize {
    const entry = try connection.streamOf(stream);
    if (entry.ending) return error.Ended;
    const taken = @min(bytes.len, max_pending - (entry.pending.items.len - entry.sent));
    if (taken == 0) return 0;
    try entry.pending.appendSlice(connection.endpoint.allocator, bytes[0..taken]);
    try connection.markActive(stream);
    return taken;
}

/// How many bytes `stream` takes now.
pub fn room(connection: *Connection, stream: u64) usize {
    const entry = connection.streams.getPtr(stream) orelse return max_pending;
    return max_pending - (entry.pending.items.len - entry.sent);
}

/// Ends this endpoint's side of `stream`: once all written is sent, the peer reads its end.
pub fn shutdown(connection: *Connection, stream: u64) error{ Closed, OutOfMemory }!void {
    const entry = try connection.streamOf(stream);
    if (entry.ending) return;
    entry.ending = true;
    try connection.markActive(stream);
}

/// The stream of `stream`, made where nothing has come on it or gone yet.
fn streamOf(connection: *Connection, stream: u64) error{ Closed, OutOfMemory }!*Stream {
    if (connection.state == .closed) return error.Closed;
    const entry = try connection.streams.getOrPut(connection.endpoint.allocator, stream);
    if (!entry.found_existing) entry.value_ptr.* = .{};
    return entry.value_ptr;
}

/// Tells picoquic that `stream` has something to send, which it asks for as it can send it.
fn markActive(connection: *Connection, stream: u64) error{ Closed, OutOfMemory }!void {
    const cnx = connection.cnx orelse return error.Closed;
    const previous = connection.endpoint.enter(connection.endpoint.now);
    defer host_.leave(previous);
    if (c.picoquic_mark_active_stream_v2(cnx, stream, 1) != 0) return error.OutOfMemory;
}

/// Gives picoquic, as it asks through `context`, at most `most` bytes of what waits to be sent on `stream`, and its end
/// where all of it goes and the stream was ended.
fn provide(connection: *Connection, stream: u64, context: ?*anyopaque, most: usize) !void {
    const entry = connection.streams.getPtr(stream) orelse {
        _ = c.picoquic_provide_stream_data_buffer(context, 0, 0, 0);
        return;
    };
    const waiting = entry.pending.items[entry.sent..];
    const length = @min(waiting.len, most);
    const end = entry.ending and length == waiting.len;
    const more: c_int = @intFromBool(length < waiting.len);
    const buffer = c.picoquic_provide_stream_data_buffer(context, length, @intFromBool(end), more) orelse return error.ProvideFailed;
    @memcpy(buffer[0..length], waiting[0..length]);
    entry.sent += length;
    if (entry.sent == entry.pending.items.len) {
        entry.pending.clearRetainingCapacity();
        entry.sent = 0;
    }
    if (end) entry.end_sent = true;
    connection.retireIfOver(stream);
}

/// Reads into `buffer` what came on `stream`: how many bytes, none where nothing more has come yet, null where the peer
/// ended the stream and all it sent was read.
pub fn read(connection: *Connection, stream: u64, buffer: []u8) ?usize {
    const entry = connection.streams.getPtr(stream) orelse return 0;
    const unread = entry.received.items[entry.read..];
    if (unread.len == 0 and entry.peer_ended) {
        connection.retireIfOver(stream);
        return null;
    }
    const length = @min(unread.len, buffer.len);
    @memcpy(buffer[0..length], unread[0..length]);
    entry.read += length;
    if (entry.read == entry.received.items.len and !entry.peer_ended) {
        entry.received.clearRetainingCapacity();
        entry.read = 0;
    }
    return length;
}

/// Lets go of `stream` once both its ways are over.
fn retireIfOver(connection: *Connection, stream: u64) void {
    const entry = connection.streams.getPtr(stream) orelse return;
    if (!entry.over()) return;
    entry.deinit(connection.endpoint.allocator);
    _ = connection.streams.swapRemove(stream);
}

/// Ends the session with `code`, the reason its peer is told: its `closed` event follows.
pub fn close(connection: *Connection, code: u64) void {
    const cnx = connection.cnx orelse return;
    if (connection.state == .closed) return;
    const previous = connection.endpoint.enter(connection.endpoint.now);
    defer host_.leave(previous);
    _ = c.picoquic_close(cnx, code);
}

/// Takes what picoquic tells of the session: bytes and ends of streams, the session ready, the session ended.
pub fn handle(connection: *Connection, stream: u64, bytes: []const u8, event: c.picoquic_call_back_event_t) !void {
    if (connection.state == .closed) return;
    switch (event) {
        c.picoquic_callback_stream_data, c.picoquic_callback_stream_fin => try connection.received(stream, bytes, event == c.picoquic_callback_stream_fin),
        c.picoquic_callback_stream_reset => try connection.received(stream, &.{}, true),
        c.picoquic_callback_stop_sending => try connection.stopSending(stream),
        c.picoquic_callback_ready => {
            connection.state = .ready;
            try connection.endpoint.tell(switch (connection.side) {
                .client => .{ .connected = connection },
                .server => .{ .accepted = connection },
            });
        },
        c.picoquic_callback_close, c.picoquic_callback_application_close, c.picoquic_callback_stateless_reset => {
            connection.state = .closed;
            // An ended session is told nothing more; picoquic ends a connection its peer opened by itself, and one
            // this endpoint opened as the session is released.
            c.picoquic_set_callback(connection.cnx.?, null, null);
            if (connection.side == .server) connection.cnx = null;
            try connection.endpoint.tell(.{ .closed = connection });
        },
        else => {},
    }
}

/// Takes what picoquic asks to send on `stream`, `most` bytes at most, through `context`.
pub fn prepare(connection: *Connection, stream: u64, context: ?*anyopaque, most: usize) !void {
    if (connection.state == .closed) return;
    try connection.provide(stream, context, most);
}

fn received(connection: *Connection, stream: u64, bytes: []const u8, ended: bool) !void {
    const entry = try connection.streamOf(stream);
    try entry.received.appendSlice(connection.endpoint.allocator, bytes);
    if (ended) entry.peer_ended = true;
    try connection.endpoint.tell(.{ .readable = .{ .connection = connection, .stream = stream } });
}

/// The peer asked this endpoint to stop sending on `stream`: what waits is dropped, and the stream reset.
fn stopSending(connection: *Connection, stream: u64) !void {
    const entry = try connection.streamOf(stream);
    entry.pending.clearRetainingCapacity();
    entry.sent = 0;
    entry.ending = true;
    entry.end_sent = true;
    _ = c.picoquic_reset_stream(connection.cnx.?, stream, 0);
    connection.retireIfOver(stream);
}
