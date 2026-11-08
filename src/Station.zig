//! A station: an identity's endpoint at work on the host's io — the relays it is on, the sessions it opens and those
//! its peers open to it, and their streams. One task, the station's loop, runs the endpoint: it gives it what came from
//! the relays and the time, sends what the endpoint has to send — gathered by peer into frames for their relays — and
//! waits for whichever comes first, more to take or the time the endpoint asked to be called at. The station's lock
//! holds the endpoint and all it holds: the loop holds it as it works, and a task using a session or a stream takes it,
//! waiting on what the loop's work changes. A station stays on each relay it joined: a task of the relay's reads its
//! link and, where the link ends, joins again, waiting longer after each failure, so the station's sessions through
//! the relay go on once it is back.
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
/// Told of what comes from the relays that no session is for.
listener: ?Listener = null,
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

/// How long a station waits before it joins a relay again after its link ended, in microseconds: the shortest wait,
/// doubled after each failure up to the longest.
const rejoin_first: u64 = 250 * std.time.us_per_ms;
const rejoin_longest: u64 = 30 * std.time.us_per_s;

/// A relay the station is on: where it is and the home joined there; its link, none while the station joins again; the
/// task keeping it; and when it is next pinged.
const Relay = struct {
    address: []const u8,
    home: Key,
    link: ?*relay.Link,
    /// Taken to send on the link and to change it, so no link goes while it is written.
    lock: Io.Mutex = .init,
    keeper: ?Io.Future(void) = null,
    next_ping: u64,
};

/// What a station's owner hears of its relays besides sessions: the frames between a home and its machine, and its
/// links' ending and coming back. Called on the task reading the link, which it must not hold up.
pub const Listener = struct {
    context: *anyopaque,
    /// A frame no session is for, good till the call returns.
    frame: *const fn (context: *anyopaque, number: u16, bytes: []const u8) void,
    linked: *const fn (context: *anyopaque, number: u16) void,
    unlinked: *const fn (context: *anyopaque, number: u16) void,
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

/// Stops the station: its loop, its relays' keepers and links, and every session it holds.
pub fn deinit(station: *Station) void {
    const io = station.io;
    const allocator = station.allocator;
    station.lock.lockUncancelable(io);
    station.stopping = true;
    station.work.signal(io);
    station.changed.broadcast(io);
    station.lock.unlock(io);
    if (station.loop) |*loop| loop.await(io);
    // A relay's keeper ends as it finds the station stopping: reading, as its link is shut down; waiting to join again,
    // as it is woken; joining, as it is canceled.
    for (station.relays.items) |each| {
        each.lock.lockUncancelable(io);
        if (each.link) |link| link.shutdown();
        each.lock.unlock(io);
        if (each.keeper) |*keeper| keeper.cancel(io);
        if (each.link) |link| link.close();
        allocator.free(each.address);
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

/// Puts the station on the relay at `address`, in the home of `home`, for as long as the station lasts: the relay's
/// number, by which sessions reach peers through it.
pub fn join(station: *Station, address: []const u8, home: Key) (relay.Link.Error || Error)!u16 {
    const link = try relay.Link.open(&station.client, address, home, station.endpoint.identity);
    errdefer link.close();
    const joined = try station.allocator.create(Relay);
    errdefer station.allocator.destroy(joined);
    joined.* = .{ .address = try station.allocator.dupe(u8, address), .home = home, .link = link, .next_ping = nowOf(station.io) + ping_interval };
    errdefer station.allocator.free(joined.address);
    station.lock.lockUncancelable(station.io);
    const number: u16 = @intCast(station.relays.items.len);
    station.relays.append(station.allocator, joined) catch |err| {
        station.lock.unlock(station.io);
        return err;
    };
    station.lock.unlock(station.io);
    joined.keeper = station.io.concurrent(keepRelay, .{ station, joined, number }) catch null;
    return number;
}

/// Has `listener` told of what comes from the station's relays that no session is for. Set before the station joins a
/// relay, for as long as it is on one.
pub fn listen(station: *Station, listener: Listener) void {
    station.listener = listener;
}

/// Sends a frame on the link to the relay of `number`; `Gone` while the station joins it again.
pub fn sendFrame(station: *Station, number: u16, bytes: []const u8) !void {
    station.lock.lockUncancelable(station.io);
    const kept = station.relays.items[number];
    station.lock.unlock(station.io);
    kept.lock.lockUncancelable(station.io);
    defer kept.lock.unlock(station.io);
    const link = kept.link orelse return error.Gone;
    try link.send(bytes);
}

/// Keeps the station on a relay till the station stops: its link read, and the relay joined again where the link ends.
fn keepRelay(station: *Station, kept: *Relay, number: u16) void {
    while (true) {
        station.readRelay(kept.link.?, number);
        if (station.listener) |listener| listener.unlinked(listener.context, number);
        kept.lock.lockUncancelable(station.io);
        const ended = kept.link.?;
        kept.link = null;
        kept.lock.unlock(station.io);
        ended.close();
        if (!station.rejoin(kept)) return;
        if (station.listener) |listener| listener.linked(listener.context, number);
    }
}

/// Reads a relay's link till it ends, handing its frames to the loop.
fn readRelay(station: *Station, link: *relay.Link, number: u16) void {
    const io = station.io;
    while (true) {
        const received = link.receive() catch return;
        switch (received) {
            .frame => |bytes| {
                if (relay.frame.isHomeFrame(bytes)) {
                    if (station.listener) |listener| listener.frame(listener.context, number, bytes);
                    continue;
                }
                const owned = station.allocator.dupe(u8, bytes) catch return;
                station.lock.lockUncancelable(io);
                defer station.lock.unlock(io);
                station.arrived.append(station.allocator, .{ .relay = number, .bytes = owned }) catch {
                    station.allocator.free(owned);
                    return;
                };
                station.work.signal(io);
            },
            .pong => {},
            .closed => return,
        }
    }
}

/// Joins a relay again, its link ended, waiting before each try — longer after each that failed: whether it did,
/// false where the station stops first.
fn rejoin(station: *Station, kept: *Relay) bool {
    var wait = rejoin_first;
    while (station.pause(wait)) : (wait = @min(2 * wait, rejoin_longest)) {
        const link = relay.Link.open(&station.client, kept.address, kept.home, station.endpoint.identity) catch continue;
        station.lock.lockUncancelable(station.io);
        defer station.lock.unlock(station.io);
        if (station.stopping) {
            link.close();
            return false;
        }
        kept.lock.lockUncancelable(station.io);
        kept.link = link;
        kept.lock.unlock(station.io);
        return true;
    }
    return false;
}

/// Waits `wait` microseconds: whether it did, false where the station stops first.
fn pause(station: *Station, wait: u64) bool {
    station.lock.lockUncancelable(station.io);
    defer station.lock.unlock(station.io);
    const until = nowOf(station.io) + wait;
    while (!station.stopping) {
        if (nowOf(station.io) >= until) return true;
        station.changed.waitTimeout(station.io, &station.lock, deadlineOf(until)) catch |err| switch (err) {
            error.Timeout => {},
            error.Canceled => return false,
        };
    }
    return false;
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

/// Closes a session the station gave, with `code`, the reason its peer is told where it had not ended: it is let go
/// as it ends, and is not to be used again, nor any of its streams.
pub fn close(station: *Station, connection: *Connection, code: u64) void {
    station.lock.lockUncancelable(station.io);
    defer station.lock.unlock(station.io);
    if (connection.state == .closed) return station.endpoint.release(connection);
    connection.close(code);
    station.abandoned.append(station.allocator, connection) catch {};
    station.ask();
}

/// Ends a session the station gave with `code`, the reason its peer is told: its streams' reads and writes fail from
/// then on, and it is its holder's till they close it.
pub fn end(station: *Station, connection: *Connection, code: u64) void {
    station.lock.lockUncancelable(station.io);
    defer station.lock.unlock(station.io);
    connection.close(code);
    station.ask();
}

/// Opens a stream of `connection`, of `kind`.
pub fn openStream(station: *Station, connection: *Connection, kind: Connection.Kind) Error!Stream {
    station.lock.lockUncancelable(station.io);
    defer station.lock.unlock(station.io);
    const id = connection.openStream(kind) catch |err| return switch (err) {
        error.Closed => error.Closed,
        error.OutOfMemory => error.OutOfMemory,
    };
    return .{ .station = station, .connection = connection, .id = id };
}

/// The next stream of `kind` the peer of `connection` opened, once it has.
pub fn acceptStream(station: *Station, connection: *Connection, kind: Connection.Kind) Error!Stream {
    station.lock.lockUncancelable(station.io);
    defer station.lock.unlock(station.io);
    while (true) {
        if (connection.takeOpened(kind)) |id| return .{ .station = station, .connection = connection, .id = id };
        if (connection.state == .closed) return error.Closed;
        try station.waitChanged();
    }
}

/// A stream of a session the station gave, as its holder reads and writes it, till they close it.
pub const Stream = struct {
    station: *Station,
    connection: *Connection,
    id: u64,

    pub const Error = Station.Error || error{Reset};

    /// Writes all of `bytes`, waiting for room as the session sends what waits; `Reset` where the peer stopped the
    /// stream.
    pub fn write(stream: Stream, bytes: []const u8) Stream.Error!void {
        const station = stream.station;
        station.lock.lockUncancelable(station.io);
        defer station.lock.unlock(station.io);
        var written: usize = 0;
        while (true) {
            written += stream.connection.write(stream.id, bytes[written..]) catch |err| return switch (err) {
                error.Closed => error.Closed,
                error.Reset => error.Reset,
                error.OutOfMemory => error.OutOfMemory,
            };
            station.ask();
            if (written == bytes.len) return;
            try station.waitChanged();
        }
    }

    /// Ends this side's way of the stream, once all written is sent.
    pub fn shutdown(stream: Stream) Stream.Error!void {
        const station = stream.station;
        station.lock.lockUncancelable(station.io);
        defer station.lock.unlock(station.io);
        try stream.connection.shutdown(stream.id);
        station.ask();
    }

    /// Reads into `buffer` what came, waiting till something has: how many bytes, or null where the peer ended the
    /// stream and all it sent was read; `Reset` where the peer reset it.
    pub fn read(stream: Stream, buffer: []u8) Stream.Error!?usize {
        const station = stream.station;
        station.lock.lockUncancelable(station.io);
        defer station.lock.unlock(station.io);
        while (true) {
            const length = try stream.connection.read(stream.id, buffer) orelse return null;
            if (length > 0) {
                // What was read opens the stream's window: the loop tells the peer.
                station.ask();
                return length;
            }
            if (stream.connection.state == .closed) return error.Closed;
            try station.waitChanged();
        }
    }

    /// Stops receiving: what came is dropped, a read waiting or to come finds the end, and the peer is asked to stop
    /// sending with `code` where it still was.
    pub fn stopReceiving(stream: Stream, code: u64) void {
        const station = stream.station;
        station.lock.lockUncancelable(station.io);
        defer station.lock.unlock(station.io);
        stream.connection.stopReceiving(stream.id, code);
        station.ask();
    }

    /// Lets go of the stream: receiving stopped as `stopReceiving` stops it, and this side's way ended where it was
    /// not. The stream is not to be used again.
    pub fn close(stream: Stream, code: u64) void {
        const station = stream.station;
        station.lock.lockUncancelable(station.io);
        defer station.lock.unlock(station.io);
        stream.connection.closeStream(stream.id, code);
        station.ask();
    }
};

/// Runs `step` on `context` under the station's lock — which holds its sessions and their streams — till it gives an
/// answer, waiting for the loop's work between tries, as a driver of a session's state waits on it: `step` gives null
/// to wait. Where a try left the endpoint something to do now, the loop is asked to.
pub fn drive(station: *Station, context: anytype, comptime step: anytype) Driven(@TypeOf(step)) {
    station.lock.lockUncancelable(station.io);
    defer station.lock.unlock(station.io);
    while (true) {
        const answer = step(context);
        station.askIfDue();
        if (try answer) |given| return given;
        try station.waitChanged();
    }
}

/// What `drive` gives for a step of type `Step`: its answer, or its error or the station's.
fn Driven(comptime Step: type) type {
    const returned = @typeInfo(@typeInfo(Step).@"fn".return_type.?).error_union;
    return (returned.error_set || Error)!@typeInfo(returned.payload).optional.child;
}

/// Asks the loop to work, the lock held, where the endpoint has something to do now.
fn askIfDue(station: *Station) void {
    const now = nowOf(station.io);
    if (station.endpoint.wakeTime(now) <= now) station.ask();
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
        station.transmit(transmissions);
        station.lock.lockUncancelable(io);
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
        if (each.next_ping > now) continue;
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

/// Sends each transmission on its relay's link, without the station's lock: one for a relay being joined again is
/// dropped, as a network drops what it cannot carry, and a link that fails is shut down, so its keeper joins again.
fn transmit(station: *Station, transmissions: []const Transmission) void {
    for (transmissions) |transmission| {
        const kept = transmission.relay;
        kept.lock.lockUncancelable(station.io);
        defer kept.lock.unlock(station.io);
        const link = kept.link orelse continue;
        const sent = if (transmission.bytes) |bytes| link.send(bytes) else link.ping();
        sent catch link.shutdown();
    }
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
    for (station.relays.items) |each| wake = @min(wake, each.next_ping);
    if (wake <= now) return;
    station.work.waitTimeout(station.io, &station.lock, deadlineOf(wake)) catch {};
}

/// The timeout of a wait till `until`, in microseconds by the clock `nowOf` reads.
fn deadlineOf(until: u64) Io.Timeout {
    if (until == std.math.maxInt(u64)) return .none;
    return .{ .deadline = .{ .raw = .fromNanoseconds(@as(i96, until) * std.time.ns_per_us), .clock = .awake } };
}
