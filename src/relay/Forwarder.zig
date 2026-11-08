//! A machine's end of the streams its home opens to its routes: each stream carried to the local port its route names,
//! over TCP on the loopback, byte for byte. Each direction is paced by the window its receiver grants, so a slow reader
//! at either end holds the other to a window and no more. A task serves each stream; the frames come from the task
//! reading the machine's link, which only hands them over and never waits.
const Forwarder = @This();
const std = @import("std");
const frame = @import("frame.zig");

const Io = std.Io;

/// How many bytes of a stream each end takes before it grants more.
pub const initial_window: u32 = 256 * 1024;

/// How many bytes a stream's receiver consumes before it grants them again.
const grant_threshold: u32 = 64 * 1024;

/// How a forwarder sends a frame on the machine's link to its home.
pub const Uplink = struct {
    context: *anyopaque,
    send: *const fn (context: *anyopaque, bytes: []const u8) anyerror!void,
};

/// The machine's routes, as a forwarder asks after them.
pub const Routes = struct {
    context: *anyopaque,
    /// The local port of the route `name`; null where it has none.
    portOf: *const fn (context: *anyopaque, name: []const u8) ?u16,
    /// Removes the route `name`, as the home asks.
    remove: *const fn (context: *anyopaque, name: []const u8) void,
};

allocator: std.mem.Allocator,
io: Io,
uplink: Uplink,
routes: Routes,
lock: Io.Mutex = .init,
changed: Io.Condition = .init,
streams: std.AutoHashMapUnmanaged(u32, *Stream) = .empty,
tasks: Io.Group = .init,
stopping: bool = false,

/// A stream the home opened: its connection to the local port, what the home sent that the port has yet to take, and
/// how far each direction has come. Its fields are under the forwarder's lock.
const Stream = struct {
    id: u32,
    socket: ?Io.net.Stream = null,
    /// How many bytes the home still takes of what the port sends.
    window: u32 = initial_window,
    /// How many bytes the home may still send of what this end has granted.
    granted: u32 = initial_window,
    inbound: std.ArrayList(u8) = .empty,
    inbound_ended: bool = false,
    reset: bool = false,
};

/// A forwarder sending on `uplink` to the local ports of `routes`.
pub fn init(allocator: std.mem.Allocator, io: Io, uplink: Uplink, routes: Routes) Forwarder {
    return .{ .allocator = allocator, .io = io, .uplink = uplink, .routes = routes };
}

/// Gives up every stream and waits for their tasks.
pub fn deinit(forwarder: *Forwarder) void {
    forwarder.lock.lockUncancelable(forwarder.io);
    forwarder.stopping = true;
    forwarder.resetAll();
    forwarder.lock.unlock(forwarder.io);
    forwarder.tasks.await(forwarder.io) catch {};
    forwarder.streams.deinit(forwarder.allocator);
}

/// Takes a frame of the machine's link: a stream's, or a route's removal. Others are not the forwarder's.
pub fn receive(forwarder: *Forwarder, bytes: []const u8) void {
    switch (frame.decode(bytes) catch return) {
        .stream_open => |opened| forwarder.open(opened),
        .stream_data => |data| forwarder.take(data),
        .stream_end => |id| forwarder.endInbound(id),
        .stream_reset => |id| forwarder.giveUp(id),
        .stream_window => |window| forwarder.grow(window),
        .route_remove => |name| forwarder.routes.remove(forwarder.routes.context, name),
        else => {},
    }
}

/// Gives up every stream, the link they came on having ended.
pub fn unlinked(forwarder: *Forwarder) void {
    forwarder.lock.lockUncancelable(forwarder.io);
    defer forwarder.lock.unlock(forwarder.io);
    forwarder.resetAll();
}

fn resetAll(forwarder: *Forwarder) void {
    var streams = forwarder.streams.valueIterator();
    while (streams.next()) |stream| forwarder.markReset(stream.*);
    forwarder.changed.broadcast(forwarder.io);
}

/// Marks `stream` given up, and wakes a read of its port by shutting the connection down: a read blocked on a socket
/// is woken by that, where a cancel may be lost.
fn markReset(forwarder: *Forwarder, stream: *Stream) void {
    stream.reset = true;
    if (stream.socket) |socket| socket.shutdown(forwarder.io, .both) catch {};
}

fn open(forwarder: *Forwarder, opened: frame.StreamOpen) void {
    const io = forwarder.io;
    const port = forwarder.routes.portOf(forwarder.routes.context, opened.route) orelse return forwarder.sendSignal(.stream_reset, opened.id);
    const stream = forwarder.allocator.create(Stream) catch return forwarder.sendSignal(.stream_reset, opened.id);
    stream.* = .{ .id = opened.id };
    forwarder.lock.lockUncancelable(io);
    defer forwarder.lock.unlock(io);
    if (forwarder.stopping or forwarder.streams.contains(opened.id)) {
        forwarder.allocator.destroy(stream);
        return;
    }
    forwarder.streams.put(forwarder.allocator, opened.id, stream) catch {
        forwarder.allocator.destroy(stream);
        return;
    };
    forwarder.tasks.concurrent(io, serve, .{ forwarder, stream, port }) catch {
        _ = forwarder.streams.remove(opened.id);
        forwarder.allocator.destroy(stream);
    };
}

fn take(forwarder: *Forwarder, data: frame.StreamData) void {
    forwarder.lock.lockUncancelable(forwarder.io);
    defer forwarder.lock.unlock(forwarder.io);
    const stream = forwarder.streams.get(data.id) orelse return;
    // A home that sends past what it was granted breaks the stream's pacing: the stream is given up.
    if (data.bytes.len > stream.granted) return forwarder.refuse(stream);
    stream.granted -= @intCast(data.bytes.len);
    stream.inbound.appendSlice(forwarder.allocator, data.bytes) catch return forwarder.refuse(stream);
    forwarder.changed.broadcast(forwarder.io);
}

fn refuse(forwarder: *Forwarder, stream: *Stream) void {
    forwarder.markReset(stream);
    forwarder.changed.broadcast(forwarder.io);
}

fn endInbound(forwarder: *Forwarder, id: u32) void {
    forwarder.lock.lockUncancelable(forwarder.io);
    defer forwarder.lock.unlock(forwarder.io);
    const stream = forwarder.streams.get(id) orelse return;
    stream.inbound_ended = true;
    forwarder.changed.broadcast(forwarder.io);
}

fn giveUp(forwarder: *Forwarder, id: u32) void {
    forwarder.lock.lockUncancelable(forwarder.io);
    defer forwarder.lock.unlock(forwarder.io);
    const stream = forwarder.streams.get(id) orelse return;
    forwarder.refuse(stream);
}

fn grow(forwarder: *Forwarder, window: frame.StreamWindow) void {
    forwarder.lock.lockUncancelable(forwarder.io);
    defer forwarder.lock.unlock(forwarder.io);
    const stream = forwarder.streams.get(window.id) orelse return;
    stream.window +|= window.grant;
    forwarder.changed.broadcast(forwarder.io);
}

/// Serves one stream: its port connected, both directions carried, and the stream let go.
fn serve(forwarder: *Forwarder, stream: *Stream, port: u16) void {
    const io = forwarder.io;
    defer forwarder.release(stream);
    const address: Io.net.IpAddress = .{ .ip4 = .loopback(port) };
    const socket = address.connect(io, .{ .mode = .stream }) catch return forwarder.sendSignal(.stream_reset, stream.id);
    defer socket.close(io);
    forwarder.lock.lockUncancelable(io);
    const reset = stream.reset;
    if (!reset) stream.socket = socket;
    forwarder.lock.unlock(io);
    if (reset) return;
    var inbound = io.concurrent(carryInbound, .{ forwarder, stream, socket }) catch return forwarder.sendSignal(.stream_reset, stream.id);
    const finished = forwarder.carryOutbound(stream, socket);
    if (!finished) {
        forwarder.lock.lockUncancelable(io);
        forwarder.refuse(stream);
        forwarder.lock.unlock(io);
    }
    inbound.await(io);
    // The connection closes next: nothing may shut it down from here, its descriptor being free to be used again.
    forwarder.lock.lockUncancelable(io);
    stream.socket = null;
    forwarder.lock.unlock(io);
}

/// Carries what the port sends to the home, within the home's window, then tells the home it ended: whether it came
/// to that end.
fn carryOutbound(forwarder: *Forwarder, stream: *Stream, socket: Io.net.Stream) bool {
    const io = forwarder.io;
    var buffer: [frame.max_stream_data]u8 = undefined;
    var reader = socket.reader(io, &buffer);
    var message: [frame.max_length]u8 = undefined;
    while (true) {
        reader.interface.fill(1) catch |err| switch (err) {
            error.EndOfStream => {
                if (forwarder.isReset(stream)) return false;
                forwarder.sendSignal(.stream_end, stream.id);
                return true;
            },
            error.ReadFailed => {
                if (!forwarder.isReset(stream)) forwarder.sendSignal(.stream_reset, stream.id);
                return false;
            },
        };
        const room = forwarder.awaitWindow(stream) orelse return false;
        const bytes = reader.interface.buffered();
        const taken = bytes[0..@min(bytes.len, room)];
        forwarder.spend(stream, @intCast(taken.len));
        var writer: Io.Writer = .fixed(&message);
        frame.writeStreamData(&writer, stream.id, taken) catch unreachable;
        forwarder.uplink.send(forwarder.uplink.context, writer.buffered()) catch return false;
        reader.interface.toss(taken.len);
    }
}

fn isReset(forwarder: *Forwarder, stream: *Stream) bool {
    forwarder.lock.lockUncancelable(forwarder.io);
    defer forwarder.lock.unlock(forwarder.io);
    return stream.reset;
}

/// Waits till the home takes more of the stream: how many bytes may be sent, up to a frame's worth; null where the
/// stream was given up.
fn awaitWindow(forwarder: *Forwarder, stream: *Stream) ?u32 {
    const io = forwarder.io;
    forwarder.lock.lockUncancelable(io);
    defer forwarder.lock.unlock(io);
    while (true) {
        if (stream.reset) return null;
        if (stream.window > 0) return @min(stream.window, frame.max_stream_data);
        forwarder.changed.waitUncancelable(io, &forwarder.lock);
    }
}

fn spend(forwarder: *Forwarder, stream: *Stream, bytes: u32) void {
    forwarder.lock.lockUncancelable(forwarder.io);
    defer forwarder.lock.unlock(forwarder.io);
    stream.window -= bytes;
}

/// Carries what the home sends to the port, granting it again as the port takes it, and ends the port's side once the
/// home ended its own.
fn carryInbound(forwarder: *Forwarder, stream: *Stream, socket: Io.net.Stream) void {
    const io = forwarder.io;
    var buffer: [4096]u8 = undefined;
    var writer = socket.writer(io, &buffer);
    var consumed: u32 = 0;
    while (true) {
        var batch = forwarder.awaitInbound(stream) orelse return;
        defer batch.deinit(forwarder.allocator);
        if (batch.items.len == 0) {
            socket.shutdown(io, .send) catch {};
            return;
        }
        writer.interface.writeAll(batch.items) catch return forwarder.failInbound(stream);
        writer.interface.flush() catch return forwarder.failInbound(stream);
        consumed += @intCast(batch.items.len);
        if (consumed >= grant_threshold) {
            forwarder.grant(stream, consumed);
            consumed = 0;
        }
    }
}

fn failInbound(forwarder: *Forwarder, stream: *Stream) void {
    forwarder.lock.lockUncancelable(forwarder.io);
    const reset = stream.reset;
    forwarder.refuse(stream);
    forwarder.lock.unlock(forwarder.io);
    if (!reset) forwarder.sendSignal(.stream_reset, stream.id);
}

/// Waits for what the home sent: the bytes, taken from the stream; empty where the home ended it; null where it was
/// given up.
fn awaitInbound(forwarder: *Forwarder, stream: *Stream) ?std.ArrayList(u8) {
    const io = forwarder.io;
    forwarder.lock.lockUncancelable(io);
    defer forwarder.lock.unlock(io);
    while (true) {
        if (stream.reset) return null;
        if (stream.inbound.items.len > 0) {
            const taken = stream.inbound;
            stream.inbound = .empty;
            return taken;
        }
        if (stream.inbound_ended) return .empty;
        forwarder.changed.waitUncancelable(io, &forwarder.lock);
    }
}

fn grant(forwarder: *Forwarder, stream: *Stream, bytes: u32) void {
    forwarder.lock.lockUncancelable(forwarder.io);
    stream.granted +|= bytes;
    forwarder.lock.unlock(forwarder.io);
    var message: [9]u8 = undefined;
    var writer: Io.Writer = .fixed(&message);
    frame.writeStreamWindow(&writer, stream.id, bytes) catch unreachable;
    forwarder.uplink.send(forwarder.uplink.context, writer.buffered()) catch {};
}

fn sendSignal(forwarder: *Forwarder, kind: frame.Type, id: u32) void {
    var message: [5]u8 = undefined;
    var writer: Io.Writer = .fixed(&message);
    frame.writeStreamSignal(&writer, kind, id) catch unreachable;
    forwarder.uplink.send(forwarder.uplink.context, writer.buffered()) catch {};
}

fn release(forwarder: *Forwarder, stream: *Stream) void {
    forwarder.lock.lockUncancelable(forwarder.io);
    _ = forwarder.streams.remove(stream.id);
    forwarder.lock.unlock(forwarder.io);
    stream.inbound.deinit(forwarder.allocator);
    forwarder.allocator.destroy(stream);
}

const testing = std.testing;

/// A home in a test: the frames the forwarder sent it, kept in order.
const Home = struct {
    lock: Io.Mutex = .init,
    changed: Io.Condition = .init,
    frames: std.ArrayList([]u8) = .empty,

    fn send(context: *anyopaque, bytes: []const u8) anyerror!void {
        const home: *Home = @ptrCast(@alignCast(context));
        home.lock.lockUncancelable(testing.io);
        defer home.lock.unlock(testing.io);
        try home.frames.append(testing.allocator, try testing.allocator.dupe(u8, bytes));
        home.changed.broadcast(testing.io);
    }

    fn deinit(home: *Home) void {
        for (home.frames.items) |bytes| testing.allocator.free(bytes);
        home.frames.deinit(testing.allocator);
    }

    /// What came of stream `id` once it ended: its data gathered, and whether it ended or was given up.
    fn awaitEnd(home: *Home, id: u32, data: *std.ArrayList(u8)) !frame.Type {
        home.lock.lockUncancelable(testing.io);
        defer home.lock.unlock(testing.io);
        var next: usize = 0;
        while (true) {
            while (next < home.frames.items.len) : (next += 1) {
                switch (try frame.decode(home.frames.items[next])) {
                    .stream_data => |each| if (each.id == id) try data.appendSlice(testing.allocator, each.bytes),
                    .stream_end => |ended| if (ended == id) return .stream_end,
                    .stream_reset => |given_up| if (given_up == id) return .stream_reset,
                    else => {},
                }
            }
            home.changed.waitUncancelable(testing.io, &home.lock);
        }
    }
};

/// The routes of a test: "up" to `port`, none other; and what was removed.
const TestRoutes = struct {
    port: u16,
    removed: ?[]const u8 = null,

    fn portOf(context: *anyopaque, name: []const u8) ?u16 {
        const routes: *TestRoutes = @ptrCast(@alignCast(context));
        return if (std.mem.eql(u8, name, "up")) routes.port else null;
    }

    fn remove(context: *anyopaque, name: []const u8) void {
        const routes: *TestRoutes = @ptrCast(@alignCast(context));
        routes.removed = if (std.mem.eql(u8, name, "up")) "up" else null;
    }
};

/// A local app in a test: it reads what one connection sends till its end, and answers with `got:`, that, and `size` bytes more.
const Echo = struct {
    listener: Io.net.Server,
    size: usize,

    fn serve(echo: *Echo) void {
        const io = testing.io;
        const stream = echo.listener.accept(io) catch return;
        defer stream.close(io);
        var read_buffer: [4096]u8 = undefined;
        var reader = stream.reader(io, &read_buffer);
        const received = reader.interface.allocRemaining(testing.allocator, .unlimited) catch return;
        defer testing.allocator.free(received);
        var write_buffer: [4096]u8 = undefined;
        var writer = stream.writer(io, &write_buffer);
        writer.interface.writeAll("got:") catch return;
        writer.interface.writeAll(received) catch return;
        var left = echo.size;
        const block: [8192]u8 = @splat('x');
        while (left > 0) {
            const count = @min(left, block.len);
            writer.interface.writeAll(block[0..count]) catch return;
            left -= count;
        }
        writer.interface.flush() catch return;
    }
};

fn sent(buffer: []u8, comptime write: anytype, args: anytype) []const u8 {
    var writer: Io.Writer = .fixed(buffer);
    @call(.auto, write, .{&writer} ++ args) catch unreachable;
    return writer.buffered();
}

fn forwarderOn(home: *Home, routes: *TestRoutes) Forwarder {
    return .init(testing.allocator, testing.io, .{ .context = home, .send = Home.send }, .{ .context = routes, .portOf = TestRoutes.portOf, .remove = TestRoutes.remove });
}

test "a stream reaches its route's port and carries both ways to the end" {
    const io = testing.io;
    var echo: Echo = .{ .listener = try (try Io.net.IpAddress.parseLiteral("127.0.0.1:0")).listen(io, .{}), .size = 0 };
    defer echo.listener.deinit(io);
    var app = try io.concurrent(Echo.serve, .{&echo});
    defer app.await(io);
    var home: Home = .{};
    defer home.deinit();
    var routes: TestRoutes = .{ .port = echo.listener.socket.address.getPort() };
    var forwarder = forwarderOn(&home, &routes);
    defer forwarder.deinit();
    var buffer: [128]u8 = undefined;
    forwarder.receive(sent(&buffer, frame.writeStreamOpen, .{ 1, "up" }));
    forwarder.receive(sent(&buffer, frame.writeStreamData, .{ 1, "hello" }));
    forwarder.receive(sent(&buffer, frame.writeStreamSignal, .{ .stream_end, 1 }));
    var data: std.ArrayList(u8) = .empty;
    defer data.deinit(testing.allocator);
    try testing.expectEqual(frame.Type.stream_end, try home.awaitEnd(1, &data));
    try testing.expectEqualStrings("got:hello", data.items);
}

test "a stream to no route is given up, and a route is removed as the home asks" {
    var home: Home = .{};
    defer home.deinit();
    var routes: TestRoutes = .{ .port = 1 };
    var forwarder = forwarderOn(&home, &routes);
    defer forwarder.deinit();
    var buffer: [128]u8 = undefined;
    forwarder.receive(sent(&buffer, frame.writeStreamOpen, .{ 2, "none" }));
    var data: std.ArrayList(u8) = .empty;
    defer data.deinit(testing.allocator);
    try testing.expectEqual(frame.Type.stream_reset, try home.awaitEnd(2, &data));
    forwarder.receive(sent(&buffer, frame.writeRouteRemove, .{"up"}));
    try testing.expectEqualStrings("up", routes.removed.?);
}

test "what the port sends stops at the home's window, and goes on as the home grants more" {
    const io = testing.io;
    var echo: Echo = .{ .listener = try (try Io.net.IpAddress.parseLiteral("127.0.0.1:0")).listen(io, .{}), .size = 2 * initial_window };
    defer echo.listener.deinit(io);
    var app = try io.concurrent(Echo.serve, .{&echo});
    defer app.await(io);
    var home: Home = .{};
    defer home.deinit();
    var routes: TestRoutes = .{ .port = echo.listener.socket.address.getPort() };
    var forwarder = forwarderOn(&home, &routes);
    defer forwarder.deinit();
    var buffer: [128]u8 = undefined;
    forwarder.receive(sent(&buffer, frame.writeStreamOpen, .{ 3, "up" }));
    forwarder.receive(sent(&buffer, frame.writeStreamSignal, .{ .stream_end, 3 }));
    // Held at its window, the stream has not all come; given as much again and more, it ends.
    try io.sleep(.fromMilliseconds(200), .awake);
    var before: usize = 0;
    home.lock.lockUncancelable(io);
    for (home.frames.items) |bytes| before += (try frame.decode(bytes)).stream_data.bytes.len;
    home.lock.unlock(io);
    try testing.expect(before <= initial_window);
    forwarder.receive(sent(&buffer, frame.writeStreamWindow, .{ 3, 2 * initial_window }));
    var data: std.ArrayList(u8) = .empty;
    defer data.deinit(testing.allocator);
    try testing.expectEqual(frame.Type.stream_end, try home.awaitEnd(3, &data));
    try testing.expectEqual(4 + 2 * initial_window, data.items.len);
}
