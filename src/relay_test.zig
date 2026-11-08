//! Sessions between two endpoints that reach each other through a relay by their keys alone: each sends its datagrams
//! to the address its book has for the other, gathered by peer into frames for the relay, which forwards them as from
//! their sender; each takes the datagrams of a frame as from the address its book has for their sender.
const std = @import("std");
const Endpoint = @import("Endpoint.zig");
const Identity = @import("Identity.zig");
const relay = @import("relay.zig");
const scenario = @import("testing.zig");

const testing = std.testing;
const Key = Identity.PublicKey;
const IpAddress = std.Io.net.IpAddress;

/// The relay's number in the books: the one relay of the link.
const relay_number = 0;

/// An endpoint on the relay: its key and its link there, and its book of the peers it reaches through it.
const Side = struct {
    endpoint: *Endpoint,
    key: Key,
    link: relay.Router.Link,
    book: relay.Book = .{},
};

/// A frame on its way: to the relay from a side's link, or to a side from the relay.
const Flight = struct {
    to: enum { relay, client, server },
    from: relay.Router.Link,
    arrival: u64,
    bytes: []u8,
};

/// Two endpoints on one relay, the frames on their way, and the time; a frame takes the link's delay each way between
/// a side and the relay.
const Link = struct {
    client: Side,
    server: Side,
    router: relay.Router = .{},
    now: u64,
    delay: u64 = 10_000,
    in_flight: std.ArrayList(Flight) = .empty,

    fn init(client: *Endpoint, client_identity: Identity, server: *Endpoint, server_identity: Identity) !Link {
        var link: Link = .{
            .client = .{ .endpoint = client, .key = client_identity.publicKey(), .link = 1 },
            .server = .{ .endpoint = server, .key = server_identity.publicKey(), .link = 2 },
            .now = scenario.start,
        };
        _ = try link.router.join(testing.allocator, link.client.key, link.client.link);
        _ = try link.router.join(testing.allocator, link.server.key, link.server.link);
        return link;
    }

    fn deinit(link: *Link) void {
        for (link.in_flight.items) |flight| testing.allocator.free(flight.bytes);
        link.in_flight.deinit(testing.allocator);
        link.router.deinit(testing.allocator);
        link.client.book.deinit(testing.allocator);
        link.server.book.deinit(testing.allocator);
    }

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
        try link.sendFrom(&link.client);
        try link.sendFrom(&link.server);
        var next = @min(link.client.endpoint.wakeTime(link.now), link.server.endpoint.wakeTime(link.now));
        for (link.in_flight.items) |flight| next = @min(next, flight.arrival);
        if (next == std.math.maxInt(u64)) return error.Stalled;
        link.now = @max(link.now, next);
        var index: usize = 0;
        while (index < link.in_flight.items.len) {
            if (link.in_flight.items[index].arrival > link.now) {
                index += 1;
                continue;
            }
            const flight = link.in_flight.orderedRemove(index);
            defer testing.allocator.free(flight.bytes);
            try link.deliver(flight);
        }
    }

    /// Puts on the way to the relay what `side` has to send now: its datagrams, gathered by the peer they are for.
    fn sendFrom(link: *Link, side: *Side) !void {
        var held: std.ArrayList(struct { key: Key, bytes: [1536]u8, length: usize }) = .empty;
        defer held.deinit(testing.allocator);
        for (0..256) |_| {
            const datagram = try held.addOne(testing.allocator);
            const sent = try side.endpoint.send(&datagram.bytes, link.now) orelse {
                _ = held.pop();
                break;
            };
            datagram.key = (side.book.peerOf(sent.to) orelse return error.NotRelayed).key;
            datagram.length = sent.length;
        } else return error.Flooded;
        var first: usize = 0;
        while (first < held.items.len) {
            const key = held.items[first].key;
            var datagrams: std.ArrayList([]const u8) = .empty;
            defer datagrams.deinit(testing.allocator);
            for (held.items[first..]) |*datagram| {
                if (datagram.key.eql(key)) try datagrams.append(testing.allocator, datagram.bytes[0..datagram.length]);
            }
            var taken: usize = 0;
            while (taken < datagrams.items.len) {
                var buffer: [relay.frame.max_length]u8 = undefined;
                var writer: std.Io.Writer = .fixed(&buffer);
                taken += try relay.frame.writeDatagrams(&writer, key, datagrams.items[taken..]);
                try link.put(.relay, side.link, writer.buffered());
            }
            while (first < held.items.len and held.items[first].key.eql(key)) first += 1;
        }
    }

    fn put(link: *Link, to: @FieldType(Flight, "to"), from: relay.Router.Link, bytes: []const u8) !void {
        const owned = try testing.allocator.dupe(u8, bytes);
        errdefer testing.allocator.free(owned);
        try link.in_flight.append(testing.allocator, .{ .to = to, .from = from, .arrival = link.now + link.delay, .bytes = owned });
    }

    fn deliver(link: *Link, flight: Flight) !void {
        switch (flight.to) {
            .relay => {
                const sender = if (flight.from == link.client.link) link.client.key else link.server.key;
                switch (link.router.route(sender, flight.bytes)) {
                    .forward => |forward| try link.put(if (forward.link == link.client.link) .client else .server, 0, forward.bytes),
                    .gone => |key| {
                        var buffer: [1 + Key.length]u8 = undefined;
                        var writer: std.Io.Writer = .fixed(&buffer);
                        try relay.frame.writeGone(&writer, key);
                        try link.put(if (flight.from == link.client.link) .client else .server, 0, writer.buffered());
                    },
                    .refused => return error.Refused,
                }
            },
            .client => try link.take(&link.client, flight.bytes),
            .server => try link.take(&link.server, flight.bytes),
        }
    }

    /// Gives `side`'s endpoint the datagrams of a frame the relay sent it.
    fn take(link: *Link, side: *Side, bytes: []u8) !void {
        switch (try relay.frame.decode(bytes)) {
            .datagrams => |datagrams| {
                const from = try side.book.addressOf(testing.allocator, relay_number, datagrams.key);
                var each = datagrams.iterator();
                while (each.next()) |datagram| side.endpoint.receive(@constCast(datagram), from, relay.Book.localOf(relay_number), link.now);
            },
            .gone => {},
            else => return error.Refused,
        }
    }
};

test "two endpoints hold a session through a relay, each reaching the other by its key alone" {
    const client_identity = Identity.generate(testing.io);
    const server_identity = Identity.generate(testing.io);
    const client = try Endpoint.init(testing.allocator, testing.io, client_identity, scenario.start, .{});
    defer client.deinit();
    const server = try Endpoint.init(testing.allocator, testing.io, server_identity, scenario.start, .{});
    defer server.deinit();
    var link = try Link.init(client, client_identity, server, server_identity);
    defer link.deinit();
    const server_at = try link.client.book.addressOf(testing.allocator, relay_number, server_identity.publicKey());
    try scenario.expectSession(&link, server_at, client_identity, server_identity);
}

test "a session through a relay to a peer that shows another key than the one expected never becomes ready" {
    const client_identity = Identity.generate(testing.io);
    const server_identity = Identity.generate(testing.io);
    const client = try Endpoint.init(testing.allocator, testing.io, client_identity, scenario.start, .{});
    defer client.deinit();
    const server = try Endpoint.init(testing.allocator, testing.io, server_identity, scenario.start, .{});
    defer server.deinit();
    var link = try Link.init(client, client_identity, server, server_identity);
    defer link.deinit();
    const server_at = try link.client.book.addressOf(testing.allocator, relay_number, server_identity.publicKey());
    try scenario.expectAnotherKeyRefused(&link, server_at);
}
