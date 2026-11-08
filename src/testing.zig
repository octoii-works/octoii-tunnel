//! What the tunnel's tests share: a direct link in memory between two endpoints, a datagram reaching one the link's
//! delay after the other sent it; the events endpoints tell, kept as a link runs; a stream read to its end; and whole
//! sessions run over a link — the one a test makes, direct or through a relay — from its client to its server.
const std = @import("std");
const Endpoint = @import("Endpoint.zig");
const Connection = @import("Connection.zig");
const Identity = @import("Identity.zig");
const relay = @import("relay.zig");

const testing = std.testing;
const IpAddress = std.Io.net.IpAddress;

/// When the tests' links start, in microseconds.
pub const start: u64 = 1_000_000;

/// An endpoint at its address on the link.
const Side = struct {
    endpoint: *Endpoint,
    at: IpAddress,
};

/// A datagram on its way: to which side, when it arrives, its bytes.
const Flight = struct {
    to_server: bool,
    arrival: u64,
    length: usize,
    bytes: [1536]u8,
};

/// Two endpoints, the datagrams on their way between them, and the time.
pub const Link = struct {
    client: Side,
    server: Side,
    now: u64,
    /// How long a datagram takes either way, in microseconds.
    delay: u64 = 10_000,
    in_flight: std.ArrayList(Flight) = .empty,

    /// The most datagrams an endpoint sends at one time: past it, it floods the link.
    const most_at_once = 256;

    pub fn deinit(link: *Link) void {
        link.in_flight.deinit(testing.allocator);
    }

    /// Runs the link till `done` holds of it; an error where it does not within the steps a session needs.
    pub fn runUntil(link: *Link, context: anytype, comptime done: anytype) !void {
        for (0..100_000) |_| {
            if (done(context, link)) return;
            try link.step();
        }
        return error.NeverDone;
    }

    /// Sends what both sides have to send now, moves time on to the next arrival or wake time, and delivers what has
    /// arrived by then.
    fn step(link: *Link) !void {
        try link.sendFrom(link.client, true);
        try link.sendFrom(link.server, false);
        var next = @min(link.client.endpoint.wakeTime(link.now), link.server.endpoint.wakeTime(link.now));
        for (link.in_flight.items) |flight| next = @min(next, flight.arrival);
        if (next == std.math.maxInt(u64)) return error.Stalled;
        link.now = @max(link.now, next);
        var index: usize = 0;
        while (index < link.in_flight.items.len) {
            const flight = &link.in_flight.items[index];
            if (flight.arrival > link.now) {
                index += 1;
                continue;
            }
            const from = if (flight.to_server) link.client else link.server;
            const to = if (flight.to_server) link.server else link.client;
            to.endpoint.receive(flight.bytes[0..flight.length], from.at, to.at, link.now);
            _ = link.in_flight.orderedRemove(index);
        }
    }

    /// Puts on the link every datagram `from` has to send now, to arrive the delay later.
    fn sendFrom(link: *Link, from: Side, to_server: bool) !void {
        const to = if (to_server) link.server else link.client;
        for (0..most_at_once) |_| {
            var flight: Flight = .{ .to_server = to_server, .arrival = link.now + link.delay, .length = 0, .bytes = undefined };
            const datagram = try from.endpoint.send(&flight.bytes, link.now) orelse return;
            try testing.expect(datagram.to.eql(&to.at));
            flight.length = datagram.length;
            try link.in_flight.append(testing.allocator, flight);
        }
        return error.Flooded;
    }
};

/// A direct link between `client` and `server`, starting at `now`.
pub fn linkOf(client: *Endpoint, server: *Endpoint, now: u64) !Link {
    return .{
        .client = .{ .endpoint = client, .at = try .parseLiteral("10.0.0.1:5000") },
        .server = .{ .endpoint = server, .at = try .parseLiteral("10.0.0.2:4433") },
        .now = now,
    };
}

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

/// What one stream of a session read, till its end: one it opened, or the next its peer opens.
pub const Reading = struct {
    connection: *Connection,
    stream: ?u64 = null,
    bytes: std.ArrayList(u8) = .empty,

    pub fn deinit(reading: *Reading) void {
        reading.bytes.deinit(testing.allocator);
    }
};

pub fn readToEnd(reading: *Reading, link: anytype) bool {
    _ = link;
    const stream = reading.stream orelse reading.connection.takeOpened(.bidirectional) orelse return false;
    reading.stream = stream;
    var buffer: [64]u8 = undefined;
    while (reading.connection.read(stream, &buffer) catch return true) |length| {
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

    const stream = try opened.openStream(.bidirectional);
    try testing.expectEqual(7, try opened.write(stream, "hello, "));
    try testing.expectEqual(7, try opened.write(stream, "machine"));
    try opened.shutdown(stream);
    var asked: Reading = .{ .connection = accepted };
    defer asked.deinit();
    try link.runUntil(&asked, readToEnd);
    try testing.expectEqualStrings("hello, machine", asked.bytes.items);
    try testing.expectEqual(stream, asked.stream.?);

    try testing.expectEqual(13, try accepted.write(stream, "hello, device"));
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

/// A transfer of `total` bytes on one stream of a session, written as room there is and read as they come, the
/// receiver taking the stream as it comes.
pub const Transfer = struct {
    sender: *Connection,
    receiver: *Connection,
    stream: u64,
    taken: bool = false,
    total: usize,
    written: usize = 0,
    ended: bool = false,
    received: usize = 0,
    /// Whether every byte came as it was written: byte `n` is `n % 251`.
    intact: bool = true,

    fn byteAt(index: usize) u8 {
        return @intCast(index % 251);
    }
};

pub fn transferred(transfer: *Transfer, link: anytype) bool {
    _ = link;
    var chunk: [16 * 1024]u8 = undefined;
    while (transfer.written < transfer.total) {
        const length = @min(chunk.len, transfer.total - transfer.written);
        for (chunk[0..length], transfer.written..) |*byte, index| byte.* = Transfer.byteAt(index);
        const taken = transfer.sender.write(transfer.stream, chunk[0..length]) catch return true;
        if (taken == 0) break;
        transfer.written += taken;
    }
    if (transfer.written == transfer.total and !transfer.ended) {
        transfer.sender.shutdown(transfer.stream) catch return true;
        transfer.ended = true;
    }
    if (!transfer.taken) {
        if (transfer.receiver.takeOpened(.bidirectional) == null) return false;
        transfer.taken = true;
    }
    while (transfer.receiver.read(transfer.stream, &chunk) catch return true) |length| {
        if (length == 0) return false;
        for (chunk[0..length], transfer.received..) |byte, index| {
            if (byte != Transfer.byteAt(index)) transfer.intact = false;
        }
        transfer.received += length;
    }
    return true;
}

/// Runs a session over `link` that carries `total` bytes on one stream, more than a stream takes at once: they wait
/// their turn as it sends, and all come intact, the stream's end after them.
pub fn expectTransfer(link: anytype, server_at: IpAddress, server_identity: Identity, total: usize) !void {
    var watched: Watched = .{};
    defer watched.deinit();
    const opened = try link.client.endpoint.connect(server_identity.publicKey(), server_at, link.now);
    try link.runUntil(&watched, bothReady);
    const accepted = watched.server.connectionOf(.accepted);
    const stream = try opened.openStream(.bidirectional);
    var transfer: Transfer = .{ .sender = opened, .receiver = accepted, .stream = stream, .total = total };
    try link.runUntil(&transfer, transferred);
    try testing.expectEqual(total, transfer.received);
    try testing.expect(transfer.intact);
    opened.close(0);
    try link.runUntil(&watched, bothClosed);
    link.client.endpoint.release(opened);
    link.server.endpoint.release(watched.server.connectionOf(.closed));
}

/// A relay of the tunnel's own serving on the loopback, a task of its own, and an HTTP client for peers' links to it.
pub const RelayRunning = struct {
    listener: std.Io.net.Server,
    server: relay.Server,
    serving: std.Io.Future(std.Io.Cancelable!void),
    client: std.http.Client,
    address_buffer: [32]u8,
    address_length: usize,

    pub fn start(running: *RelayRunning) !void {
        const io = testing.io;
        running.listener = try (try IpAddress.parseLiteral("127.0.0.1:0")).listen(io, .{});
        running.server = .init(testing.allocator, io, "127.0.0.1");
        running.serving = try io.concurrent(relay.Server.serve, .{ &running.server, &running.listener });
        running.client = .{ .allocator = testing.allocator, .io = io };
        running.address_length = (try std.fmt.bufPrint(&running.address_buffer, "ws://127.0.0.1:{d}", .{running.listener.socket.address.getPort()})).len;
    }

    pub fn stop(running: *RelayRunning) void {
        const io = testing.io;
        running.client.deinit();
        _ = running.serving.cancel(io) catch {};
        running.server.deinit();
        running.listener.deinit(io);
    }

    /// The relay's address, as peers' links open it.
    pub fn address(running: *const RelayRunning) []const u8 {
        return running.address_buffer[0..running.address_length];
    }

    pub fn open(running: *RelayRunning, home: Identity.PublicKey, identity: Identity) relay.Link.Error!*relay.Link {
        return relay.Link.open(&running.client, running.address(), home, identity);
    }
};
