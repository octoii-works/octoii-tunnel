//! Sessions between two endpoints over a link in memory: a datagram one sends reaches the other the link's delay
//! later, and time moves on to the next arrival or the next time an endpoint asked to be called.
const std = @import("std");
const Endpoint = @import("Endpoint.zig");
const Identity = @import("Identity.zig");
const scenario = @import("testing.zig");

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

fn linkOf(client: *Endpoint, server: *Endpoint, now: u64) !Link {
    return .{
        .client = .{ .endpoint = client, .at = try .parseLiteral("10.0.0.1:5000") },
        .server = .{ .endpoint = server, .at = try .parseLiteral("10.0.0.2:4433") },
        .now = now,
    };
}

test "two endpoints hold a session over a direct link: each knows the other's key, and a stream carries bytes each way to its end" {
    const client_identity = Identity.generate(testing.io);
    const server_identity = Identity.generate(testing.io);
    const client = try Endpoint.init(testing.allocator, testing.io, client_identity, scenario.start, .{});
    defer client.deinit();
    const server = try Endpoint.init(testing.allocator, testing.io, server_identity, scenario.start, .{});
    defer server.deinit();
    var link = try linkOf(client, server, scenario.start);
    defer link.deinit();
    try scenario.expectSession(&link, link.server.at, client_identity, server_identity);
}

test "a session over a direct link to a peer that shows another key than the one expected never becomes ready" {
    const client = try Endpoint.init(testing.allocator, testing.io, Identity.generate(testing.io), scenario.start, .{});
    defer client.deinit();
    const server = try Endpoint.init(testing.allocator, testing.io, Identity.generate(testing.io), scenario.start, .{});
    defer server.deinit();
    var link = try linkOf(client, server, scenario.start);
    defer link.deinit();
    try scenario.expectAnotherKeyRefused(&link, link.server.at);
}

test "a stream carries more bytes than it takes at once over a direct link, each in its turn and intact" {
    const server_identity = Identity.generate(testing.io);
    const client = try Endpoint.init(testing.allocator, testing.io, Identity.generate(testing.io), scenario.start, .{});
    defer client.deinit();
    const server = try Endpoint.init(testing.allocator, testing.io, server_identity, scenario.start, .{});
    defer server.deinit();
    var link = try linkOf(client, server, scenario.start);
    defer link.deinit();
    try scenario.expectTransfer(&link, link.server.at, server_identity, 3 * 1024 * 1024);
}
