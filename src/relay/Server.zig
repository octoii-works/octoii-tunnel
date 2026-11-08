//! A relay of its own over WebSockets, for a host that serves one — a person's machine with an address its peers
//! reach, or a test: each peer's link served on the host's io as a task of its own, the peer admitted by its answer to
//! the relay's challenge, its frames routed by the relay's router to the link of the peer they are for. The router and
//! the links are the server's, under its lock, which a frame is forwarded under, so no link goes while it is written.
const Server = @This();
const std = @import("std");
const Identity = @import("../Identity.zig");
const frame = @import("frame.zig");
const authentication = @import("authentication.zig");
const Router = @import("Router.zig");

const Io = std.Io;
const Key = Identity.PublicKey;

allocator: std.mem.Allocator,
io: Io,
/// The relay's host as its peers reach it, which their answers sign.
host: []const u8,
lock: Io.Mutex = .init,
router: Router = .{},
links: std.AutoHashMapUnmanaged(Router.Link, *Peer) = .empty,
next_link: Router.Link = 1,

/// A peer on the relay: its WebSocket, which other links' tasks write to under the server's lock, and its stream, which
/// the server shuts down to end the link.
const Peer = struct {
    socket: *std.http.Server.WebSocket,
    stream: Io.net.Stream,
};

/// A relay at `host`, its peers' links on `io`.
pub fn init(allocator: std.mem.Allocator, io: Io, host: []const u8) Server {
    return .{ .allocator = allocator, .io = io, .host = host };
}

pub fn deinit(server: *Server) void {
    server.router.deinit(server.allocator);
    server.links.deinit(server.allocator);
}

/// Serves the links `listener` accepts, each in a task of its own, till the task serving them is canceled.
pub fn serve(server: *Server, listener: *Io.net.Server) Io.Cancelable!void {
    var links: Io.Group = .init;
    defer links.cancel(server.io);
    while (true) {
        const stream = listener.accept(server.io) catch |err| switch (err) {
            error.Canceled => return error.Canceled,
            else => continue,
        };
        links.concurrent(server.io, serveLink, .{ server, stream }) catch stream.close(server.io);
    }
}

/// Serves one link: its WebSocket opened, its peer admitted, then its frames routed till it ends.
fn serveLink(server: *Server, stream: Io.net.Stream) void {
    const io = server.io;
    defer stream.close(io);
    const read_buffer = server.allocator.alloc(u8, frame.max_length + 16) catch return;
    defer server.allocator.free(read_buffer);
    var write_buffer: [frame.max_length + 16]u8 = undefined;
    var reader = stream.reader(io, read_buffer);
    var writer = stream.writer(io, &write_buffer);
    var http: std.http.Server = .init(&reader.interface, &writer.interface);
    var request = http.receiveHead() catch return;
    const claimed = keyOf(request.head.target) orelse return request.respond("a peer names its key", .{ .status = .bad_request }) catch {};
    const key = switch (request.upgradeRequested()) {
        .websocket => |key| key orelse return,
        .other, .none => return request.respond("a relay takes WebSockets", .{ .status = .upgrade_required }) catch {},
    };
    var socket = request.respondWebSocket(.{ .key = key }) catch return;
    socket.flush() catch return;
    if (!server.admit(&socket, claimed)) return;
    const link = server.join(claimed, &socket, stream) catch return;
    defer server.leave(claimed, link);
    var welcome: [1]u8 = undefined;
    var welcome_writer: Io.Writer = .fixed(&welcome);
    frame.writeWelcome(&welcome_writer) catch unreachable;
    server.send(link, .binary, welcome_writer.buffered()) catch return;
    while (true) {
        const message = socket.readSmallMessage() catch return;
        switch (message.opcode) {
            .binary => server.route(claimed, link, message.data) catch return,
            .text => if (std.mem.eql(u8, message.data, "ping")) server.send(link, .text, "pong") catch return else return,
            .ping => server.send(link, .pong, message.data) catch return,
            else => return,
        }
    }
}

/// The key a link's address claims: the text after `key=` in its query.
fn keyOf(target: []const u8) ?Key {
    const query = target[(std.mem.indexOfScalar(u8, target, '?') orelse return null) + 1 ..];
    var fields = std.mem.splitScalar(u8, query, '&');
    while (fields.next()) |field| {
        if (std.mem.startsWith(u8, field, "key=")) return Key.parse(field["key=".len..]) catch null;
    }
    return null;
}

/// Sets the link's peer a challenge and checks its answer, for the key it claimed.
fn admit(server: *Server, socket: *std.http.Server.WebSocket, claimed: Key) bool {
    const nonce = authentication.nonce(server.io);
    var buffer: [1 + frame.nonce_length]u8 = undefined;
    var writer: Io.Writer = .fixed(&buffer);
    frame.writeChallenge(&writer, nonce) catch unreachable;
    socket.writeMessage(writer.buffered(), .binary) catch return false;
    const message = socket.readSmallMessage() catch return false;
    if (message.opcode != .binary) return false;
    const answer = switch (frame.decode(message.data) catch return false) {
        .answer => |answer| answer,
        else => return false,
    };
    if (!answer.key.eql(claimed)) return false;
    authentication.check(answer, server.host, nonce) catch return false;
    return true;
}

/// Puts the peer of `key` on the relay by a new link, ending the link it had; the new link.
fn join(server: *Server, key: Key, socket: *std.http.Server.WebSocket, stream: Io.net.Stream) !Router.Link {
    const peer = try server.allocator.create(Peer);
    errdefer server.allocator.destroy(peer);
    peer.* = .{ .socket = socket, .stream = stream };
    server.lock.lockUncancelable(server.io);
    defer server.lock.unlock(server.io);
    const link = server.next_link;
    try server.links.put(server.allocator, link, peer);
    errdefer _ = server.links.remove(link);
    if (try server.router.join(server.allocator, key, link)) |displaced| {
        if (server.links.get(displaced)) |earlier| earlier.stream.shutdown(server.io, .both) catch {};
    }
    server.next_link += 1;
    return link;
}

/// Takes the peer of `key` off the relay, where `link` is still its link, and lets the link go.
fn leave(server: *Server, key: Key, link: Router.Link) void {
    server.lock.lockUncancelable(server.io);
    defer server.lock.unlock(server.io);
    server.router.leave(key, link);
    if (server.links.fetchRemove(link)) |removed| server.allocator.destroy(removed.value);
}

/// Routes a frame the peer of `sender` sent on `link`: to the link of the peer it is for, or back as that peer's being
/// gone; anything else ends the sender's link.
fn route(server: *Server, sender: Key, link: Router.Link, bytes: []u8) !void {
    server.lock.lockUncancelable(server.io);
    defer server.lock.unlock(server.io);
    switch (server.router.route(sender, bytes)) {
        .forward => |forward| if (server.links.get(forward.link)) |peer| {
            peer.socket.writeMessage(forward.bytes, .binary) catch {};
        },
        .gone => |absent| {
            var buffer: [1 + Key.length]u8 = undefined;
            var writer: Io.Writer = .fixed(&buffer);
            frame.writeGone(&writer, absent) catch unreachable;
            try server.links.get(link).?.socket.writeMessage(writer.buffered(), .binary);
        },
        .refused => return error.Refused,
    }
}

/// Writes a message on `link`, under the server's lock.
fn send(server: *Server, link: Router.Link, opcode: std.http.Server.WebSocket.Opcode, bytes: []const u8) !void {
    server.lock.lockUncancelable(server.io);
    defer server.lock.unlock(server.io);
    const peer = server.links.get(link) orelse return error.Gone;
    try peer.socket.writeMessage(bytes, opcode);
}
