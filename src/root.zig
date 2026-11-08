//! The tunnel: sessions between a person's devices and their machines, end to end encrypted by their keys, over QUIC.
const std = @import("std");

pub const Identity = @import("Identity.zig");
pub const Endpoint = @import("Endpoint.zig");
pub const Connection = @import("Connection.zig");
pub const relay = @import("relay.zig");
pub const Station = @import("Station.zig");
pub const http3 = @import("http3.zig");

// What the C libraries call — the allocations they make and the crypto they are given — is exported whatever of the
// tunnel a program uses.
comptime {
    _ = @import("allocation.zig");
    _ = @import("crypto.zig");
}

test {
    _ = @import("host.zig");
    _ = @import("allocation.zig");
    _ = @import("crypto.zig");
    _ = @import("Identity.zig");
    _ = @import("certificate.zig");
    _ = @import("address.zig");
    _ = @import("session_test.zig");
    _ = @import("relay_test.zig");
    _ = relay;
    _ = @import("relay_wasm.zig");
    _ = @import("websocket.zig");
    _ = @import("relay_link_test.zig");
    _ = @import("station_test.zig");
    _ = http3;
    _ = @import("http3_session_test.zig");
    _ = @import("http3_test.zig");
}
