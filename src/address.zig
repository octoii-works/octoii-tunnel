//! Addresses as the tunnel keeps them, std's, and as picoquic takes and gives them, the system's socket addresses with
//! their ports in network order, each laid out as the system lays it out.
const std = @import("std");

const IpAddress = std.Io.net.IpAddress;
const sockaddr = std.c.sockaddr;

/// A socket address of either IP family, as large as any.
pub const Socket = sockaddr.storage;

/// The socket address of `address`.
pub fn toSocket(address: IpAddress) Socket {
    var socket = std.mem.zeroes(Socket);
    switch (address) {
        .ip4 => |ip4| {
            const in: sockaddr.in = .{ .port = std.mem.nativeToBig(u16, ip4.port), .addr = @bitCast(ip4.bytes) };
            @memcpy(std.mem.asBytes(&socket)[0..@sizeOf(sockaddr.in)], std.mem.asBytes(&in));
        },
        .ip6 => |ip6| {
            const in6: sockaddr.in6 = .{ .port = std.mem.nativeToBig(u16, ip6.port), .flowinfo = std.mem.nativeToBig(u32, ip6.flow), .addr = ip6.bytes, .scope_id = ip6.interface.index };
            @memcpy(std.mem.asBytes(&socket)[0..@sizeOf(sockaddr.in6)], std.mem.asBytes(&in6));
        },
    }
    return socket;
}

/// The address `socket` holds; null where it holds no IP address, as picoquic leaves one it does not choose.
pub fn fromSocket(socket: *const Socket) ?IpAddress {
    const bytes = std.mem.asBytes(socket);
    if (socket.family == std.c.AF.INET) {
        const in = std.mem.bytesToValue(sockaddr.in, bytes[0..@sizeOf(sockaddr.in)]);
        return .{ .ip4 = .{ .bytes = @bitCast(in.addr), .port = std.mem.bigToNative(u16, in.port) } };
    }
    if (socket.family == std.c.AF.INET6) {
        const in6 = std.mem.bytesToValue(sockaddr.in6, bytes[0..@sizeOf(sockaddr.in6)]);
        return .{ .ip6 = .{ .bytes = in6.addr, .port = std.mem.bigToNative(u16, in6.port), .flow = std.mem.bigToNative(u32, in6.flowinfo), .interface = .{ .index = in6.scope_id } } };
    }
    return null;
}

const testing = std.testing;

test "an address read back from its socket address is the same address" {
    for ([_][]const u8{ "192.168.1.7:4433", "[2001:db8::1]:7613", "[::1]:1" }) |text| {
        const address = try IpAddress.parseLiteral(text);
        var socket = toSocket(address);
        try testing.expect(address.eql(&fromSocket(&socket).?));
    }
}

test "a socket address holding no IP address gives none" {
    const socket = std.mem.zeroes(Socket);
    try testing.expectEqual(null, fromSocket(&socket));
}
