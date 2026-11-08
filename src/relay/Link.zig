//! A peer's link to a relay, over a WebSocket: opened to the relay's home of a machine with the peer's key in its
//! address, the relay's challenge answered by the peer's identity, then frames each way — each written whole as one
//! binary message, the relay's read as they come into the link's own buffer. Writes, and the reading of a message,
//! take turns at the link's lock, as TLS changes its keys for writing on a key update it reads; a read waits for bytes
//! without it.
const Link = @This();
const std = @import("std");
const Identity = @import("../Identity.zig");
const websocket = @import("../websocket.zig");
const frame = @import("frame.zig");
const authentication = @import("authentication.zig");

const Io = std.Io;
const Key = Identity.PublicKey;

client: *std.http.Client,
connection: *std.http.Client.Connection,
lock: Io.Mutex = .init,
reading: websocket.Reading = .{},
/// What the relay's messages are read into; a frame read stays in it till the next read.
buffer: [frame.max_length]u8 = undefined,

/// What a read of the link gives.
pub const Received = union(enum) {
    /// A frame from the relay, in the link's buffer till the next read.
    frame: []u8,
    /// The relay's answer to a ping.
    pong,
    /// The relay closed the link.
    closed,
};

pub const Error = error{ Refused, Transport, Canceled, OutOfMemory };

/// Opens a link to the home of `home` on the relay at `relay`, a `ws` or `wss` address, for the peer of `identity`:
/// the link the relay admitted by the peer's answer, or `Refused` where it did not.
pub fn open(client: *std.http.Client, relay: []const u8, home: Key, identity: Identity) Error!*Link {
    const allocator = client.allocator;
    const address = std.fmt.allocPrint(allocator, "{s}/{f}?key={f}", .{ relay, home, identity.publicKey() }) catch return error.OutOfMemory;
    defer allocator.free(address);
    const uri = std.Uri.parse(address) catch return error.Transport;
    const connection = try upgrade(client, uri);
    const link = allocator.create(Link) catch {
        release(client, connection);
        return error.OutOfMemory;
    };
    link.* = .{ .client = client, .connection = connection };
    errdefer link.close();
    var host: [Io.net.HostName.max_len]u8 = undefined;
    const host_name = Io.net.HostName.fromUri(uri, &host) catch return error.Transport;
    try link.answer(identity, host_name.bytes);
    return link;
}

/// The connection of a WebSocket opened at `uri`, the handshake of RFC 6455 done.
fn upgrade(client: *std.http.Client, uri: std.Uri) Error!*std.http.Client.Connection {
    var random: [16]u8 = undefined;
    client.io.random(&random);
    const key = websocket.keyOf(random);
    var request = client.request(.GET, uri, .{
        .headers = .{ .connection = .{ .override = "Upgrade" }, .accept_encoding = .omit },
        .extra_headers = &.{
            .{ .name = "upgrade", .value = "websocket" },
            .{ .name = "sec-websocket-version", .value = "13" },
            .{ .name = "sec-websocket-key", .value = &key },
        },
        .redirect_behavior = .not_allowed,
    }) catch |err| return failed(err);
    defer request.deinit();
    request.sendBodiless() catch |err| return failed(err);
    const response = request.receiveHead(&.{}) catch |err| return failed(err);
    if (response.head.status != .switching_protocols) return error.Refused;
    // The connection speaks WebSocket from here, whatever the head says: the request lets it go, which would wait
    // for the end of a body it never has, and the link keeps it, or lets it go closed.
    const connection = request.connection.?;
    request.connection = null;
    if (!accepts(response.head, &key)) {
        release(client, connection);
        return error.Transport;
    }
    return connection;
}

/// Whether the server's head answers the handshake's `key`.
fn accepts(head: std.http.Client.Response.Head, key: []const u8) bool {
    const expected = websocket.acceptOf(key);
    var headers = head.iterateHeaders();
    while (headers.next()) |header| {
        if (std.ascii.eqlIgnoreCase(header.name, "sec-websocket-accept")) return std.mem.eql(u8, header.value, &expected);
    }
    return false;
}

fn failed(err: anyerror) Error {
    return switch (err) {
        error.Canceled => error.Canceled,
        error.OutOfMemory => error.OutOfMemory,
        else => error.Transport,
    };
}

fn release(client: *std.http.Client, connection: *std.http.Client.Connection) void {
    connection.closing = true;
    client.connection_pool.release(connection, client.io);
}

/// Answers the relay's challenge by `identity`, the relay at `host`, and waits for its welcome.
fn answer(link: *Link, identity: Identity, host: []const u8) Error!void {
    const challenge = switch (try link.receive()) {
        .frame => |bytes| switch (frame.decode(bytes) catch return error.Refused) {
            .challenge => |nonce| nonce,
            else => return error.Refused,
        },
        .pong, .closed => return error.Refused,
    };
    var buffer: [1 + Key.length + Identity.signature_length]u8 = undefined;
    var writer: Io.Writer = .fixed(&buffer);
    frame.writeAnswer(&writer, authentication.answer(identity, host, challenge) catch return error.Refused) catch unreachable;
    try link.send(writer.buffered());
    switch (try link.receive()) {
        .frame => |bytes| switch (frame.decode(bytes) catch return error.Refused) {
            .welcome => {},
            else => return error.Refused,
        },
        .pong, .closed => return error.Refused,
    }
}

/// Sends `bytes`, a frame, as one binary message.
pub fn send(link: *Link, bytes: []const u8) Error!void {
    try link.write(.binary, bytes);
}

/// Sends a ping the relay answers without waking its home.
pub fn ping(link: *Link) Error!void {
    try link.write(.text, "ping");
}

fn write(link: *Link, opcode: websocket.Opcode, payload: []const u8) Error!void {
    const io = link.client.io;
    link.lock.lock(io) catch return error.Canceled;
    defer link.lock.unlock(io);
    try link.writeLocked(opcode, payload);
}

fn writeLocked(link: *Link, opcode: websocket.Opcode, payload: []const u8) Error!void {
    var mask: [4]u8 = undefined;
    link.client.io.random(&mask);
    websocket.writeFrame(link.connection.writer(), opcode, payload, mask) catch return error.Transport;
    link.connection.flush() catch return error.Transport;
}

/// Reads what the relay sends next, the relay's pings answered on the way.
pub fn receive(link: *Link) Error!Received {
    const io = link.client.io;
    while (true) {
        if (!try link.awaitBytes()) return .closed;
        link.lock.lock(io) catch return error.Canceled;
        defer link.lock.unlock(io);
        const message = link.reading.next(link.connection.reader(), &link.buffer) catch |err| return switch (err) {
            error.EndOfStream => .closed,
            else => error.Transport,
        };
        switch (message) {
            .binary => |bytes| return .{ .frame = bytes },
            .text => |text| if (std.mem.eql(u8, text, "pong")) return .pong else return error.Transport,
            .ping => |payload| try link.writeLocked(.pong, payload),
            .pong => {},
            .close => return .closed,
        }
    }
}

/// Waits, without the lock, until the connection has bytes to read — what TLS decrypted, or what the network brought:
/// whether it has, false where the relay ended the connection.
fn awaitBytes(link: *Link) Error!bool {
    if (link.connection.reader().bufferedLen() > 0) return true;
    link.connection.stream_reader.interface.fill(1) catch |err| return switch (err) {
        error.ReadFailed => if (link.connection.stream_reader.err) |cause| (if (cause == error.Canceled) error.Canceled else error.Transport) else error.Transport,
        error.EndOfStream => false,
    };
    return true;
}

/// Closes the link: the relay is told, and the connection let go.
pub fn close(link: *Link) void {
    link.write(.close, &.{}) catch {};
    const client = link.client;
    release(client, link.connection);
    client.allocator.destroy(link);
}
