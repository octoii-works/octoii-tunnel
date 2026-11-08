//! Peers' links to a relay of the tunnel's own on the loopback: WebSockets opened, the relay's challenge answered by
//! the peers' keys, frames carried each way as from their senders.
const std = @import("std");
const Identity = @import("Identity.zig");
const relay = @import("relay.zig");
const scenario = @import("testing.zig");

const testing = std.testing;
const Io = std.Io;
const Key = Identity.PublicKey;

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
    var running: scenario.RelayRunning = undefined;
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
    var running: scenario.RelayRunning = undefined;
    try running.start();
    defer running.stop();
    const machine = Identity.generate(testing.io);
    const earlier = try running.open(machine.publicKey(), machine);
    defer earlier.close();
    const later = try running.open(machine.publicKey(), machine);
    defer later.close();
    try testing.expectEqual(relay.Link.Received.closed, try earlier.receive());
}

/// Answers one WebSocket handshake with an accept that does not answer its key, and keeps the connection open till the
/// task serving it is canceled, as a broken or hostile server would.
fn answerWrongly(listener: *Io.net.Server) Io.Cancelable!void {
    const io = testing.io;
    const stream = listener.accept(io) catch |err| switch (err) {
        error.Canceled => return error.Canceled,
        else => return,
    };
    defer stream.close(io);
    var read_buffer: [4096]u8 = undefined;
    var write_buffer: [256]u8 = undefined;
    var reader = stream.reader(io, &read_buffer);
    var writer = stream.writer(io, &write_buffer);
    var http: std.http.Server = .init(&reader.interface, &writer.interface);
    _ = http.receiveHead() catch return;
    writer.interface.writeAll("HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: upgrade\r\nsec-websocket-accept: not-the-key's\r\n\r\n") catch return;
    writer.interface.flush() catch return;
    try io.sleep(.fromSeconds(3600), .awake);
}

test "a server that answers the handshake wrongly is refused at once, its connection let go" {
    const io = testing.io;
    var listener = try (try Io.net.IpAddress.parseLiteral("127.0.0.1:0")).listen(io, .{});
    defer listener.deinit(io);
    var serving = try io.concurrent(answerWrongly, .{&listener});
    defer _ = serving.cancel(io) catch {};
    var client: std.http.Client = .{ .allocator = testing.allocator, .io = io };
    defer client.deinit();
    var address: [32]u8 = undefined;
    const relay_address = try std.fmt.bufPrint(&address, "ws://127.0.0.1:{d}", .{listener.socket.address.getPort()});
    const machine = Identity.generate(io);
    try testing.expectError(error.Transport, relay.Link.open(&client, relay_address, machine.publicKey(), machine));
}
