//! A page's end of a session: what a browser's one thread holds of a session to one machine through one relay. It has
//! no tasks, sockets or clock: the page gives it each frame the relay sent and the time, sends each frame it has to send,
//! and steps it by the time it asks. Requests and WebSockets are HTTP/3's, on the same state a station's drive; a call
//! that cannot go on yet says so, and the page calls again after the next step.
const Page = @This();
const std = @import("std");
const Endpoint = @import("Endpoint.zig");
const Connection = @import("Connection.zig");
const Identity = @import("Identity.zig");
const host_ = @import("host.zig");
const frame = @import("relay/frame.zig");
const Book = @import("relay/Book.zig");
const Session = @import("http3/Session.zig");
const qpack = @import("http3/qpack.zig");
const websocket = @import("websocket.zig");

const Io = std.Io;
const Key = Identity.PublicKey;
const Field = std.http.Header;

/// The relay a page is on: it has the one.
const relay_number: u16 = 0;

/// The longest WebSocket message a page takes from its machine.
const max_message = 16 * 1024 * 1024;

allocator: std.mem.Allocator,
io: Io,
endpoint: *Endpoint,
book: Book = .{},
peer: ?Key = null,
connection: ?*Connection = null,
session: ?Session = null,
sockets: std.AutoHashMapUnmanaged(u64, *Socket) = .empty,
/// Whether the relay said the machine is not on its home.
peer_gone: bool = false,
/// Whether the session ended.
ended: bool = false,
/// Datagrams being gathered into a frame.
scratch: [frame.max_length]u8 = undefined,

/// Where a page's session stands.
pub const State = enum(u32) { connecting = 0, ready = 1, ended = 2, machine_away = 3 };

/// A WebSocket the page opened: what has come and not been read, what waits to be sent, and its messages as they
/// gather.
const Socket = struct {
    inbound: std.ArrayList(u8) = .empty,
    read_at: usize = 0,
    outbound: std.ArrayList(u8) = .empty,
    sent: usize = 0,
    reading: websocket.Reading = .{},
    messages: []u8,
    body_ended: bool = false,
};

/// A page speaking for `identity`, at `now`, in microseconds.
pub fn init(allocator: std.mem.Allocator, io: Io, identity: Identity, now: u64) !*Page {
    const page = try allocator.create(Page);
    errdefer allocator.destroy(page);
    page.* = .{ .allocator = allocator, .io = io, .endpoint = try Endpoint.init(allocator, io, identity, now, .{ .max_connections = 4 }) };
    return page;
}

pub fn deinit(page: *Page) void {
    page.endSession();
    page.endpoint.deinit();
    page.book.deinit(page.allocator);
    page.sockets.deinit(page.allocator);
    page.allocator.destroy(page);
}

/// Opens the session to the machine of `peer`, on the relay the page holds its link to.
pub fn connect(page: *Page, peer: Key, now: u64) !void {
    const to = try page.book.addressOf(page.allocator, relay_number, peer);
    page.peer = peer;
    page.connection = try page.endpoint.connect(peer, to, now);
}

/// Takes a frame the relay sent.
pub fn take(page: *Page, bytes: []const u8, now: u64) void {
    switch (frame.decode(bytes) catch return) {
        .datagrams => |datagrams| {
            page.peer_gone = false;
            const from = page.book.addressOf(page.allocator, relay_number, datagrams.key) catch return;
            var each = datagrams.iterator();
            while (each.next()) |datagram| page.endpoint.receive(@constCast(datagram), from, Book.localOf(relay_number), now);
        },
        .gone => |key| {
            if (page.peer) |peer| {
                if (peer.eql(key)) page.peer_gone = true;
            }
        },
        else => {},
    }
}

/// Writes into `buffer` the next frame to send the relay, as many datagrams as are due and fit: its length; null where
/// none is due.
pub fn nextFrame(page: *Page, buffer: []u8, now: u64) !?usize {
    const peer = page.peer orelse return null;
    var datagrams: [64][]const u8 = undefined;
    var count: usize = 0;
    var used: usize = 0;
    var framed: usize = 1 + Key.length;
    while (count < datagrams.len and framed + 2 + frame.max_datagram <= frame.max_length) {
        const datagram = try page.endpoint.send(page.scratch[used..][0..frame.max_datagram], now) orelse break;
        datagrams[count] = page.scratch[used..][0..datagram.length];
        count += 1;
        used += datagram.length;
        framed += 2 + datagram.length;
    }
    if (count == 0) return null;
    var writer: Io.Writer = .fixed(buffer);
    std.debug.assert(try frame.writeDatagrams(&writer, peer, datagrams[0..count]) == count);
    return writer.buffered().len;
}

/// When the page is next to be stepped, in microseconds, at the latest.
pub fn wakeTime(page: *Page, now: u64) u64 {
    return page.endpoint.wakeTime(now);
}

/// Where the session stands.
pub fn state(page: *const Page) State {
    if (page.ended) return .ended;
    if (page.peer_gone) return .machine_away;
    return if (page.session != null) .ready else .connecting;
}

/// Takes what happened to the session, and moves its streams on.
pub fn step(page: *Page, now: u64) void {
    const previous = page.endpoint.enter(now);
    defer host_.leave(previous);
    while (page.endpoint.nextEvent()) |event| switch (event) {
        .connected => |connection| page.session = Session.init(page.allocator, connection) catch blk: {
            connection.close(0);
            break :blk null;
        },
        .closed => |connection| {
            page.endSession();
            page.endpoint.release(connection);
            page.connection = null;
        },
        .accepted, .readable => {},
    };
    if (page.session) |*session| {
        session.poll() catch return page.closeConnection();
        var sockets = page.sockets.iterator();
        while (sockets.next()) |entry| page.flush(entry.key_ptr.*, entry.value_ptr.*) catch {};
    }
}

fn closeConnection(page: *Page) void {
    if (page.connection) |connection| connection.close(0);
}

fn endSession(page: *Page) void {
    page.ended = true;
    var sockets = page.sockets.valueIterator();
    while (sockets.next()) |socket| page.freeSocket(socket.*);
    page.sockets.clearRetainingCapacity();
    if (page.session) |*session| session.deinit();
    page.session = null;
}

fn freeSocket(page: *Page, socket: *Socket) void {
    socket.inbound.deinit(page.allocator);
    socket.outbound.deinit(page.allocator);
    page.allocator.free(socket.messages);
    page.allocator.destroy(socket);
}

/// Sends a request's head: its stream; null where the session cannot take one yet.
pub fn open(page: *Page, fields: []const Field) Session.Error!?u64 {
    const session = if (page.session) |*session| session else return null;
    const stream = try session.openRequest();
    if (!try session.sendHead(stream, &.{fields})) {
        session.closeStream(stream);
        return null;
    }
    return stream;
}

/// The head of the response on `stream`; null till it comes.
pub fn head(page: *const Page, stream: u64) error{ Reset, Closed }!?qpack.Section {
    const session = if (page.session) |*session| session else return error.Closed;
    return session.head(stream);
}

/// Writes as much of `bytes` of a request's body as there is room for: how many.
pub fn write(page: *Page, stream: u64, bytes: []const u8) Session.Error!usize {
    const session = if (page.session) |*session| session else return error.Closed;
    return session.writeBody(stream, bytes);
}

/// Ends a request's body.
pub fn finish(page: *Page, stream: u64) Session.Error!void {
    const session = if (page.session) |*session| session else return error.Closed;
    return session.finish(stream);
}

/// Reads into `buffer` what came of the response's body: how many bytes, none where nothing more has come yet, null at
/// its end.
pub fn read(page: *Page, stream: u64, buffer: []u8) Session.Error!?usize {
    const session = if (page.session) |*session| session else return error.Closed;
    if (try session.head(stream) == null) return 0;
    return session.readBody(stream, buffer);
}

/// Lets a stream go, whatever is left of it.
pub fn close(page: *Page, stream: u64) void {
    if (page.sockets.fetchRemove(stream)) |removed| page.freeSocket(removed.value);
    const session = if (page.session) |*session| session else return;
    session.hangUp(stream);
    session.closeStream(stream);
}

/// Whether the machine takes a WebSocket opened over the session: null till its settings came.
pub fn takesSockets(page: *const Page) ?bool {
    const session = if (page.session) |*session| session else return null;
    return if (session.peer_settings) |settings| settings.enable_connect_protocol else null;
}

/// Opens a WebSocket at `target`, by the extended CONNECT of RFC 9220: its stream, whose head then says whether the
/// machine accepted it; null where the session cannot take one yet.
pub fn openSocket(page: *Page, target: []const u8, authority: []const u8, extra: []const Field) !?u64 {
    const session = if (page.session) |*session| session else return null;
    const stream = try session.openRequest();
    errdefer session.closeStream(stream);
    const sent = try session.sendHead(stream, &.{ &.{
        .{ .name = ":method", .value = "CONNECT" },
        .{ .name = ":protocol", .value = "websocket" },
        .{ .name = ":scheme", .value = "https" },
        .{ .name = ":authority", .value = authority },
        .{ .name = ":path", .value = target },
        .{ .name = "sec-websocket-version", .value = "13" },
    }, extra });
    if (!sent) {
        session.closeStream(stream);
        return null;
    }
    const socket = try page.allocator.create(Socket);
    errdefer page.allocator.destroy(socket);
    socket.* = .{ .messages = try page.allocator.alloc(u8, max_message) };
    errdefer page.allocator.free(socket.messages);
    try page.sockets.put(page.allocator, stream, socket);
    return stream;
}

/// Sends one message on the WebSocket of `stream`, whole, as soon as there is room.
pub fn sendMessage(page: *Page, stream: u64, opcode: websocket.Opcode, payload: []const u8) !void {
    const socket = page.sockets.get(stream) orelse return error.NoSocket;
    var mask: [4]u8 = undefined;
    page.io.random(&mask);
    var encoded: Io.Writer.Allocating = .init(page.allocator);
    defer encoded.deinit();
    try websocket.writeFrame(&encoded.writer, opcode, payload, mask);
    try socket.outbound.appendSlice(page.allocator, encoded.written());
    try page.flush(stream, socket);
}

/// Sends what waits on a WebSocket, as there is room.
fn flush(page: *Page, stream: u64, socket: *Socket) !void {
    while (socket.sent < socket.outbound.items.len) {
        const taken = try page.write(stream, socket.outbound.items[socket.sent..]);
        if (taken == 0) break;
        socket.sent += taken;
    }
    if (socket.sent == socket.outbound.items.len) {
        socket.outbound.clearRetainingCapacity();
        socket.sent = 0;
    }
}

/// The next whole message on the WebSocket of `stream`, the machine's pings answered on the way: good till the next
/// call; null till one has come; `.close` once the machine ended it.
pub fn nextMessage(page: *Page, stream: u64) !?websocket.Message {
    const socket = page.sockets.get(stream) orelse return error.NoSocket;
    try page.gather(stream, socket);
    while (true) {
        const unread = socket.inbound.items[socket.read_at..];
        const size = websocket.frameSize(unread) orelse return page.atEnd(socket);
        if (unread.len < size) return page.atEnd(socket);
        var reader: Io.Reader = .fixed(unread[0..@intCast(size)]);
        const message = socket.reading.next(&reader, socket.messages) catch |err| switch (err) {
            // A frame of a message with more to come, gathered: the next frame goes on with it.
            error.EndOfStream => {
                page.consumed(socket, @intCast(size));
                continue;
            },
            else => |other| return other,
        };
        page.consumed(socket, @intCast(size));
        if (message == .ping) {
            try page.sendMessage(stream, .pong, message.ping);
            continue;
        }
        return message;
    }
}

fn atEnd(_: *Page, socket: *const Socket) ?websocket.Message {
    return if (socket.body_ended) .close else null;
}

fn consumed(_: *Page, socket: *Socket, size: usize) void {
    socket.read_at += size;
    if (socket.read_at == socket.inbound.items.len) {
        socket.inbound.clearRetainingCapacity();
        socket.read_at = 0;
    }
}

/// Takes what came of the WebSocket's stream.
fn gather(page: *Page, stream: u64, socket: *Socket) !void {
    var buffer: [16 * 1024]u8 = undefined;
    while (try page.read(stream, &buffer)) |length| {
        if (length == 0) return;
        try socket.inbound.appendSlice(page.allocator, buffer[0..length]);
    }
    socket.body_ended = true;
}
