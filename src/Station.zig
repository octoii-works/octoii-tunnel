//! A station: an identity's endpoint at work on the host's io — the relays it is on, the sessions it opens and those
//! its peers open to it, and their streams. One task, the station's loop, runs the endpoint: it gives it what came from
//! the relays and the time, sends what the endpoint has to send — gathered by peer into frames for their relays — and
//! waits for whichever comes first, more to take or the time the endpoint asked to be called at. The station's lock
//! holds the endpoint and all it holds: the loop holds it as it works, and a task using a session or a stream takes it,
//! waiting on what the loop's work changes.
const Station = @This();
const std = @import("std");
const Endpoint = @import("Endpoint.zig");
const Connection = @import("Connection.zig");
const Identity = @import("Identity.zig");
const relay = @import("relay.zig");

const Io = std.Io;
const Key = Identity.PublicKey;

allocator: std.mem.Allocator,
io: Io,
endpoint: *Endpoint,
book: relay.Book = .{},
client: std.http.Client,
lock: Io.Mutex = .init,
/// Signalled when the loop has more to take: frames from relays, or work a session or a stream asked of it.
work: Io.Condition = .init,
/// Broadcast as the loop has worked: sessions ready or ended, bytes come, room made.
changed: Io.Condition = .init,
relays: std.ArrayList(*Relay) = .empty,
/// Frames from relays, not yet taken.
arrived: std.ArrayList(Arrival) = .empty,
/// Sessions peers opened, ready and not yet taken.
accepted: std.ArrayList(*Connection) = .empty,
/// Sessions their holders closed, released as they end.
abandoned: std.ArrayList(*Connection) = .empty,
/// Whether work was asked of the loop since it last worked.
asked: bool = false,
stopping: bool = false,
loop: ?Io.Future(void) = null,

/// How often a station pings each relay it is on, in microseconds; a relay answers without waking.
const ping_interval: u64 = 30 * std.time.us_per_s;

/// A relay the station is on: its link, the task reading it, and when it is next pinged.
const Relay = struct {
    link: *relay.Link,
    reader: ?Io.Future(void) = null,
    next_ping: u64,
    open: bool = true,
};

/// A frame a relay sent, in the station's allocator.
const Arrival = struct { relay: u16, bytes: []u8 };

/// A frame to send, or a ping, on a relay's link, as the loop sends them without the lock.
const Transmission = struct { relay: *Relay, bytes: ?[]const u8 };

pub const Error = error{ Stopped, Closed, Refused, Canceled, OutOfMemory };

/// A station for `identity`, its loop started on `io`.
pub fn init(allocator: std.mem.Allocator, io: Io, identity: Identity, options: Endpoint.Options) !*Station {
    const station = try allocator.create(Station);
    errdefer allocator.destroy(station);
    station.* = .{
        .allocator = allocator,
        .io = io,
        .endpoint = try Endpoint.init(allocator, io, identity, nowOf(io), options),
        .client = .{ .allocator = allocator, .io = io },
    };
    errdefer station.endpoint.deinit();
    station.loop = try io.concurrent(run, .{station});
    return station;
}

/// Stops the station: its loop, its relays' readers and links, and every session it holds.
pub fn deinit(station: *Station) void {
    const io = station.io;
    const allocator = station.allocator;
    station.lock.lockUncancelable(io);
    station.stopping = true;
    station.work.signal(io);
    station.changed.broadcast(io);
    station.lock.unlock(io);
    if (station.loop) |*loop| loop.await(io);
    for (station.relays.items) |each| {
        if (each.reader) |*reader| reader.cancel(io);
        each.link.close();
        allocator.destroy(each);
    }
    station.relays.deinit(allocator);
    for (station.arrived.items) |arrival| allocator.free(arrival.bytes);
    station.arrived.deinit(allocator);
    station.accepted.deinit(allocator);
    station.abandoned.deinit(allocator);
    station.endpoint.deinit();
    station.book.deinit(allocator);
    station.client.deinit();
    allocator.destroy(station);
}

/// The time now, in microseconds, by the io's clock that runs while the machine is awake.
fn nowOf(io: Io) u64 {
    return @intCast(Io.Timestamp.now(io, .awake).toMicroseconds());
}

/// Puts the station on the relay at `address`, in the home of `home`: the relay's number, by which sessions reach
/// peers through it.
pub fn join(station: *Station, address: []const u8, home: Key) (relay.Link.Error || Error)!u16 {
    const link = try relay.Link.open(&station.client, address, home, station.endpoint.identity);
    errdefer link.close();
    const joined = try station.allocator.create(Relay);
    errdefer station.allocator.destroy(joined);
    joined.* = .{ .link = link, .next_ping = nowOf(station.io) + ping_interval };
    station.lock.lockUncancelable(station.io);
    const number: u16 = @intCast(station.relays.items.len);
    station.relays.append(station.allocator, joined) catch |err| {
        station.lock.unlock(station.io);
        return err;
    };
    station.lock.unlock(station.io);
    joined.reader = station.io.concurrent(readRelay, .{ station, joined, number }) catch null;
    return number;
}

/// Reads a relay's link till it ends, handing its frames to the loop.
fn readRelay(station: *Station, from: *Relay, number: u16) void {
    const io = station.io;
    while (true) {
        const received = from.link.receive() catch break;
        switch (received) {
            .frame => |bytes| {
                const owned = station.allocator.dupe(u8, bytes) catch break;
                station.lock.lockUncancelable(io);
                defer station.lock.unlock(io);
                station.arrived.append(station.allocator, .{ .relay = number, .bytes = owned }) catch {
                    station.allocator.free(owned);
                    break;
                };
                station.work.signal(io);
            },
            .pong => {},
            .closed => break,
        }
    }
    station.lock.lockUncancelable(io);
    defer station.lock.unlock(io);
    from.open = false;
    station.changed.broadcast(io);
}

/// Opens a session to the peer of `peer` through relay `number`: the session once ready.
pub fn connect(station: *Station, peer: Key, number: u16) Error!*Connection {
    station.lock.lockUncancelable(station.io);
    defer station.lock.unlock(station.io);
    if (number >= station.relays.items.len) return error.Refused;
    const to = try station.book.addressOf(station.allocator, number, peer);
    const connection = station.endpoint.connect(peer, to, nowOf(station.io)) catch return error.Refused;
    station.ask();
    while (connection.state == .handshaking) try station.waitChanged();
    if (connection.state == .closed) {
        station.endpoint.release(connection);
        return error.Refused;
    }
    return connection;
}

/// The next session a peer opened to the station, once ready.
pub fn accept(station: *Station) Error!*Connection {
    station.lock.lockUncancelable(station.io);
    defer station.lock.unlock(station.io);
    while (station.accepted.items.len == 0) try station.waitChanged();
    return station.accepted.orderedRemove(0);
}

/// Closes a session the station gave: it is let go as it ends, and is not to be used again.
pub fn close(station: *Station, connection: *Connection) void {
    station.lock.lockUncancelable(station.io);
    defer station.lock.unlock(station.io);
    if (connection.state == .closed) return station.endpoint.release(connection);
    connection.close(0);
    station.abandoned.append(station.allocator, connection) catch {};
    station.ask();
}

/// Opens a stream of `connection`.
pub fn openStream(station: *Station, connection: *Connection) Error!u64 {
    station.lock.lockUncancelable(station.io);
    defer station.lock.unlock(station.io);
    return connection.openStream() catch |err| switch (err) {
        error.Closed => error.Closed,
        error.OutOfMemory => error.OutOfMemory,
    };
}

/// Writes all of `bytes` on `stream` of `connection`, waiting for room as the session sends what waits.
pub fn write(station: *Station, connection: *Connection, stream: u64, bytes: []const u8) Error!void {
    station.lock.lockUncancelable(station.io);
    defer station.lock.unlock(station.io);
    var written: usize = 0;
    while (true) {
        written += connection.write(stream, bytes[written..]) catch |err| return switch (err) {
            error.Closed, error.Ended => error.Closed,
            error.OutOfMemory => error.OutOfMemory,
        };
        station.ask();
        if (written == bytes.len) return;
        try station.waitChanged();
    }
}

/// Ends this side of `stream` of `connection`, once all written is sent.
pub fn shutdown(station: *Station, connection: *Connection, stream: u64) Error!void {
    station.lock.lockUncancelable(station.io);
    defer station.lock.unlock(station.io);
    connection.shutdown(stream) catch |err| return switch (err) {
        error.Closed => error.Closed,
        error.OutOfMemory => error.OutOfMemory,
    };
    station.ask();
}

/// Reads into `buffer` what came on `stream` of `connection`, waiting till something has: how many bytes, or null
/// where the peer ended the stream and all it sent was read.
pub fn read(station: *Station, connection: *Connection, stream: u64, buffer: []u8) Error!?usize {
    station.lock.lockUncancelable(station.io);
    defer station.lock.unlock(station.io);
    while (true) {
        const length = connection.read(stream, buffer) orelse return null;
        if (length > 0) return length;
        if (connection.state == .closed) return error.Closed;
        try station.waitChanged();
    }
}

/// Asks the loop to work, the lock held.
fn ask(station: *Station) void {
    station.asked = true;
    station.work.signal(station.io);
}

/// Waits, the lock held, till the loop has worked; `Stopped` where the station stops.
fn waitChanged(station: *Station) Error!void {
    if (station.stopping) return error.Stopped;
    station.changed.wait(station.io, &station.lock) catch return error.Canceled;
    if (station.stopping) return error.Stopped;
}

/// The loop: works, then waits for more, till the station stops.
fn run(station: *Station) void {
    const io = station.io;
    var arena_state: std.heap.ArenaAllocator = .init(station.allocator);
    defer arena_state.deinit();
    station.lock.lockUncancelable(io);
    defer station.lock.unlock(io);
    while (!station.stopping) {
        _ = arena_state.reset(.retain_capacity);
        const arena = arena_state.allocator();
        const now = nowOf(io);
        station.asked = false;
        station.takeArrived(now);
        const transmissions = station.gather(arena, now) catch &.{};
        station.tellEvents();
        station.changed.broadcast(io);
        station.lock.unlock(io);
        const failed = transmit(arena, transmissions);
        station.lock.lockUncancelable(io);
        for (failed) |each| each.open = false;
        station.waitForWork();
    }
}

/// Gives the endpoint the datagrams of every frame the relays sent, each from the address its book has for its
/// sender.
fn takeArrived(station: *Station, now: u64) void {
    defer station.arrived.clearRetainingCapacity();
    for (station.arrived.items) |arrival| {
        defer station.allocator.free(arrival.bytes);
        const datagrams = switch (relay.frame.decode(arrival.bytes) catch continue) {
            .datagrams => |datagrams| datagrams,
            else => continue,
        };
        const from = station.book.addressOf(station.allocator, arrival.relay, datagrams.key) catch continue;
        var each = datagrams.iterator();
        while (each.next()) |datagram| station.endpoint.receive(@constCast(datagram), from, relay.Book.localOf(arrival.relay), now);
    }
}

/// What the endpoint has to send now, as frames for the relays its peers are on, each gathering a peer's datagrams;
/// and the pings due.
fn gather(station: *Station, arena: std.mem.Allocator, now: u64) ![]const Transmission {
    const Outgoing = struct { relay: u16, key: Key, bytes: []const u8 };
    var outgoing: std.ArrayList(Outgoing) = .empty;
    var buffer: [relay.frame.max_datagram]u8 = undefined;
    while (try station.endpoint.send(&buffer, now)) |datagram| {
        const peer = station.book.peerOf(datagram.to) orelse continue;
        if (peer.relay >= station.relays.items.len) continue;
        try outgoing.append(arena, .{ .relay = peer.relay, .key = peer.key, .bytes = try arena.dupe(u8, buffer[0..datagram.length]) });
    }
    var transmissions: std.ArrayList(Transmission) = .empty;
    var done = try arena.alloc(bool, outgoing.items.len);
    @memset(done, false);
    for (outgoing.items, 0..) |first, index| {
        if (done[index]) continue;
        var datagrams: std.ArrayList([]const u8) = .empty;
        for (outgoing.items[index..], index..) |other, at| {
            if (other.relay != first.relay or !other.key.eql(first.key)) continue;
            try datagrams.append(arena, other.bytes);
            done[at] = true;
        }
        try station.putFrames(arena, &transmissions, first.relay, first.key, datagrams.items);
    }
    for (station.relays.items) |each| {
        if (!each.open or each.next_ping > now) continue;
        each.next_ping = now + ping_interval;
        try transmissions.append(arena, .{ .relay = each, .bytes = null });
    }
    return transmissions.items;
}

/// Puts `datagrams` for the peer of `key` into as many frames as they take, for relay `number`.
fn putFrames(station: *Station, arena: std.mem.Allocator, transmissions: *std.ArrayList(Transmission), number: u16, key: Key, datagrams: []const []const u8) !void {
    var taken: usize = 0;
    while (taken < datagrams.len) {
        const buffer = try arena.alloc(u8, relay.frame.max_length);
        var writer: Io.Writer = .fixed(buffer);
        taken += try relay.frame.writeDatagrams(&writer, key, datagrams[taken..]);
        try transmissions.append(arena, .{ .relay = station.relays.items[number], .bytes = writer.buffered() });
    }
}

/// Sends each transmission on its relay's link, without the lock; the relays whose links failed.
fn transmit(arena: std.mem.Allocator, transmissions: []const Transmission) []const *Relay {
    var failed: std.ArrayList(*Relay) = .empty;
    for (transmissions) |transmission| {
        if (!transmission.relay.open) continue;
        const sent = if (transmission.bytes) |bytes| transmission.relay.link.send(bytes) else transmission.relay.link.ping();
        sent catch failed.append(arena, transmission.relay) catch {};
    }
    return failed.items;
}

/// Takes what happened to the endpoint's sessions: sessions peers opened wait to be accepted; ended ones no one holds
/// any more are released.
fn tellEvents(station: *Station) void {
    while (station.endpoint.nextEvent()) |event| switch (event) {
        .accepted => |connection| station.accepted.append(station.allocator, connection) catch connection.close(0),
        .closed => |connection| {
            if (indexOf(station.accepted.items, connection)) |at| {
                _ = station.accepted.orderedRemove(at);
                station.endpoint.release(connection);
            } else if (indexOf(station.abandoned.items, connection)) |at| {
                _ = station.abandoned.swapRemove(at);
                station.endpoint.release(connection);
            }
        },
        .connected, .readable => {},
    };
}

fn indexOf(connections: []const *Connection, connection: *Connection) ?usize {
    return std.mem.indexOfScalar(*Connection, connections, connection);
}

/// Waits, the lock held, for more to take, till the endpoint's wake time or the next ping.
fn waitForWork(station: *Station) void {
    if (station.stopping or station.asked or station.arrived.items.len > 0) return;
    const now = nowOf(station.io);
    var wake = station.endpoint.wakeTime(now);
    for (station.relays.items) |each| {
        if (each.open) wake = @min(wake, each.next_ping);
    }
    if (wake <= now) return;
    const timeout: Io.Timeout = if (wake == std.math.maxInt(u64)) .none else .{ .deadline = .{ .raw = .fromNanoseconds(@as(i96, wake) * std.time.ns_per_us), .clock = .awake } };
    station.work.waitTimeout(station.io, &station.lock, timeout) catch {};
}
