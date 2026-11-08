//! The host the C libraries — picoquic and picotls — run on while an endpoint calls into them: its allocator takes all
//! they allocate (`allocation.zig`), its io gives their randomness (`crypto.zig`). An endpoint enters its host for each
//! call it makes into them, as they call back only within such calls.
const std = @import("std");

/// What the C libraries run on: the allocator they allocate from and the io they draw randomness from.
pub const Host = struct {
    allocator: std.mem.Allocator,
    io: std.Io,
};

threadlocal var entered: ?*const Host = null;

/// Makes `host` the one the C libraries run on, for the call into them it is entered for; the one it replaces, which
/// `leave` restores.
pub fn enter(host: *const Host) ?*const Host {
    const previous = entered;
    entered = host;
    return previous;
}

/// Restores the host the C libraries ran on before `enter`.
pub fn leave(previous: ?*const Host) void {
    entered = previous;
}

/// The host the C libraries run on now: they reach it only within an endpoint's call into them.
pub fn current() *const Host {
    return entered orelse @panic("the C libraries ran outside an endpoint's call into them");
}

test "a host entered is current till it is left, the one before it current again" {
    const outer: Host = .{ .allocator = std.testing.allocator, .io = std.testing.io };
    const inner: Host = .{ .allocator = std.testing.failing_allocator, .io = std.testing.io };
    const before = enter(&outer);
    defer leave(before);
    try std.testing.expectEqual(&outer, current());
    const nested = enter(&inner);
    try std.testing.expectEqual(&inner, current());
    leave(nested);
    try std.testing.expectEqual(&outer, current());
}
