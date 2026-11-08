//! What the tunnel's tests share: the events endpoints tell, kept as a link runs; a stream read to its end; and whole
//! sessions run over a link — the one a test makes, direct or through a relay — from its client to its server.
const std = @import("std");
const Endpoint = @import("Endpoint.zig");
const Connection = @import("Connection.zig");
const Identity = @import("Identity.zig");

const testing = std.testing;
const IpAddress = std.Io.net.IpAddress;

/// When the tests' links start, in microseconds.
pub const start: u64 = 1_000_000;

/// Every event an endpoint told, kept in order as a link runs.
pub const Told = struct {
    events: std.ArrayList(Endpoint.Event) = .empty,

    fn take(told: *Told, endpoint: *Endpoint) !void {
        while (endpoint.nextEvent()) |event| try told.events.append(testing.allocator, event);
    }

    pub fn has(told: *const Told, tag: std.meta.Tag(Endpoint.Event)) bool {
        for (told.events.items) |event| if (event == tag) return true;
        return false;
    }

    /// The connection of the first event of `tag`.
    pub fn connectionOf(told: *const Told, tag: std.meta.Tag(Endpoint.Event)) *Connection {
        for (told.events.items) |event| switch (event) {
            .accepted, .connected, .closed => |connection| if (event == tag) return connection,
            .readable => {},
        };
        unreachable;
    }

    fn deinit(told: *Told) void {
        told.events.deinit(testing.allocator);
    }
};

/// The events of both sides of a link, as it runs.
pub const Watched = struct {
    client: Told = .{},
    server: Told = .{},

    fn take(watched: *Watched, link: anytype) bool {
        watched.client.take(link.client.endpoint) catch return false;
        watched.server.take(link.server.endpoint) catch return false;
        return true;
    }

    pub fn deinit(watched: *Watched) void {
        watched.client.deinit();
        watched.server.deinit();
    }
};

pub fn bothReady(watched: *Watched, link: anytype) bool {
    return !watched.take(link) or (watched.client.has(.connected) and watched.server.has(.accepted));
}

pub fn bothClosed(watched: *Watched, link: anytype) bool {
    return !watched.take(link) or (watched.client.has(.closed) and watched.server.has(.closed));
}

pub fn clientClosed(watched: *Watched, link: anytype) bool {
    return !watched.take(link) or watched.client.has(.closed);
}

/// What one stream of a session read, till its end.
pub const Reading = struct {
    connection: *Connection,
    stream: u64,
    bytes: std.ArrayList(u8) = .empty,

    pub fn deinit(reading: *Reading) void {
        reading.bytes.deinit(testing.allocator);
    }
};

pub fn readToEnd(reading: *Reading, link: anytype) bool {
    _ = link;
    var buffer: [64]u8 = undefined;
    while (reading.connection.read(reading.stream, &buffer)) |length| {
        if (length == 0) return false;
        reading.bytes.appendSlice(testing.allocator, buffer[0..length]) catch return true;
    }
    return true;
}

/// Runs a whole session over `link`, its client opening it to its server at `server_at`: each comes to know the
/// other's key, a stream carries bytes each way to its end, and the session closes and is released on both sides.
pub fn expectSession(link: anytype, server_at: IpAddress, client_identity: Identity, server_identity: Identity) !void {
    var watched: Watched = .{};
    defer watched.deinit();
    const client = link.client.endpoint;
    const server = link.server.endpoint;

    const opened = try client.connect(server_identity.publicKey(), server_at, link.now);
    try link.runUntil(&watched, bothReady);
    try testing.expectEqual(opened, watched.client.connectionOf(.connected));
    const accepted = watched.server.connectionOf(.accepted);
    try testing.expect(accepted.peer.eql(client_identity.publicKey()));
    try testing.expect(opened.peer.eql(server_identity.publicKey()));

    const stream = try opened.openStream();
    try opened.write(stream, "hello, ");
    try opened.write(stream, "machine");
    try opened.shutdown(stream);
    var asked: Reading = .{ .connection = accepted, .stream = stream };
    defer asked.deinit();
    try link.runUntil(&asked, readToEnd);
    try testing.expectEqualStrings("hello, machine", asked.bytes.items);

    try accepted.write(stream, "hello, device");
    try accepted.shutdown(stream);
    var answered: Reading = .{ .connection = opened, .stream = stream };
    defer answered.deinit();
    try link.runUntil(&answered, readToEnd);
    try testing.expectEqualStrings("hello, device", answered.bytes.items);

    opened.close(0);
    try link.runUntil(&watched, bothClosed);
    client.release(opened);
    server.release(watched.server.connectionOf(.closed));
}

/// Opens a session over `link` to its server at `server_at` expecting a key the server does not show: the session
/// never becomes ready on either side, and closes.
pub fn expectAnotherKeyRefused(link: anytype, server_at: IpAddress) !void {
    var watched: Watched = .{};
    defer watched.deinit();
    const opened = try link.client.endpoint.connect(Identity.generate(testing.io).publicKey(), server_at, link.now);
    try link.runUntil(&watched, clientClosed);
    try testing.expect(!watched.client.has(.connected));
    try testing.expect(!watched.server.has(.accepted));
    link.client.endpoint.release(opened);
}
