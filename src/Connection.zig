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

/// What came on a stream: its bytes not yet read, and whether the peer ended it.
const Stream = struct {
    received: std.ArrayList(u8) = .empty,
    /// How many of `received` were read.
    read: usize = 0,
    ended: bool = false,
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
    for (connection.streams.values()) |*stream| stream.received.deinit(allocator);
    connection.streams.deinit(allocator);
    allocator.destroy(connection);
}

/// The identifier of a new stream of the session, one this endpoint opens by writing to it.
pub fn openStream(connection: *Connection) error{Closed}!u64 {
    const cnx = connection.cnx orelse return error.Closed;
    return c.picoquic_get_next_local_stream_id(cnx, 0);
}

/// Writes `bytes` on `stream`, to be sent as the session can.
pub fn write(connection: *Connection, stream: u64, bytes: []const u8) !void {
    try connection.add(stream, bytes, 0);
}

/// Ends this endpoint's side of `stream`: once all written is sent, the peer reads its end.
pub fn shutdown(connection: *Connection, stream: u64) !void {
    try connection.add(stream, &.{}, 1);
}

fn add(connection: *Connection, stream: u64, bytes: []const u8, end: c_int) !void {
    if (connection.state == .closed) return error.Closed;
    const cnx = connection.cnx orelse return error.Closed;
    const previous = connection.endpoint.enter(connection.endpoint.now);
    defer host_.leave(previous);
    if (c.picoquic_add_to_stream(cnx, stream, bytes.ptr, bytes.len, end) != 0) return error.WriteFailed;
}

/// Reads into `buffer` what came on `stream`: how many bytes, none where nothing more has come yet, null where the peer
/// ended the stream and all it sent was read.
pub fn read(connection: *Connection, stream: u64, buffer: []u8) ?usize {
    const entry = connection.streams.getPtr(stream) orelse return 0;
    const unread = entry.received.items[entry.read..];
    if (unread.len == 0 and entry.ended) {
        var ended = connection.streams.fetchSwapRemove(stream).?.value;
        ended.received.deinit(connection.endpoint.allocator);
        return null;
    }
    const length = @min(unread.len, buffer.len);
    @memcpy(buffer[0..length], unread[0..length]);
    entry.read += length;
    if (entry.read == entry.received.items.len) {
        entry.received.clearRetainingCapacity();
        entry.read = 0;
    }
    return length;
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
        c.picoquic_callback_stop_sending => _ = c.picoquic_reset_stream(connection.cnx.?, stream, 0),
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

fn received(connection: *Connection, stream: u64, bytes: []const u8, ended: bool) !void {
    const allocator = connection.endpoint.allocator;
    const entry = try connection.streams.getOrPut(allocator, stream);
    if (!entry.found_existing) entry.value_ptr.* = .{};
    try entry.value_ptr.received.appendSlice(allocator, bytes);
    if (ended) entry.value_ptr.ended = true;
    try connection.endpoint.tell(.{ .readable = .{ .connection = connection, .stream = stream } });
}
