//! The C libraries' allocations — each call picoquic and picotls make of malloc, calloc, realloc, free, posix_memalign
//! and strdup, which their compilation hands to the functions here — on the allocator of the host they run on, so the
//! host's allocator holds all they allocate and a test's finds what they leak. Each allocation keeps the allocator it
//! came from ahead of it, so it is freed there whichever host the C libraries run on when they free it.
const std = @import("std");
const host = @import("host.zig");

/// The alignment of every allocation, as the C library's malloc gives it: enough for any of C's types.
const alignment: std.mem.Alignment = .@"16";

/// What precedes an allocation: the block it lies in and the allocator that gave it.
const Header = struct {
    block: []u8,
    allocator: std.mem.Allocator,
};

/// The room taken ahead of each allocation for its header, which keeps the allocation aligned.
const header_room = std.mem.alignForward(usize, @sizeOf(Header), alignment.toByteUnits());

/// Allocates `size` bytes at `align_bytes`, a power of two of at least the C library's alignment, from the current
/// host's allocator; null where the allocator has no room.
pub fn allocate(size: usize, align_bytes: usize) ?[*]u8 {
    const allocator = host.current().allocator;
    const length = std.math.add(usize, size, header_room + align_bytes - alignment.toByteUnits()) catch return null;
    const block = allocator.rawAlloc(length, alignment, @returnAddress()) orelse return null;
    const start = std.mem.alignForward(usize, @intFromPtr(block) + header_room, align_bytes);
    headerOf(@ptrFromInt(start)).* = .{ .block = block[0..length], .allocator = allocator };
    return @ptrFromInt(start);
}

/// Frees an allocation of `allocate`, on the allocator it came from.
pub fn free(memory: [*]u8) void {
    const header = headerOf(memory).*;
    header.allocator.rawFree(header.block, alignment, @returnAddress());
}

/// Makes room for a `T` the C libraries hold, freed by `destroy` or by their own `free`.
pub fn create(comptime T: type) ?*T {
    comptime std.debug.assert(@alignOf(T) <= alignment.toByteUnits());
    return @ptrCast(@alignCast(allocate(@sizeOf(T), alignment.toByteUnits()) orelse return null));
}

/// Frees what `create` made.
pub fn destroy(value: anytype) void {
    free(@ptrCast(value));
}

/// The bytes of an allocation of `allocate`, as many as were asked for and more where its block has room past them.
fn sizeOf(memory: [*]u8) usize {
    const block = headerOf(memory).block;
    return @intFromPtr(block.ptr) + block.len - @intFromPtr(memory);
}

fn headerOf(memory: [*]u8) *Header {
    return @ptrFromInt(@intFromPtr(memory) - header_room);
}

export fn octoii_tunnel_malloc(size: usize) ?*anyopaque {
    return allocate(size, alignment.toByteUnits());
}

export fn octoii_tunnel_calloc(count: usize, size: usize) ?*anyopaque {
    const length = std.math.mul(usize, count, size) catch return null;
    const memory = allocate(length, alignment.toByteUnits()) orelse return null;
    @memset(memory[0..length], 0);
    return memory;
}

export fn octoii_tunnel_realloc(pointer: ?*anyopaque, size: usize) ?*anyopaque {
    const old: [*]u8 = @ptrCast(pointer orelse return allocate(size, alignment.toByteUnits()));
    const new = allocate(size, alignment.toByteUnits()) orelse return null;
    const kept = @min(sizeOf(old), size);
    @memcpy(new[0..kept], old[0..kept]);
    free(old);
    return new;
}

export fn octoii_tunnel_free(pointer: ?*anyopaque) void {
    free(@ptrCast(pointer orelse return));
}

export fn octoii_tunnel_posix_memalign(out: *?*anyopaque, align_bytes: usize, size: usize) c_int {
    if (!std.math.isPowerOfTwo(align_bytes) or align_bytes < @sizeOf(*anyopaque)) return @backingInt(std.c.E.INVAL);
    out.* = allocate(size, @max(align_bytes, alignment.toByteUnits())) orelse return @backingInt(std.c.E.NOMEM);
    return 0;
}

export fn octoii_tunnel_aligned_malloc(size: usize, align_bytes: usize) ?*anyopaque {
    if (!std.math.isPowerOfTwo(align_bytes)) return null;
    return allocate(size, @max(align_bytes, alignment.toByteUnits()));
}

export fn octoii_tunnel_strdup(text: [*:0]const u8) ?[*:0]u8 {
    const length = std.mem.len(text) + 1;
    const copy = allocate(length, alignment.toByteUnits()) orelse return null;
    @memcpy(copy[0..length], text[0..length]);
    return @ptrCast(copy);
}

const testing = std.testing;

fn enterTesting() ?*const host.Host {
    const State = struct {
        var testing_host: host.Host = undefined;
    };
    State.testing_host = .{ .allocator = testing.allocator, .io = testing.io };
    return host.enter(&State.testing_host);
}

test "the C library's allocations come from the host's allocator, each freed where it came from" {
    const before = enterTesting();
    defer host.leave(before);
    const memory: [*]u8 = @ptrCast(octoii_tunnel_malloc(100).?);
    try testing.expect(std.mem.isAligned(@intFromPtr(memory), 16));
    @memset(memory[0..100], 0xab);
    const grown: [*]u8 = @ptrCast(octoii_tunnel_realloc(memory, 300).?);
    try testing.expectEqualSlices(u8, &(@as([100]u8, @splat(0xab))), grown[0..100]);
    const zeroed: [*]u8 = @ptrCast(octoii_tunnel_calloc(4, 25).?);
    try testing.expectEqualSlices(u8, &(@as([100]u8, @splat(0))), zeroed[0..100]);
    const copy = octoii_tunnel_strdup("octoii").?;
    try testing.expectEqualStrings("octoii", std.mem.span(copy));
    octoii_tunnel_free(copy);
    octoii_tunnel_free(zeroed);
    octoii_tunnel_free(grown);
    octoii_tunnel_free(null);
}

test "an aligned allocation keeps its alignment and frees as any other" {
    const before = enterTesting();
    defer host.leave(before);
    var memory: ?*anyopaque = null;
    try testing.expectEqual(0, octoii_tunnel_posix_memalign(&memory, 64, 1000));
    try testing.expect(std.mem.isAligned(@intFromPtr(memory.?), 64));
    octoii_tunnel_free(memory);
    try testing.expectEqual(@backingInt(std.c.E.INVAL), octoii_tunnel_posix_memalign(&memory, 24, 10));
}

test "an allocation the host's allocator has no room for is null" {
    var failing: host.Host = .{ .allocator = testing.failing_allocator, .io = testing.io };
    const before = host.enter(&failing);
    defer host.leave(before);
    try testing.expectEqual(null, octoii_tunnel_malloc(10));
    try testing.expectEqual(null, octoii_tunnel_calloc(std.math.maxInt(usize), 2));
}
