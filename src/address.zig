//! Addresses as the tunnel keeps them, std's, and as picoquic takes and gives them, socket addresses with their ports
//! in network order.
const std = @import("std");
const c = @import("quic");

const IpAddress = std.Io.net.IpAddress;

/// The socket address of `address`.
pub fn toSocket(address: IpAddress) c.struct_sockaddr_storage {
    var storage = std.mem.zeroes(c.struct_sockaddr_storage);
    switch (address) {
        .ip4 => |ip4| {
            const socket: *c.struct_sockaddr_in = @ptrCast(@alignCast(&storage));
            if (@hasField(c.struct_sockaddr_in, "sin_len")) socket.sin_len = @sizeOf(c.struct_sockaddr_in);
            socket.sin_family = @intCast(c.AF_INET);
            socket.sin_port = std.mem.nativeToBig(u16, ip4.port);
            @memcpy(std.mem.asBytes(&socket.sin_addr), &ip4.bytes);
        },
        .ip6 => |ip6| {
            const socket: *c.struct_sockaddr_in6 = @ptrCast(@alignCast(&storage));
            if (@hasField(c.struct_sockaddr_in6, "sin6_len")) socket.sin6_len = @sizeOf(c.struct_sockaddr_in6);
            socket.sin6_family = @intCast(c.AF_INET6);
            socket.sin6_port = std.mem.nativeToBig(u16, ip6.port);
            socket.sin6_flowinfo = std.mem.nativeToBig(u32, ip6.flow);
            @memcpy(std.mem.asBytes(&socket.sin6_addr), &ip6.bytes);
            socket.sin6_scope_id = ip6.interface.index;
        },
    }
    return storage;
}

/// The address `storage` holds; null where it holds no IP address, as picoquic leaves one it does not choose.
pub fn fromSocket(storage: *const c.struct_sockaddr_storage) ?IpAddress {
    const family: c_int = storage.ss_family;
    if (family == c.AF_INET) {
        const socket: *const c.struct_sockaddr_in = @ptrCast(@alignCast(storage));
        return .{ .ip4 = .{ .bytes = std.mem.toBytes(socket.sin_addr), .port = std.mem.bigToNative(u16, socket.sin_port) } };
    }
    if (family == c.AF_INET6) {
        const socket: *const c.struct_sockaddr_in6 = @ptrCast(@alignCast(storage));
        return .{ .ip6 = .{
            .bytes = std.mem.toBytes(socket.sin6_addr),
            .port = std.mem.bigToNative(u16, socket.sin6_port),
            .flow = std.mem.bigToNative(u32, socket.sin6_flowinfo),
            .interface = .{ .index = socket.sin6_scope_id },
        } };
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
    const storage = std.mem.zeroes(c.struct_sockaddr_storage);
    try testing.expectEqual(null, fromSocket(&storage));
}
