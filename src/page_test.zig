//! A page's session, stepped as a page steps it: frames carried between it and a machine by a relay in memory, each way
//! taking the time a network takes, a request answered and a WebSocket spoken on.
const std = @import("std");
const Endpoint = @import("Endpoint.zig");
const Connection = @import("Connection.zig");
const Identity = @import("Identity.zig");
const Page = @import("Page.zig");
const http3 = @import("http3.zig");
const frame = @import("relay/frame.zig");
const scenario = @import("testing.zig");

const testing = std.testing;
const Session = http3.Session;
const IpAddress = std.Io.net.IpAddress;

/// How long the relay takes to carry a frame either way, in microseconds.
const delay = 10_000;

/// A page and a machine, and the relay between them.
const Pair = struct {
    device: Identity,
    machine: Identity,
    page: *Page,
    endpoint: *Endpoint,
    accepted: ?*Connection = null,
    session: ?Session = null,
    now: u64 = scenario.start,
    from_page: IpAddress,
    to_machine: IpAddress,

    fn open() !Pair {
        const device = Identity.generate(testing.io);
        const machine = Identity.generate(testing.io);
        const page = try Page.init(testing.allocator, testing.io, device, scenario.start);
        errdefer page.deinit();
        const endpoint = try Endpoint.init(testing.allocator, testing.io, machine, scenario.start, .{});
        return .{
            .device = device,
            .machine = machine,
            .page = page,
            .endpoint = endpoint,
            .from_page = try .parseLiteral("10.0.0.1:5000"),
            .to_machine = try .parseLiteral("10.0.0.2:4433"),
        };
    }

    fn close(pair: *Pair) void {
        if (pair.session) |*session| session.deinit();
        pair.page.deinit();
        pair.endpoint.deinit();
    }

    /// One round: the page stepped and its frames carried, the machine's datagrams carried back, and time moved on.
    fn round(pair: *Pair) !void {
        pair.page.step(pair.now);
        const to_machine = try pair.framesOfPage();
        defer testing.allocator.free(to_machine);
        pair.now += delay;
        var datagrams: frame.Datagrams = undefined;
        var rest = to_machine;
        while (rest.len > 0) {
            const length = std.mem.readInt(u32, rest[0..4], .little);
            datagrams = (try frame.decode(rest[4..][0..length])).datagrams;
            var each = datagrams.iterator();
            while (each.next()) |datagram| pair.endpoint.receive(@constCast(datagram), pair.from_page, pair.to_machine, pair.now);
            rest = rest[4 + length ..];
        }
        pair.now += delay;
        var bytes: [frame.max_datagram]u8 = undefined;
        while (try pair.endpoint.send(&bytes, pair.now)) |datagram| {
            var message: [frame.max_length]u8 = undefined;
            var writer: std.Io.Writer = .fixed(&message);
            _ = try frame.writeDatagrams(&writer, pair.machine.publicKey(), &.{bytes[0..datagram.length]});
            pair.page.take(writer.buffered(), pair.now);
        }
        while (pair.endpoint.nextEvent()) |event| switch (event) {
            .accepted => |connection| {
                pair.accepted = connection;
                pair.session = try Session.init(testing.allocator, connection);
            },
            .closed => |connection| pair.endpoint.release(connection),
            .connected, .readable => {},
        };
        if (pair.session) |*session| try session.poll();
        pair.now = @max(pair.now + 1000, @min(pair.page.wakeTime(pair.now), pair.endpoint.wakeTime(pair.now)));
    }

    /// The frames the page has to send now, each after its length.
    fn framesOfPage(pair: *Pair) ![]u8 {
        var frames: std.ArrayList(u8) = .empty;
        errdefer frames.deinit(testing.allocator);
        var buffer: [frame.max_length]u8 = undefined;
        while (try pair.page.nextFrame(&buffer, pair.now)) |length| {
            var prefix: [4]u8 = undefined;
            std.mem.writeInt(u32, &prefix, @intCast(length), .little);
            try frames.appendSlice(testing.allocator, &prefix);
            try frames.appendSlice(testing.allocator, buffer[0..length]);
        }
        return frames.toOwnedSlice(testing.allocator);
    }

    fn runUntil(pair: *Pair, context: anytype, comptime done: anytype) !void {
        for (0..2_000) |_| {
            if (try done(context, pair)) return;
            try pair.round();
        }
        return error.NeverDone;
    }
};

fn isReady(_: void, pair: *Pair) !bool {
    return pair.page.state() == .ready and pair.session != null;
}

fn opened(pair: *Pair) !void {
    try pair.page.connect(pair.machine.publicKey(), pair.now);
    try pair.runUntil({}, isReady);
}

/// A body read to its end, from the page's side.
const Reading = struct { stream: u64, body: std.ArrayList(u8) = .empty, ended: bool = false };

fn bodyRead(reading: *Reading, pair: *Pair) !bool {
    if (try pair.page.head(reading.stream) == null) return false;
    var buffer: [1024]u8 = undefined;
    while (try pair.page.read(reading.stream, &buffer)) |length| {
        if (length == 0) return false;
        try reading.body.appendSlice(testing.allocator, buffer[0..length]);
    }
    return true;
}

fn requestTaken(taken: *?u64, pair: *Pair) !bool {
    taken.* = pair.session.?.takeRequest();
    return taken.* != null;
}

fn takesSockets(_: void, pair: *Pair) !bool {
    return pair.page.takesSockets() orelse false;
}

test "a page asks its machine through a relay, and reads the answer" {
    var pair = try Pair.open();
    defer pair.close();
    try opened(&pair);
    const stream = (try pair.page.open(&.{
        .{ .name = ":method", .value = "GET" },
        .{ .name = ":scheme", .value = "https" },
        .{ .name = ":authority", .value = "machine" },
        .{ .name = ":path", .value = "/hello" },
    })).?;
    try pair.page.finish(stream);
    var taken: ?u64 = null;
    try pair.runUntil(&taken, requestTaken);
    const session = &pair.session.?;
    try testing.expect(try session.sendHead(taken.?, &.{&.{.{ .name = ":status", .value = "401" }}}));
    try testing.expectEqual(5, try session.writeBody(taken.?, "nope!"));
    try session.finish(taken.?);
    var reading: Reading = .{ .stream = stream };
    defer reading.body.deinit(testing.allocator);
    try pair.runUntil(&reading, bodyRead);
    try testing.expectEqualStrings("nope!", reading.body.items);
    var lines = (try pair.page.head(stream)).?.iterator();
    const status = lines.next().?;
    try testing.expectEqualStrings(":status", status.name);
    try testing.expectEqualStrings("401", status.value);
    pair.page.close(stream);
}

/// The next message on the page's WebSocket, once it has come.
const Listening = struct { stream: u64, text: std.ArrayList(u8) = .empty };

fn messageCame(listening: *Listening, pair: *Pair) !bool {
    const message = try pair.page.nextMessage(listening.stream) orelse return false;
    try listening.text.appendSlice(testing.allocator, message.text);
    return true;
}

/// What the machine read of a stream, as much as `want`.
const Machine = struct { stream: u64, want: usize, bytes: std.ArrayList(u8) = .empty };

fn machineRead(machine: *Machine, pair: *Pair) !bool {
    var buffer: [256]u8 = undefined;
    while (machine.bytes.items.len < machine.want) {
        const length = (try pair.session.?.readBody(machine.stream, &buffer)) orelse return error.Ended;
        if (length == 0) return false;
        try machine.bytes.appendSlice(testing.allocator, buffer[0..length]);
    }
    return true;
}

test "a page speaks to its machine on a WebSocket, a message split in two frames gathered whole" {
    var pair = try Pair.open();
    defer pair.close();
    try opened(&pair);
    try pair.runUntil({}, takesSockets);
    const stream = (try pair.page.openSocket("/ws", "machine", &.{})).?;
    var taken: ?u64 = null;
    try pair.runUntil(&taken, requestTaken);
    const session = &pair.session.?;
    var head = (try session.head(taken.?)).?.iterator();
    try testing.expectEqualStrings("CONNECT", head.next().?.value);
    try testing.expect(try session.sendHead(taken.?, &.{&.{.{ .name = ":status", .value = "200" }}}));

    try pair.page.sendMessage(stream, .text, "hi machine");
    var machine: Machine = .{ .stream = taken.?, .want = 2 + 4 + 10 };
    defer machine.bytes.deinit(testing.allocator);
    try pair.runUntil(&machine, machineRead);
    const mask = machine.bytes.items[2..6];
    var unmasked: [10]u8 = undefined;
    for (&unmasked, machine.bytes.items[6..16], 0..) |*out, byte, index| out.* = byte ^ mask[index % 4];
    try testing.expectEqualStrings("hi machine", &unmasked);

    // A text in two frames, with a ping between them: the ping answered, the text whole.
    _ = try session.writeBody(taken.?, "\x01\x03hel\x89\x00\x80\x02lo");
    var listening: Listening = .{ .stream = stream };
    defer listening.text.deinit(testing.allocator);
    try pair.runUntil(&listening, messageCame);
    try testing.expectEqualStrings("hello", listening.text.items);
    var pong: Machine = .{ .stream = taken.?, .want = 6 };
    defer pong.bytes.deinit(testing.allocator);
    try pair.runUntil(&pong, machineRead);
    try testing.expectEqual(0x8a, pong.bytes.items[0]);
    pair.page.close(stream);
}

test "the relay saying the machine is away is told, and the page takes what is no frame" {
    var pair = try Pair.open();
    defer pair.close();
    try pair.page.connect(pair.machine.publicKey(), pair.now);
    try testing.expectEqual(Page.State.connecting, pair.page.state());
    var buffer: [64]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&buffer);
    try frame.writeGone(&writer, pair.machine.publicKey());
    pair.page.take(writer.buffered(), pair.now);
    try testing.expectEqual(Page.State.machine_away, pair.page.state());
    pair.page.take("not a frame", pair.now);
    try testing.expectEqual(Page.State.machine_away, pair.page.state());
}
