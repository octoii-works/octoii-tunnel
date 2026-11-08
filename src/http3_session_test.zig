//! HTTP/3 sessions stepped by their drivers alone, as a page's one thread steps one: two endpoints on a link in
//! memory, each side's session called as the link runs — a request and its body answered, an interim response passed
//! over, each side's settings known to the other, and a frame where none may be ending the session with its code.
const std = @import("std");
const Endpoint = @import("Endpoint.zig");
const Connection = @import("Connection.zig");
const Identity = @import("Identity.zig");
const http3 = @import("http3.zig");
const scenario = @import("testing.zig");

const testing = std.testing;
const Session = http3.Session;
const Link = scenario.Link;

/// Two endpoints on a link, with a session between them.
const Pair = struct {
    client: *Endpoint,
    server: *Endpoint,
    link: Link,
    watched: scenario.Watched = .{},
    opened: *Connection,
    accepted: *Connection,

    fn open(pair: *Pair) !void {
        const server_identity = Identity.generate(testing.io);
        pair.client = try Endpoint.init(testing.allocator, testing.io, Identity.generate(testing.io), scenario.start, .{});
        errdefer pair.client.deinit();
        pair.server = try Endpoint.init(testing.allocator, testing.io, server_identity, scenario.start, .{});
        errdefer pair.server.deinit();
        pair.link = try scenario.linkOf(pair.client, pair.server, scenario.start);
        pair.watched = .{};
        pair.opened = try pair.client.connect(server_identity.publicKey(), pair.link.server.at, pair.link.now);
        try pair.link.runUntil(&pair.watched, scenario.bothReady);
        pair.accepted = pair.watched.server.connectionOf(.accepted);
    }

    fn close(pair: *Pair) !void {
        if (pair.opened.state != .closed) pair.opened.close(@backingInt(http3.Code.no_error));
        try pair.link.runUntil(&pair.watched, scenario.bothClosed);
        pair.client.release(pair.opened);
        pair.server.release(pair.watched.server.connectionOf(.closed));
        pair.watched.deinit();
        pair.link.deinit();
        pair.server.deinit();
        pair.client.deinit();
    }
};

/// The server's side: the request it took once its head came, and the body it read.
const Serving = struct {
    session: *Session,
    request: ?u64 = null,
    body: std.ArrayList(u8) = .empty,
    ended: bool = false,
};

fn requestRead(serving: *Serving, link: *Link) bool {
    _ = link;
    serving.session.poll() catch return true;
    const request = serving.request orelse serving.session.takeRequest() orelse return false;
    serving.request = request;
    var buffer: [1024]u8 = undefined;
    while (serving.session.readBody(request, &buffer) catch return true) |length| {
        if (length == 0) return false;
        serving.body.appendSlice(testing.allocator, buffer[0..length]) catch return true;
    }
    serving.ended = true;
    return true;
}

/// The client's side: the request it sent, and the response's body it read.
const Asking = struct {
    session: *Session,
    request: u64,
    body: std.ArrayList(u8) = .empty,
    ended: bool = false,
};

fn responseRead(asking: *Asking, link: *Link) bool {
    _ = link;
    asking.session.poll() catch return true;
    _ = (asking.session.head(asking.request) catch return true) orelse return false;
    var buffer: [1024]u8 = undefined;
    while (asking.session.readBody(asking.request, &buffer) catch return true) |length| {
        if (length == 0) return false;
        asking.body.appendSlice(testing.allocator, buffer[0..length]) catch return true;
    }
    asking.ended = true;
    return true;
}

fn settled(sessions: *const [2]*Session, link: *Link) bool {
    _ = link;
    for (sessions) |session| session.poll() catch return true;
    return sessions[0].peer_settings != null and sessions[1].peer_settings != null;
}

test "a request and its body are answered by sessions their drivers step, an interim response passed over" {
    var pair: Pair = undefined;
    try pair.open();
    var client = try Session.init(testing.allocator, pair.opened);
    defer client.deinit();
    var server = try Session.init(testing.allocator, pair.accepted);
    defer server.deinit();

    const request = try client.openRequest();
    try testing.expect(try client.sendHead(request, &.{&.{
        .{ .name = ":method", .value = "POST" },
        .{ .name = ":scheme", .value = "https" },
        .{ .name = ":authority", .value = "machine" },
        .{ .name = ":path", .value = "/echo" },
    }}));
    try testing.expectEqual(13, try client.writeBody(request, "hello, server"));
    try client.finish(request);

    var serving: Serving = .{ .session = &server };
    defer serving.body.deinit(testing.allocator);
    try pair.link.runUntil(&serving, requestRead);
    try testing.expect(serving.ended);
    try testing.expectEqualStrings("hello, server", serving.body.items);
    const asked = try http3.message.requestHeadOf((try server.head(serving.request.?)).?);
    try testing.expectEqual(std.http.Method.POST, asked.method);
    try testing.expectEqualStrings("/echo", asked.target);

    const answered = serving.request.?;
    try testing.expect(try server.sendHead(answered, &.{&.{.{ .name = ":status", .value = "103" }}}));
    try testing.expect(try server.sendHead(answered, &.{&.{ .{ .name = ":status", .value = "200" }, .{ .name = "content-type", .value = "text/plain" } }}));
    try testing.expectEqual(13, try server.writeBody(answered, "hello, client"));
    try server.finish(answered);

    var asking: Asking = .{ .session = &client, .request = request };
    defer asking.body.deinit(testing.allocator);
    try pair.link.runUntil(&asking, responseRead);
    try testing.expect(asking.ended);
    try testing.expectEqualStrings("hello, client", asking.body.items);
    try testing.expectEqual(std.http.Status.ok, (try http3.message.responseHeadOf((try client.head(request)).?)).status);

    const sessions = [2]*Session{ &client, &server };
    try pair.link.runUntil(&sessions, settled);
    try testing.expect(client.peer_settings.?.enable_connect_protocol);
    try testing.expect(!server.peer_settings.?.enable_connect_protocol);

    client.closeStream(request);
    server.closeStream(answered);
    try pair.close();
}

fn serverPolled(server: *Session, link: *Link) bool {
    _ = link;
    server.poll() catch return true;
    return server.connection.state == .closed;
}

test "a DATA frame before a request's head ends the session with the code that tells it" {
    var pair: Pair = undefined;
    try pair.open();
    var client = try Session.init(testing.allocator, pair.opened);
    defer client.deinit();
    var server = try Session.init(testing.allocator, pair.accepted);
    defer server.deinit();

    const request = try client.openRequest();
    _ = try client.writeBody(request, "too soon");
    try pair.link.runUntil(&server, serverPolled);
    try pair.link.runUntil(&pair.watched, scenario.clientClosed);
    try testing.expectEqual(@backingInt(http3.Code.frame_unexpected), pair.opened.peer_code.?);
    try testing.expectError(error.Closed, client.poll());
    try pair.close();
}
