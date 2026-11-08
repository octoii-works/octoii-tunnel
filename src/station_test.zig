//! Stations of a machine and of a device on a relay of the tunnel's own on the loopback: each joins the machine's
//! home, the device opens a session to the machine by its key, and a stream carries bytes each way to its end, on the
//! host's io and its clock.
const std = @import("std");
const Identity = @import("Identity.zig");
const Station = @import("Station.zig");
const scenario = @import("testing.zig");

const testing = std.testing;

/// Reads `stream` to its end.
fn readAll(stream: Station.Stream, out: *std.ArrayList(u8)) !void {
    var buffer: [4096]u8 = undefined;
    while (try stream.read(&buffer)) |length| try out.appendSlice(testing.allocator, buffer[0..length]);
}

/// A device's station opens a session through the relay at `address` to a machine's, and a stream carries bytes each
/// way to its end.
fn expectSessionThrough(address: []const u8) !void {
    const machine_identity = Identity.generate(testing.io);
    const device_identity = Identity.generate(testing.io);
    const home = machine_identity.publicKey();
    const machine = try Station.init(testing.allocator, testing.io, machine_identity, .{});
    defer machine.deinit();
    const device = try Station.init(testing.allocator, testing.io, device_identity, .{});
    defer device.deinit();
    _ = try machine.join(address, home);
    const relay = try device.join(address, home);

    const opened = try device.connect(home, relay);
    const accepted = try machine.accept();
    try testing.expect(accepted.peer.eql(device_identity.publicKey()));

    const stream = try device.openStream(opened, .bidirectional);
    try stream.write("hello, machine");
    try stream.shutdown();
    const taken = try machine.acceptStream(accepted, .bidirectional);
    try testing.expectEqual(stream.id, taken.id);
    var asked: std.ArrayList(u8) = .empty;
    defer asked.deinit(testing.allocator);
    try readAll(taken, &asked);
    try testing.expectEqualStrings("hello, machine", asked.items);

    const big = try testing.allocator.alloc(u8, 1024 * 1024);
    defer testing.allocator.free(big);
    for (big, 0..) |*byte, index| byte.* = @intCast(index % 251);
    try taken.write(big);
    try taken.shutdown();
    taken.close(0);
    var answered: std.ArrayList(u8) = .empty;
    defer answered.deinit(testing.allocator);
    try readAll(stream, &answered);
    try testing.expectEqualSlices(u8, big, answered.items);
    stream.close(0);

    device.close(opened, 0);
    machine.close(accepted, 0);
}

test "a device's station opens a session through a relay of the tunnel's own to a machine's, and a stream carries bytes each way" {
    var running: scenario.RelayRunning = undefined;
    try running.start();
    defer running.stop();
    try expectSessionThrough(running.address());
}

test "a device's station opens a session through the relay -Drelay names to a machine's, where one is named" {
    const address = @import("test_options").relay orelse return error.SkipZigTest;
    try expectSessionThrough(address);
}
