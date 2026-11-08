//! A relay's routing: the peers on it, each by its key on the link its host holds, and where a frame a peer sends
//! goes — its datagrams forwarded, unread, to the peer they are for as from their sender, or the sender told that peer
//! is not on the relay. A key that joins again displaces its earlier link.
const Router = @This();
const std = @import("std");
const Identity = @import("../Identity.zig");
const frame = @import("frame.zig");

const Key = Identity.PublicKey;

/// A link as the relay's host knows it.
pub const Link = u64;

peers: std.AutoHashMapUnmanaged([Key.length]u8, Link) = .empty,

/// Where a frame a peer sent goes.
pub const Route = union(enum) {
    /// To `link`, as `bytes`, rewritten in place to name the sender.
    forward: Forward,
    /// Back to the sender: the peer it named is not on the relay.
    gone: Key,
    /// Nowhere: no frame a peer sends, which ends its link.
    refused,

    pub const Forward = struct { link: Link, bytes: []u8 };
};

pub fn deinit(router: *Router, allocator: std.mem.Allocator) void {
    router.peers.deinit(allocator);
}

/// Puts the peer of `key` on the relay by `link`; the link it had, which the host ends, where it had one.
pub fn join(router: *Router, allocator: std.mem.Allocator, key: Key, link: Link) !?Link {
    const entry = try router.peers.getOrPut(allocator, key.bytes);
    const displaced = if (entry.found_existing) entry.value_ptr.* else null;
    entry.value_ptr.* = link;
    return displaced;
}

/// Takes the peer of `key` off the relay, where `link` is still its link.
pub fn leave(router: *Router, key: Key, link: Link) void {
    if (router.peers.get(key.bytes) == link) _ = router.peers.remove(key.bytes);
}

/// The link the peer of `key` is on, where it is on the relay.
pub fn linkOf(router: *const Router, key: Key) ?Link {
    return router.peers.get(key.bytes);
}

/// Where the frame `bytes` that the peer of `sender` sent goes.
pub fn route(router: *const Router, sender: Key, bytes: []u8) Route {
    const addressee = frame.addresseeOf(bytes) orelse return .refused;
    const link = router.linkOf(addressee) orelse return .{ .gone = addressee };
    frame.forwardFrom(bytes, sender);
    return .{ .forward = .{ .link = link, .bytes = bytes } };
}

const testing = std.testing;

fn datagramsTo(buffer: []u8, key: Key, datagram: []const u8) ![]u8 {
    var writer: std.Io.Writer = .fixed(buffer);
    _ = try frame.writeDatagrams(&writer, key, &.{datagram});
    return writer.buffered();
}

test "a peer's datagrams go to the peer they are for, as from their sender" {
    var router: Router = .{};
    defer router.deinit(testing.allocator);
    const machine: Key = .{ .bytes = @splat(1) };
    const device: Key = .{ .bytes = @splat(2) };
    try testing.expectEqual(null, try router.join(testing.allocator, machine, 10));
    try testing.expectEqual(null, try router.join(testing.allocator, device, 20));
    var buffer: [64]u8 = undefined;
    const routed = router.route(device, try datagramsTo(&buffer, machine, "hello"));
    try testing.expectEqual(10, routed.forward.link);
    const forwarded = try frame.decode(routed.forward.bytes);
    try testing.expect(forwarded.datagrams.key.eql(device));
}

test "datagrams for a peer not on the relay come back as its being gone" {
    var router: Router = .{};
    defer router.deinit(testing.allocator);
    var buffer: [64]u8 = undefined;
    const absent: Key = .{ .bytes = @splat(9) };
    try testing.expect(router.route(.{ .bytes = @splat(2) }, try datagramsTo(&buffer, absent, "hello")).gone.eql(absent));
}

test "a key that joins again displaces its link, and leaving by the displaced link leaves the new one" {
    var router: Router = .{};
    defer router.deinit(testing.allocator);
    const machine: Key = .{ .bytes = @splat(1) };
    _ = try router.join(testing.allocator, machine, 10);
    try testing.expectEqual(10, try router.join(testing.allocator, machine, 11));
    router.leave(machine, 10);
    try testing.expectEqual(11, router.linkOf(machine));
    router.leave(machine, 11);
    try testing.expectEqual(null, router.linkOf(machine));
}

test "what a peer may not send ends its link" {
    var router: Router = .{};
    defer router.deinit(testing.allocator);
    var buffer: [8]u8 = .{ @backingInt(frame.Type.welcome), 0, 0, 0, 0, 0, 0, 0 };
    try testing.expectEqual(Route.refused, router.route(.{ .bytes = @splat(2) }, buffer[0..1]));
    try testing.expectEqual(Route.refused, router.route(.{ .bytes = @splat(2) }, buffer[1..3]));
}
