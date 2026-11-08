//! Peers' links to a relay of the tunnel's own on the loopback: WebSockets opened, the relay's challenge answered by
//! the peers' keys, frames carried each way as from their senders.
const std = @import("std");
const Identity = @import("Identity.zig");
const relay = @import("relay.zig");

const testing = std.testing;
const Io = std.Io;
const Key = Identity.PublicKey;

/// A relay serving on the loopback, a task of its own, and an HTTP client for peers' links to it.
const Running = struct {
    listener: Io.net.Server,
    server: relay.Server,
    serving: Io.Future(Io.Cancelable!void),
    client: std.http.Client,
    address: [32]u8,
    address_length: usize,

    fn start(running: *Running) !void {
        const io = testing.io;
        running.listener = try (try Io.net.IpAddress.parseLiteral("127.0.0.1:0")).listen(io, .{});
        running.server = .init(testing.allocator, io, "127.0.0.1");
        running.serving = try io.concurrent(relay.Server.serve, .{ &running.server, &running.listener });
        running.client = .{ .allocator = testing.allocator, .io = io };
        running.address_length = (try std.fmt.bufPrint(&running.address, "ws://127.0.0.1:{d}", .{running.listener.socket.address.getPort()})).len;
    }

    fn stop(running: *Running) void {
        const io = testing.io;
        running.client.deinit();
        _ = running.serving.cancel(io) catch {};
        running.server.deinit();
        running.listener.deinit(io);
    }

    fn open(running: *Running, home: Key, identity: Identity) relay.Link.Error!*relay.Link {
        return relay.Link.open(&running.client, running.address[0..running.address_length], home, identity);
    }
};

fn sendDatagrams(link: *relay.Link, to: Key, datagram: []const u8) !void {
    var buffer: [256]u8 = undefined;
    var writer: Io.Writer = .fixed(&buffer);
    _ = try relay.frame.writeDatagrams(&writer, to, &.{datagram});
    try link.send(writer.buffered());
}

fn receiveFrame(link: *relay.Link) !relay.frame.Frame {
    return switch (try link.receive()) {
        .frame => |bytes| try relay.frame.decode(bytes),
        .pong, .closed => error.NoFrame,
    };
}

test "two peers' links to a relay carry each other's datagrams as from their senders, and a ping" {
    var running: Running = undefined;
    try running.start();
    defer running.stop();
    const machine = Identity.generate(testing.io);
    const device = Identity.generate(testing.io);
    const home = machine.publicKey();
    const machine_link = try running.open(home, machine);
    defer machine_link.close();
    const device_link = try running.open(home, device);
    defer device_link.close();

    try sendDatagrams(device_link, machine.publicKey(), "hello, machine");
    const asked = (try receiveFrame(machine_link)).datagrams;
    try testing.expect(asked.key.eql(device.publicKey()));
    var datagrams = asked.iterator();
    try testing.expectEqualStrings("hello, machine", datagrams.next().?);

    try sendDatagrams(machine_link, device.publicKey(), "hello, device");
    const answered = (try receiveFrame(device_link)).datagrams;
    try testing.expect(answered.key.eql(machine.publicKey()));

    const absent = Identity.generate(testing.io).publicKey();
    try sendDatagrams(device_link, absent, "anyone?");
    try testing.expect((try receiveFrame(device_link)).gone.eql(absent));

    try device_link.ping();
    try testing.expectEqual(relay.Link.Received.pong, try device_link.receive());
}

test "a key joining a relay again displaces its earlier link" {
    var running: Running = undefined;
    try running.start();
    defer running.stop();
    const machine = Identity.generate(testing.io);
    const earlier = try running.open(machine.publicKey(), machine);
    defer earlier.close();
    const later = try running.open(machine.publicKey(), machine);
    defer later.close();
    try testing.expectEqual(relay.Link.Received.closed, try earlier.receive());
}
