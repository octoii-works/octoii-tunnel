//! An endpoint: one QUIC context speaking for one identity — the sessions it opens to peers and the ones peers open
//! to it, each peer checked by its key — over the datagrams its host carries. It has no sockets and no clock of its
//! own: the host gives it each datagram that came and the time, takes each datagram it has to send, and calls it again
//! by the time it asks. What happens to its sessions it tells as events, in the order they happened.
const Endpoint = @This();
const std = @import("std");
const c = @import("quic");
const host_ = @import("host.zig");
const allocation = @import("allocation.zig");
const address = @import("address.zig");
const certificate = @import("certificate.zig");
const Identity = @import("Identity.zig");
const Connection = @import("Connection.zig");

const IpAddress = std.Io.net.IpAddress;

/// The protocol the tunnel's sessions speak, as their handshakes name it.
pub const alpn = "octoii";

allocator: std.mem.Allocator,
/// What the C libraries run on during the endpoint's calls into them: its allocator and its io.
host: host_.Host,
identity: Identity,
quic: *c.picoquic_quic_t,
/// The check of each peer's certificate, which picoquic holds for the endpoint's TLS.
verifier: c.ptls_verify_certificate_t,
/// The time of the call in progress, in microseconds, which picoquic's TLS reads.
now: u64,
/// Every session the host has not released.
connections: std.ArrayList(*Connection) = .empty,
/// What happened, not yet told.
events: std.ArrayList(Event) = .empty,
/// How many of `events` were told.
told: usize = 0,

/// What happens to an endpoint's sessions.
pub const Event = union(enum) {
    /// A session a peer opened is ready: its handshake done, the peer's key checked and known.
    accepted: *Connection,
    /// A session this endpoint opened is ready: its handshake done, the peer's key the one expected.
    connected: *Connection,
    /// A stream of a session has bytes to read, or ended.
    readable: Readable,
    /// A session ended — closed by either side, timed out or reset — the last event of its connection, which the host
    /// then releases.
    closed: *Connection,

    pub const Readable = struct { connection: *Connection, stream: u64 };
};

/// How an endpoint holds its sessions.
pub const Options = struct {
    /// The most sessions it holds at once.
    max_connections: u32 = 256,
    /// How long a session may hear nothing from its peer before it ends, in milliseconds.
    idle_timeout: u64 = 30_000,
};

/// A datagram the endpoint has to send: how much of the buffer it was written into it fills, where it goes, and where
/// from, where the endpoint chose.
pub const Datagram = struct {
    length: usize,
    to: IpAddress,
    from: ?IpAddress,
};

/// The signature algorithms the endpoint checks its peers' handshakes by: Ed25519 alone, as identities sign.
const signature_algorithms = [_]u16{ c.PTLS_SIGNATURE_ED25519, std.math.maxInt(u16) };

/// What signs the endpoint's handshakes, which picoquic holds for its TLS and frees with the C library's `free`: its
/// identity's key.
const Signer = extern struct {
    base: c.ptls_sign_certificate_t,
    identity: *const Identity,
};

/// An endpoint speaking for `identity`, its C libraries on `allocator` and `io`, starting at `now`, in microseconds.
pub fn init(allocator: std.mem.Allocator, io: std.Io, identity: Identity, now: u64, options: Options) !*Endpoint {
    const endpoint = try allocator.create(Endpoint);
    errdefer allocator.destroy(endpoint);
    endpoint.* = .{
        .allocator = allocator,
        .host = .{ .allocator = allocator, .io = io },
        .identity = identity,
        .quic = undefined,
        .verifier = .{ .cb = verifyCertificate, .algos = &signature_algorithms },
        .now = now,
    };
    const previous = endpoint.enter(now);
    defer host_.leave(previous);
    c.picoquic_register_crypto_provider(c.octoii_tunnel_crypto_load);
    var reset_seed: [c.PICOQUIC_RESET_SECRET_SIZE]u8 = undefined;
    io.random(&reset_seed);
    var ticket_key: [32]u8 = undefined;
    io.random(&ticket_key);
    defer std.crypto.secureZero(u8, &ticket_key);
    endpoint.quic = c.picoquic_create(options.max_connections, null, null, null, alpn, endpointCallback, endpoint, null, null, &reset_seed, now, &endpoint.now, null, &ticket_key, ticket_key.len) orelse return error.OutOfMemory;
    errdefer c.picoquic_free(endpoint.quic);
    try endpoint.showIdentity();
    c.picoquic_set_verify_certificate_callback(endpoint.quic, &endpoint.verifier, null);
    c.picoquic_set_client_authentication(endpoint.quic, 1);
    c.picoquic_set_default_multipath_option(endpoint.quic, 1);
    c.picoquic_set_default_congestion_algorithm(endpoint.quic, c.picoquic_bbr_algorithm);
    c.picoquic_set_default_idle_timeout(endpoint.quic, options.idle_timeout);
    return endpoint;
}

/// Ends the endpoint: every session it holds ends with it, unannounced to its peers.
pub fn deinit(endpoint: *Endpoint) void {
    const allocator = endpoint.allocator;
    const previous = endpoint.enter(endpoint.now);
    for (endpoint.connections.items) |connection| {
        if (connection.cnx) |cnx| c.picoquic_set_callback(cnx, null, null);
    }
    c.picoquic_free(endpoint.quic);
    host_.leave(previous);
    for (endpoint.connections.items) |connection| connection.destroy();
    endpoint.connections.deinit(allocator);
    endpoint.events.deinit(allocator);
    allocator.destroy(endpoint);
}

/// Gives the endpoint's TLS its identity — the certificate it shows and the signer of its handshakes, both in the C
/// libraries' memory, which picoquic frees with its TLS — so it opens sessions and peers open them to it.
fn showIdentity(endpoint: *Endpoint) !void {
    const shown = try certificate.make(endpoint.identity);
    const bytes = allocation.allocate(shown.len, 16) orelse return error.OutOfMemory;
    @memcpy(bytes[0..shown.len], &shown);
    const chain = allocation.create(c.ptls_iovec_t) orelse {
        allocation.free(bytes);
        return error.OutOfMemory;
    };
    chain.* = .{ .base = bytes, .len = shown.len };
    c.picoquic_set_tls_certificate_chain(endpoint.quic, chain, 1);
    const signer = allocation.create(Signer) orelse return error.OutOfMemory;
    signer.* = .{ .base = .{ .cb = signCertificate }, .identity = &endpoint.identity };
    c.picoquic_set_tls_signer(endpoint.quic, &signer.base);
}

/// Opens a session to the peer known by `peer`, at `to`, at `now`: ready as its `connected` event tells, once the peer
/// showed that key.
pub fn connect(endpoint: *Endpoint, peer: Identity.PublicKey, to: IpAddress, now: u64) !*Connection {
    const previous = endpoint.enter(now);
    defer host_.leave(previous);
    var socket = address.toSocket(to);
    const cnx = c.picoquic_create_cnx(endpoint.quic, c.picoquic_null_connection_id, c.picoquic_null_connection_id, @ptrCast(&socket), now, 0, null, alpn, 1) orelse return error.OutOfMemory;
    errdefer c.picoquic_delete_cnx(cnx);
    try endpoint.connections.ensureUnusedCapacity(endpoint.allocator, 1);
    const connection = try Connection.create(endpoint, cnx, .client, peer);
    errdefer connection.destroy();
    c.picoquic_set_callback(cnx, connectionCallback, connection);
    if (c.picoquic_start_client_cnx(cnx) != 0) return error.ConnectFailed;
    endpoint.connections.appendAssumeCapacity(connection);
    return connection;
}

/// Takes a datagram that came from `from` to `to` at `now`; one the endpoint cannot take, it drops, as a network
/// would.
pub fn receive(endpoint: *Endpoint, datagram: []u8, from: IpAddress, to: IpAddress, now: u64) void {
    const previous = endpoint.enter(now);
    defer host_.leave(previous);
    var from_socket = address.toSocket(from);
    var to_socket = address.toSocket(to);
    _ = c.picoquic_incoming_packet(endpoint.quic, datagram.ptr, datagram.len, @ptrCast(&from_socket), @ptrCast(&to_socket), 0, 0, now);
}

/// Writes into `buffer` the next datagram the endpoint has to send at `now`; null where none is due.
pub fn send(endpoint: *Endpoint, buffer: []u8, now: u64) !?Datagram {
    const previous = endpoint.enter(now);
    defer host_.leave(previous);
    var length: usize = 0;
    var to = std.mem.zeroes(address.Socket);
    var from = std.mem.zeroes(address.Socket);
    var interface: c_int = 0;
    var logged: c.picoquic_connection_id_t = undefined;
    var last: ?*c.picoquic_cnx_t = null;
    if (c.picoquic_prepare_next_packet(endpoint.quic, now, buffer.ptr, buffer.len, &length, @ptrCast(&to), @ptrCast(&from), &interface, &logged, &last) != 0) return error.SendFailed;
    if (length == 0) return null;
    return .{ .length = length, .to = address.fromSocket(&to) orelse return error.SendFailed, .from = address.fromSocket(&from) };
}

/// When the endpoint is next to be called, in microseconds, at the latest.
pub fn wakeTime(endpoint: *Endpoint, now: u64) u64 {
    const previous = endpoint.enter(now);
    defer host_.leave(previous);
    return c.picoquic_get_next_wake_time(endpoint.quic, now);
}

/// The next thing that happened to the endpoint's sessions, in the order they happened; null where all were told.
pub fn nextEvent(endpoint: *Endpoint) ?Event {
    if (endpoint.told == endpoint.events.items.len) {
        endpoint.events.clearRetainingCapacity();
        endpoint.told = 0;
        return null;
    }
    defer endpoint.told += 1;
    return endpoint.events.items[endpoint.told];
}

/// Releases a session its `closed` event told of: what it held is freed, and the connection is no longer to be used.
pub fn release(endpoint: *Endpoint, connection: *Connection) void {
    std.debug.assert(connection.state == .closed);
    const previous = endpoint.enter(endpoint.now);
    defer host_.leave(previous);
    if (connection.cnx) |cnx| {
        c.picoquic_set_callback(cnx, null, null);
        c.picoquic_delete_cnx(cnx);
    }
    const index = std.mem.indexOfScalar(*Connection, endpoint.connections.items, connection).?;
    _ = endpoint.connections.swapRemove(index);
    connection.destroy();
}

/// Makes `now` the time of the call in progress and the endpoint's host the one the C libraries run on; the host it
/// replaces, which `host_.leave` restores.
pub fn enter(endpoint: *Endpoint, now: u64) ?*const host_.Host {
    endpoint.now = now;
    return host_.enter(&endpoint.host);
}

/// Tells `event`, after all that happened before it.
pub fn tell(endpoint: *Endpoint, event: Event) !void {
    try endpoint.events.append(endpoint.allocator, event);
}

/// The session of `cnx`: the one this endpoint opened, or, for one a peer opened, a new one, which the endpoint holds
/// from the peer's certificate on.
fn connectionOf(endpoint: *Endpoint, cnx: *c.picoquic_cnx_t) !*Connection {
    const context = c.picoquic_get_callback_context(cnx);
    if (context != @as(?*anyopaque, endpoint)) return @ptrCast(@alignCast(context.?));
    try endpoint.connections.ensureUnusedCapacity(endpoint.allocator, 1);
    const connection = try Connection.create(endpoint, cnx, .server, undefined);
    endpoint.connections.appendAssumeCapacity(connection);
    c.picoquic_set_callback(cnx, connectionCallback, connection);
    return connection;
}

/// picoquic's calls for a session a peer opened before its certificate came: nothing yet to tell.
fn endpointCallback(cnx: ?*c.picoquic_cnx_t, stream: u64, bytes: [*c]u8, length: usize, event: c.picoquic_call_back_event_t, context: ?*anyopaque, stream_context: ?*anyopaque) callconv(.c) c_int {
    _ = .{ cnx, stream, bytes, length, event, context, stream_context };
    return 0;
}

/// picoquic's calls for a session, handed to its connection; a nonzero answer ends the session.
fn connectionCallback(cnx: ?*c.picoquic_cnx_t, stream: u64, bytes: [*c]u8, length: usize, event: c.picoquic_call_back_event_t, context: ?*anyopaque, stream_context: ?*anyopaque) callconv(.c) c_int {
    _ = .{ cnx, stream_context };
    const connection: *Connection = @ptrCast(@alignCast(context.?));
    const data: []const u8 = if (length == 0) &.{} else bytes[0..length];
    connection.handle(stream, data, event) catch return -1;
    return 0;
}

/// Signs a handshake for the endpoint, by Ed25519 where the peer takes it, as every peer of the tunnel does.
fn signCertificate(self: [*c]c.ptls_sign_certificate_t, tls: ?*c.ptls_t, job: [*c]?*c.ptls_async_job_t, selected: [*c]u16, output: [*c]c.ptls_buffer_t, input: c.ptls_iovec_t, algorithms: [*c]const u16, count: usize) callconv(.c) c_int {
    _ = .{ tls, job };
    const signer: *Signer = @ptrCast(self);
    if (std.mem.indexOfScalar(u16, algorithms[0..count], c.PTLS_SIGNATURE_ED25519) == null) return c.PTLS_ALERT_HANDSHAKE_FAILURE;
    const signature = signer.identity.sign(input.base[0..input.len]) catch return c.PTLS_ERROR_LIBRARY;
    if (c.ptls_buffer__do_pushv(output, &signature, signature.len) != 0) return c.PTLS_ERROR_NO_MEMORY;
    selected.* = c.PTLS_SIGNATURE_ED25519;
    return 0;
}

/// Checks a peer's certificate: its key, the one expected where this endpoint opened the session, kept where the
/// peer did; and gives what checks the peer's signature of the handshake by that key.
fn verifyCertificate(self: [*c]c.ptls_verify_certificate_t, tls: ?*c.ptls_t, server_name: [*c]const u8, verify_sign: [*c]?*const fn (?*anyopaque, u16, c.ptls_iovec_t, c.ptls_iovec_t) callconv(.c) c_int, verify_data: [*c]?*anyopaque, certificates: [*c]c.ptls_iovec_t, count: usize) callconv(.c) c_int {
    _ = server_name;
    const endpoint: *Endpoint = @alignCast(@fieldParentPtr("verifier", @as(*c.ptls_verify_certificate_t, self)));
    if (count == 0) return c.PTLS_ALERT_CERTIFICATE_REQUIRED;
    const peer = certificate.publicKeyOf(certificates[0].base[0..certificates[0].len]) catch return c.PTLS_ALERT_BAD_CERTIFICATE;
    const cnx: *c.picoquic_cnx_t = @ptrCast(c.ptls_get_data_ptr(tls).*.?);
    const connection = endpoint.connectionOf(cnx) catch return c.PTLS_ERROR_NO_MEMORY;
    switch (connection.side) {
        .client => if (!connection.peer.eql(peer)) return c.PTLS_ALERT_BAD_CERTIFICATE,
        .server => connection.peer = peer,
    }
    verify_sign.* = verifySignature;
    verify_data.* = connection;
    return 0;
}

/// Checks the peer's signature of the handshake by the key its certificate holds; called with nothing to check where
/// the handshake failed before it, which leaves nothing to free.
fn verifySignature(data: ?*anyopaque, algorithm: u16, message: c.ptls_iovec_t, signature: c.ptls_iovec_t) callconv(.c) c_int {
    if (message.len == 0 and signature.len == 0) return 0;
    const connection: *Connection = @ptrCast(@alignCast(data.?));
    if (algorithm != c.PTLS_SIGNATURE_ED25519 or signature.len != Identity.signature_length) return c.PTLS_ALERT_DECRYPT_ERROR;
    connection.peer.verify(message.base[0..message.len], signature.base[0..Identity.signature_length].*) catch return c.PTLS_ALERT_DECRYPT_ERROR;
    return 0;
}
