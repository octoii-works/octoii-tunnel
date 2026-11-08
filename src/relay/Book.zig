//! An endpoint's book of the peers it reaches through relays: each a relay's number and a peer's key, known to the
//! endpoint by an address of its own in the IPv6 prefix kept for discarding (RFC 6666), so none is ever a host's — a
//! relay's number and the peer's number in it — and the endpoint's own address on a relay the same with no peer.
const Book = @This();
const std = @import("std");
const Identity = @import("../Identity.zig");

const Key = Identity.PublicKey;
const IpAddress = std.Io.net.IpAddress;

/// The port of every address of the book.
const port = 1;

/// The keys of the peers, each at its number less one.
keys: std.ArrayList(Key) = .empty,
/// Each peer's number, by its key.
numbers: std.AutoHashMapUnmanaged([Key.length]u8, u32) = .empty,

/// A peer as an address of the book stands for it: the relay it is reached through, and its key.
pub const Peer = struct {
    relay: u16,
    key: Key,
};

pub fn deinit(book: *Book, allocator: std.mem.Allocator) void {
    book.keys.deinit(allocator);
    book.numbers.deinit(allocator);
}

/// The address that stands for the peer of `key` reached through relay `relay`; the peer numbered the first time.
pub fn addressOf(book: *Book, allocator: std.mem.Allocator, relay: u16, key: Key) !IpAddress {
    const entry = try book.numbers.getOrPut(allocator, key.bytes);
    if (!entry.found_existing) {
        errdefer _ = book.numbers.remove(key.bytes);
        try book.keys.append(allocator, key);
        entry.value_ptr.* = @intCast(book.keys.items.len);
    }
    return addressFor(relay, entry.value_ptr.*);
}

/// The endpoint's own address on relay `relay`: what datagrams through it come to.
pub fn localOf(relay: u16) IpAddress {
    return addressFor(relay, 0);
}

/// The peer `address` stands for; null where it is no address of the book's, or the endpoint's own on a relay.
pub fn peerOf(book: *const Book, address: IpAddress) ?Peer {
    const ip6 = switch (address) {
        .ip6 => |ip6| ip6,
        .ip4 => return null,
    };
    if (!std.mem.eql(u8, ip6.bytes[0..8], &prefix) or ip6.port != port) return null;
    const number = std.mem.readInt(u32, ip6.bytes[10..14], .big);
    if (number == 0 or number > book.keys.items.len) return null;
    return .{ .relay = std.mem.readInt(u16, ip6.bytes[8..10], .big), .key = book.keys.items[number - 1] };
}

/// 0100::/64, kept for discarding.
const prefix = [_]u8{ 0x01, 0x00, 0, 0, 0, 0, 0, 0 };

fn addressFor(relay: u16, number: u32) IpAddress {
    var bytes: [16]u8 = @splat(0);
    bytes[0..8].* = prefix;
    std.mem.writeInt(u16, bytes[8..10], relay, .big);
    std.mem.writeInt(u32, bytes[10..14], number, .big);
    return .{ .ip6 = .{ .bytes = bytes, .port = port } };
}

const testing = std.testing;

test "a peer's address stands for it on its relay, the same each time it is asked" {
    var book: Book = .{};
    defer book.deinit(testing.allocator);
    const machine: Key = .{ .bytes = @splat(1) };
    const address = try book.addressOf(testing.allocator, 3, machine);
    try testing.expect(address.eql(&try book.addressOf(testing.allocator, 3, machine)));
    const peer = book.peerOf(address).?;
    try testing.expectEqual(3, peer.relay);
    try testing.expect(peer.key.eql(machine));
    const elsewhere = try book.addressOf(testing.allocator, 4, machine);
    try testing.expectEqual(4, book.peerOf(elsewhere).?.relay);
}

test "addresses of no peer of the book stand for none" {
    var book: Book = .{};
    defer book.deinit(testing.allocator);
    try testing.expectEqual(null, book.peerOf(localOf(3)));
    try testing.expectEqual(null, book.peerOf(try IpAddress.parseLiteral("[2001:db8::1]:1")));
    try testing.expectEqual(null, book.peerOf(try IpAddress.parseLiteral("10.0.0.1:1")));
    try testing.expectEqual(null, book.peerOf(addressFor(3, 7)));
}
