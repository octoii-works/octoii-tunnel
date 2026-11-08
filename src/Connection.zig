//! A session: one QUIC connection between an endpoint's identity and a peer's, its streams carrying bytes both ways,
//! its peer known by the key its handshake checked. The endpoint holds it till its host releases it after its
//! `closed` event. A stream is the session's from the time it is opened — by this endpoint, or by the peer, whose
//! streams wait to be taken in the order of their numbers — till its holder closes it.
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
/// Every stream of the session not yet let go.
streams: std.AutoArrayHashMapUnmanaged(u64, Stream) = .empty,
/// The streams the peer opened, not yet taken, of each kind, in the order of their numbers.
opened: std.EnumArray(Kind, std.ArrayList(u64)) = .initFill(.empty),
/// The number of the next stream the peer opens, of each kind: the streams below it are, or were, the session's.
peer_next: std.EnumArray(Kind, u64),

/// Which side of the session the endpoint is: the one that opened it, or the one its peer opened it to.
pub const Side = enum { client, server };

/// Where the session is: in its handshake, ready, or ended.
pub const State = enum { handshaking, ready, closed };

/// What a stream carries: bytes both ways, or from the side that opened it alone.
pub const Kind = enum { bidirectional, unidirectional };

/// The most bytes written to a stream and not yet sent: past them, a write takes none till the session sends some.
pub const max_pending = 256 * 1024;

/// A stream's two ways: what came on it, not yet read, and how the peer ended it; what was written to it, not yet sent,
/// and whether this endpoint ended it, and gave picoquic its end; and whether its holder let it go. A way a stream of
/// its kind does not have is over from the first.
const Stream = struct {
    received: std.ArrayList(u8) = .empty,
    /// How many of `received` were read.
    read: usize = 0,
    peer_ended: bool = false,
    /// Whether the peer reset its way: what came on it is lost.
    peer_reset: bool = false,
    pending: std.ArrayList(u8) = .empty,
    /// How many of `pending` were sent.
    sent: usize = 0,
    ending: bool = false,
    end_sent: bool = false,
    /// Whether the peer stopped this endpoint's way, which was reset at its asking.
    stopped: bool = false,
    /// Whether this endpoint stopped receiving: what comes is dropped, and reads find the end.
    receiving_stopped: bool = false,
    /// Whether its holder let it go: it goes once its end is sent.
    closed: bool = false,

    fn deinit(stream: *Stream, allocator: std.mem.Allocator) void {
        stream.received.deinit(allocator);
        stream.pending.deinit(allocator);
    }

    /// A stream opened by this endpoint, of `kind`.
    fn local(kind: Kind) Stream {
        return switch (kind) {
            .bidirectional => .{},
            .unidirectional => .{ .peer_ended = true },
        };
    }

    /// A stream opened by the peer, of `kind`.
    fn remote(kind: Kind) Stream {
        return switch (kind) {
            .bidirectional => .{},
            .unidirectional => .{ .ending = true, .end_sent = true },
        };
    }
};

/// The kind of the stream numbered `stream`, as the second bit of its number tells.
pub fn kindOf(stream: u64) Kind {
    return if (stream & 0b10 == 0) .bidirectional else .unidirectional;
}

/// Whether this endpoint opened the stream numbered `stream`, as the first bit of its number tells.
fn isLocal(connection: *const Connection, stream: u64) bool {
    return (stream & 1 == 0) == (connection.side == .client);
}

/// A session of `endpoint` on picoquic's `cnx`.
pub fn create(endpoint: *Endpoint, cnx: *c.picoquic_cnx_t, side: Side, peer: Identity.PublicKey) !*Connection {
    const connection = try endpoint.allocator.create(Connection);
    // The client's streams are numbered from 0, the server's from 1; a unidirectional stream's number 2 more.
    const peer_first: u64 = switch (side) {
        .client => 1,
        .server => 0,
    };
    connection.* = .{
        .endpoint = endpoint,
        .cnx = cnx,
        .side = side,
        .peer = peer,
        .peer_next = .init(.{ .bidirectional = peer_first, .unidirectional = peer_first + 2 }),
    };
    return connection;
}

/// Frees what the session holds; picoquic's connection is its endpoint's to end.
pub fn destroy(connection: *Connection) void {
    const allocator = connection.endpoint.allocator;
    for (connection.streams.values()) |*stream| stream.deinit(allocator);
    connection.streams.deinit(allocator);
    for (&connection.opened.values) |*opened| opened.deinit(allocator);
    allocator.destroy(connection);
}

/// Opens a stream of the session, of `kind`: its number, the stream made at once, so the next one opened is another.
pub fn openStream(connection: *Connection, kind: Kind) error{ Closed, OutOfMemory }!u64 {
    if (connection.state == .closed) return error.Closed;
    const cnx = connection.cnx orelse return error.Closed;
    const stream = c.picoquic_get_next_local_stream_id(cnx, @intFromBool(kind == .unidirectional));
    try connection.streams.ensureUnusedCapacity(connection.endpoint.allocator, 1);
    const previous = connection.endpoint.enter(connection.endpoint.now);
    defer host_.leave(previous);
    // picoquic makes a stream as it is first marked; marked idle, it waits for what is written to it.
    if (c.picoquic_mark_active_stream_v2(cnx, stream, 0) != 0) return error.OutOfMemory;
    connection.streams.putAssumeCapacity(stream, .local(kind));
    return stream;
}

/// The next stream of `kind` the peer opened, not yet taken; null where none waits.
pub fn takeOpened(connection: *Connection, kind: Kind) ?u64 {
    const opened = connection.opened.getPtr(kind);
    if (opened.items.len == 0) return null;
    return opened.orderedRemove(0);
}

/// Writes as much of `bytes` on `stream` as room there is, to be sent as the session can: how many it took, none
/// where `max_pending` bytes wait to be sent already; `Reset` where the peer stopped the stream.
pub fn write(connection: *Connection, stream: u64, bytes: []const u8) error{ Closed, Reset, OutOfMemory }!usize {
    const entry = try connection.streamOf(stream);
    if (entry.stopped) return error.Reset;
    std.debug.assert(!entry.ending);
    const taken = @min(bytes.len, max_pending - (entry.pending.items.len - entry.sent));
    if (taken == 0) return 0;
    try entry.pending.appendSlice(connection.endpoint.allocator, bytes[0..taken]);
    try connection.markActive(stream);
    return taken;
}

/// Ends this endpoint's way of `stream`: once all written is sent, the peer reads its end.
pub fn shutdown(connection: *Connection, stream: u64) error{Closed}!void {
    const entry = try connection.streamOf(stream);
    if (entry.ending) return;
    entry.ending = true;
    try connection.markActive(stream);
}

/// Stops receiving on `stream`: what came and comes on it is dropped, reads find its end, and the peer is asked to stop
/// sending with `code` where its way is not over.
pub fn stopReceiving(connection: *Connection, stream: u64, code: u64) void {
    const entry = connection.streams.getPtr(stream).?;
    if (entry.receiving_stopped) return;
    entry.receiving_stopped = true;
    entry.received.clearAndFree(connection.endpoint.allocator);
    entry.read = 0;
    if (entry.peer_ended or entry.peer_reset or connection.state == .closed) return;
    const cnx = connection.cnx orelse return;
    const previous = connection.endpoint.enter(connection.endpoint.now);
    defer host_.leave(previous);
    _ = c.picoquic_stop_sending(cnx, stream, code);
}

/// Lets go of `stream`: receiving stopped as `stopReceiving` stops it, and this endpoint's way ended where it was not;
/// the stream goes once its end is sent.
pub fn closeStream(connection: *Connection, stream: u64, code: u64) void {
    const entry = connection.streams.getPtr(stream).?;
    if (entry.closed) return;
    entry.closed = true;
    connection.stopReceiving(stream, code);
    if (connection.state != .closed and !entry.ending) {
        entry.ending = true;
        connection.markActive(stream) catch {};
    }
    connection.retireIfOver(stream);
}

/// The stream numbered `stream`, which this endpoint opened or took.
fn streamOf(connection: *Connection, stream: u64) error{Closed}!*Stream {
    if (connection.state == .closed) return error.Closed;
    return connection.streams.getPtr(stream).?;
}

/// The stream something came on: one the session has; where the peer opens it, a new one, after every stream of its
/// kind the peer opened before it, which its number opens with it; null for one let go, which is no more.
fn incomingOf(connection: *Connection, stream: u64) !?*Stream {
    if (connection.streams.getPtr(stream)) |entry| return entry;
    if (connection.isLocal(stream)) return null;
    const kind = kindOf(stream);
    const next = connection.peer_next.getPtr(kind);
    if (stream < next.*) return null;
    const allocator = connection.endpoint.allocator;
    while (next.* <= stream) : (next.* += 4) {
        try connection.streams.put(allocator, next.*, .remote(kind));
        try connection.opened.getPtr(kind).append(allocator, next.*);
    }
    return connection.streams.getPtr(stream).?;
}

/// Tells picoquic that `stream` has something to send, which it asks for as it can send it.
fn markActive(connection: *Connection, stream: u64) error{Closed}!void {
    const cnx = connection.cnx orelse return error.Closed;
    const previous = connection.endpoint.enter(connection.endpoint.now);
    defer host_.leave(previous);
    // picoquic marks a stream it holds without fail; one it no longer holds has nothing more to send.
    _ = c.picoquic_mark_active_stream_v2(cnx, stream, 1);
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
/// ended the stream and all it sent was read, or this endpoint stopped receiving; `Reset` where the peer reset it.
pub fn read(connection: *Connection, stream: u64, buffer: []u8) error{Reset}!?usize {
    const entry = connection.streams.getPtr(stream).?;
    if (entry.receiving_stopped) return null;
    if (entry.peer_reset) return error.Reset;
    const unread = entry.received.items[entry.read..];
    if (unread.len == 0 and entry.peer_ended) return null;
    const length = @min(unread.len, buffer.len);
    @memcpy(buffer[0..length], unread[0..length]);
    entry.read += length;
    if (entry.read == entry.received.items.len and !entry.peer_ended) {
        entry.received.clearRetainingCapacity();
        entry.read = 0;
    }
    return length;
}

/// Lets go of `stream` once its holder let it go and its end is sent.
fn retireIfOver(connection: *Connection, stream: u64) void {
    const entry = connection.streams.getPtr(stream) orelse return;
    if (!entry.closed or !entry.end_sent) return;
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
        c.picoquic_callback_stream_reset => try connection.reset(stream),
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
    const entry = try connection.incomingOf(stream) orelse return;
    if (ended) entry.peer_ended = true;
    if (entry.receiving_stopped) return;
    try entry.received.appendSlice(connection.endpoint.allocator, bytes);
    try connection.endpoint.tell(.{ .readable = .{ .connection = connection, .stream = stream } });
}

/// The peer reset its way of `stream`: what came on it is lost.
fn reset(connection: *Connection, stream: u64) !void {
    const entry = try connection.incomingOf(stream) orelse return;
    entry.peer_reset = true;
    entry.received.clearAndFree(connection.endpoint.allocator);
    entry.read = 0;
    if (entry.receiving_stopped) return;
    try connection.endpoint.tell(.{ .readable = .{ .connection = connection, .stream = stream } });
}

/// The peer asked this endpoint to stop sending on `stream`: what waits is dropped, and the stream reset with the
/// code the peer asked with.
fn stopSending(connection: *Connection, stream: u64) !void {
    const entry = try connection.incomingOf(stream) orelse return;
    entry.pending.clearAndFree(connection.endpoint.allocator);
    entry.sent = 0;
    entry.stopped = true;
    entry.ending = true;
    entry.end_sent = true;
    const cnx = connection.cnx.?;
    _ = c.picoquic_reset_stream(cnx, stream, c.picoquic_get_remote_stop_error(cnx, stream));
    connection.retireIfOver(stream);
}
