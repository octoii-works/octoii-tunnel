//! Addresses as the tunnel keeps them, std's, and as picoquic takes and gives them, the system's socket addresses with
//! their ports in network order, each laid out as the system lays it out.
const std = @import("std");
const builtin = @import("builtin");
const c = @import("quic");

const IpAddress = std.Io.net.IpAddress;
const on_wasi = builtin.os.tag == .wasi;
const sockaddr = if (on_wasi) wasi.sockaddr else std.c.sockaddr;
const AF = if (on_wasi) wasi.AF else std.c.AF;

/// The socket addresses of the WASI C library, which std does not lay out.
const wasi = struct {
    const AF = struct {
        const INET = c.AF_INET;
        const INET6 = c.AF_INET6;
    };

    const sockaddr = struct {
        const storage = extern struct { family: u16 align(16), data: [32]u8 };
        const in = extern struct { family: u16 align(16) = c.AF_INET, port: u16, addr: u32 };
        const in6 = extern struct { family: u16 align(16) = c.AF_INET6, port: u16, flowinfo: u32, addr: [16]u8, scope_id: u32 };
    };

    comptime {
        if (on_wasi) {
            std.debug.assert(@sizeOf(wasi.sockaddr.storage) == @sizeOf(c.struct_sockaddr_storage));
            std.debug.assert(@sizeOf(wasi.sockaddr.in) == @sizeOf(c.struct_sockaddr_in));
            std.debug.assert(@sizeOf(wasi.sockaddr.in6) == @sizeOf(c.struct_sockaddr_in6));
        }
    }
};

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
    if (socket.family == AF.INET) {
        const in = std.mem.bytesToValue(sockaddr.in, bytes[0..@sizeOf(sockaddr.in)]);
        return .{ .ip4 = .{ .bytes = @bitCast(in.addr), .port = std.mem.bigToNative(u16, in.port) } };
    }
    if (socket.family == AF.INET6) {
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
