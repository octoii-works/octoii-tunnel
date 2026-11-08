//! Sessions between two endpoints over a link in memory: a datagram one sends reaches the other the link's delay
//! later, and time moves on to the next arrival or the next time an endpoint asked to be called.
const std = @import("std");
const Endpoint = @import("Endpoint.zig");
const Connection = @import("Connection.zig");
const Identity = @import("Identity.zig");

const testing = std.testing;
const IpAddress = std.Io.net.IpAddress;

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
const Link = struct {
    client: Side,
    server: Side,
    now: u64,
    /// How long a datagram takes either way, in microseconds.
    delay: u64 = 10_000,
    in_flight: std.ArrayList(Flight) = .empty,

    /// The most datagrams an endpoint sends at one time: past it, it floods the link.
    const most_at_once = 256;

    fn deinit(link: *Link) void {
        link.in_flight.deinit(testing.allocator);
    }

    /// Runs the link till `done` holds of it; an error where it does not within the steps a session needs.
    fn runUntil(link: *Link, context: anytype, comptime done: fn (@TypeOf(context), *Link) bool) !void {
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

/// Every event an endpoint told, kept in order as the link runs.
const Told = struct {
    events: std.ArrayList(Endpoint.Event) = .empty,

    fn take(told: *Told, endpoint: *Endpoint) !void {
        while (endpoint.nextEvent()) |event| try told.events.append(testing.allocator, event);
    }

    fn has(told: *const Told, tag: std.meta.Tag(Endpoint.Event)) bool {
        for (told.events.items) |event| if (event == tag) return true;
        return false;
    }

    fn deinit(told: *Told) void {
        told.events.deinit(testing.allocator);
    }
};

/// The events of both sides of a link, as it runs.
const Watched = struct {
    client: Told = .{},
    server: Told = .{},

    fn deinit(watched: *Watched) void {
        watched.client.deinit();
        watched.server.deinit();
    }
};

fn linkOf(client: *Endpoint, server: *Endpoint, now: u64) !Link {
    return .{
        .client = .{ .endpoint = client, .at = try .parseLiteral("10.0.0.1:5000") },
        .server = .{ .endpoint = server, .at = try .parseLiteral("10.0.0.2:4433") },
        .now = now,
    };
}

fn bothReady(watched: *Watched, link: *Link) bool {
    watched.client.take(link.client.endpoint) catch return true;
    watched.server.take(link.server.endpoint) catch return true;
    return watched.client.has(.connected) and watched.server.has(.accepted);
}

fn bothClosed(watched: *Watched, link: *Link) bool {
    watched.client.take(link.client.endpoint) catch return true;
    watched.server.take(link.server.endpoint) catch return true;
    return watched.client.has(.closed) and watched.server.has(.closed);
}

fn clientClosed(watched: *Watched, link: *Link) bool {
    watched.client.take(link.client.endpoint) catch return true;
    watched.server.take(link.server.endpoint) catch return true;
    return watched.client.has(.closed);
}

/// What one stream of a session read, till its end.
const Reading = struct {
    connection: *Connection,
    stream: u64,
    bytes: std.ArrayList(u8) = .empty,
    ended: bool = false,

    fn deinit(reading: *Reading) void {
        reading.bytes.deinit(testing.allocator);
    }
};

fn readToEnd(reading: *Reading, link: *Link) bool {
    _ = link;
    var buffer: [64]u8 = undefined;
    while (reading.connection.read(reading.stream, &buffer)) |length| {
        if (length == 0) return false;
        reading.bytes.appendSlice(testing.allocator, buffer[0..length]) catch return true;
    }
    reading.ended = true;
    return true;
}

fn connectionOf(told: *const Told, tag: std.meta.Tag(Endpoint.Event)) *Connection {
    for (told.events.items) |event| switch (event) {
        .accepted, .connected, .closed => |connection| if (event == tag) return connection,
        .readable => {},
    };
    unreachable;
}

const start: u64 = 1_000_000;

test "two endpoints hold a session: each knows the other's key, and a stream carries bytes each way to its end" {
    const client_identity = Identity.generate(testing.io);
    const server_identity = Identity.generate(testing.io);
    const client = try Endpoint.init(testing.allocator, testing.io, client_identity, start, .{});
    defer client.deinit();
    const server = try Endpoint.init(testing.allocator, testing.io, server_identity, start, .{});
    defer server.deinit();
    var link = try linkOf(client, server, start);
    defer link.deinit();
    var watched: Watched = .{};
    defer watched.deinit();

    const opened = try client.connect(server_identity.publicKey(), link.server.at, link.now);
    try link.runUntil(&watched, bothReady);
    try testing.expectEqual(opened, connectionOf(&watched.client, .connected));
    const accepted = connectionOf(&watched.server, .accepted);
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
    server.release(connectionOf(&watched.server, .closed));
}

test "a session to a peer that shows another key than the one expected never becomes ready" {
    const server_identity = Identity.generate(testing.io);
    const client = try Endpoint.init(testing.allocator, testing.io, Identity.generate(testing.io), start, .{});
    defer client.deinit();
    const server = try Endpoint.init(testing.allocator, testing.io, server_identity, start, .{});
    defer server.deinit();
    var link = try linkOf(client, server, start);
    defer link.deinit();
    var watched: Watched = .{};
    defer watched.deinit();

    const opened = try client.connect(Identity.generate(testing.io).publicKey(), link.server.at, link.now);
    try link.runUntil(&watched, clientClosed);
    try testing.expect(!watched.client.has(.connected));
    try testing.expect(!watched.server.has(.accepted));
    client.release(opened);
}
