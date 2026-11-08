//! HTTP/3 between a machine's station and a device's, through a relay of the tunnel's own on the loopback: requests
//! answered whole, a body echoed, and a WebSocket an extended CONNECT opens carrying messages each way.
const std = @import("std");
const Identity = @import("Identity.zig");
const Station = @import("Station.zig");
const http3 = @import("http3.zig");
const scenario = @import("testing.zig");

const testing = std.testing;
const Io = std.Io;

/// Serves a session's requests till it ends, each in a task of its own.
fn serve(server: http3.Server) Io.Cancelable!void {
    var requests: Io.Group = .init;
    defer requests.cancel(testing.io);
    while (true) {
        const request = server.accept() catch |err| switch (err) {
            error.Canceled => return error.Canceled,
            else => return,
        };
        requests.concurrent(testing.io, answer, .{request}) catch request.deinit();
    }
}

/// Answers a request: `/hello` with a greeting, `/echo` with its body, a WebSocket with each message it sends.
fn answer(request: *http3.Server.Request) void {
    defer request.deinit();
    request.receiveHead() catch return;
    if (request.webSocketRequested()) return echoMessages(request);
    if (std.mem.eql(u8, request.head.target, "/hello"))
        return request.respond("hello, device", .{ .extra_headers = &.{.{ .name = "content-type", .value = "text/plain" }} }) catch {};
    if (std.mem.eql(u8, request.head.target, "/echo")) {
        var buffer: [4096]u8 = undefined;
        const body = request.reader(&buffer).allocRemaining(testing.allocator, .limited(1 << 20)) catch return;
        defer testing.allocator.free(body);
        return request.respond(body, .{}) catch {};
    }
    request.respond("", .{ .status = .not_found }) catch {};
}

fn echoMessages(request: *http3.Server.Request) void {
    defer request.hangUp();
    var buffer: [64 * 1024]u8 = undefined;
    var socket = request.respondWebSocket(.{ .buffer = &buffer }) catch return;
    while (true) {
        const received = socket.readSmallMessage() catch return;
        socket.writeMessage(received.data, received.opcode) catch return;
    }
}

/// The body of a request's response, read whole.
fn bodyOf(request: *http3.Client.Request) ![]u8 {
    var buffer: [4096]u8 = undefined;
    return request.reader(&buffer).allocRemaining(testing.allocator, .limited(1 << 20));
}

test "a device asks a machine over HTTP/3 through a relay: answers whole, a body echoed, a WebSocket's messages each way" {
    var running: scenario.RelayRunning = undefined;
    try running.start();
    defer running.stop();
    const machine_identity = Identity.generate(testing.io);
    const home = machine_identity.publicKey();
    const machine = try Station.init(testing.allocator, testing.io, machine_identity, .{});
    defer machine.deinit();
    const device = try Station.init(testing.allocator, testing.io, Identity.generate(testing.io), .{});
    defer device.deinit();
    _ = try machine.join(running.address(), home);
    const opened = try device.connect(home, try device.join(running.address(), home));
    defer device.close(opened, @backingInt(http3.Code.no_error));
    const accepted = try machine.accept();
    defer machine.close(accepted, @backingInt(http3.Code.no_error));

    const server: http3.Server = try .init(testing.allocator, machine, accepted);
    defer server.deinit();
    var serving = try testing.io.concurrent(serve, .{server});
    defer _ = serving.cancel(testing.io) catch {};
    const client: http3.Client = try .init(testing.allocator, device, opened);
    defer client.deinit();

    const hello = try client.request(.GET, "/hello", .{ .authority = "machine" });
    defer hello.deinit();
    try hello.finish();
    try hello.receiveHead();
    try testing.expectEqual(std.http.Status.ok, hello.head.status);
    var fields = hello.head.iterateHeaders();
    try testing.expectEqualStrings("content-length", fields.next().?.name);
    try testing.expectEqualStrings("text/plain", fields.next().?.value);
    const greeting = try bodyOf(hello);
    defer testing.allocator.free(greeting);
    try testing.expectEqualStrings("hello, device", greeting);

    const sent = try testing.allocator.alloc(u8, 200 * 1024);
    defer testing.allocator.free(sent);
    for (sent, 0..) |*byte, index| byte.* = @intCast(index % 251);
    const echo = try client.request(.POST, "/echo", .{ .authority = "machine" });
    defer echo.deinit();
    try echo.writer().writeAll(sent);
    try echo.finish();
    try echo.receiveHead();
    const echoed = try bodyOf(echo);
    defer testing.allocator.free(echoed);
    try testing.expectEqualSlices(u8, sent, echoed);

    const missing = try client.request(.GET, "/nowhere", .{ .authority = "machine" });
    defer missing.deinit();
    try missing.finish();
    try missing.receiveHead();
    try testing.expectEqual(std.http.Status.not_found, missing.head.status);

    var messages: [64 * 1024]u8 = undefined;
    const socket = try client.openWebSocket("/ws", .{ .authority = "machine", .buffer = &messages });
    defer socket.close();
    try socket.send(.text, "are you there?");
    try testing.expectEqualStrings("are you there?", (try socket.receive()).text);
    try socket.send(.binary, sent[0 .. 40 * 1024]);
    try testing.expectEqualSlices(u8, sent[0 .. 40 * 1024], (try socket.receive()).binary);
}
