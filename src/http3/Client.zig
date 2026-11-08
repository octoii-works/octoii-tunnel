//! The client's side of an HTTP/3 session: requests sent, each on a stream of its own, their bodies written and their
//! responses read; and WebSockets opened by the extended CONNECT of RFC 9220, once the server's settings take one, the
//! client's messages masked as RFC 6455 has a client mask them.
const Client = @This();
const std = @import("std");
const Station = @import("../Station.zig");
const Connection = @import("../Connection.zig");
const websocket = @import("../websocket.zig");
const Session = @import("Session.zig");
const Exchange = @import("Exchange.zig");
const message = @import("message.zig");
const code = @import("code.zig");

const Io = std.Io;
const Field = std.http.Header;

session: *Session,

/// The client's side of an HTTP/3 session on `connection`, a session `station` opened.
pub fn init(allocator: std.mem.Allocator, station: *Station, connection: *Connection) !Client {
    std.debug.assert(connection.side == .client);
    return .{ .session = try Session.init(allocator, station, connection) };
}

/// Stops the session's tasks; the station's session stays its holder's to close.
pub fn deinit(client: Client) void {
    client.session.deinit();
}

/// How a request is sent.
pub const RequestOptions = struct {
    /// The server's name, as the request names it.
    authority: []const u8,
    extra_headers: []const Field = &.{},
};

/// Sends the head of a request of `method` for `target`: the request, its body to write, then its response to read.
pub fn request(client: Client, method: std.http.Method, target: []const u8, options: RequestOptions) Session.Error!*Request {
    return client.send(&.{
        .{ .name = ":method", .value = @tagName(method) },
        .{ .name = ":scheme", .value = "https" },
        .{ .name = ":authority", .value = options.authority },
        .{ .name = ":path", .value = target },
    }, options.extra_headers);
}

/// Sends a request whose head holds `pseudo`, then `extra_headers`, on a stream of its own.
fn send(client: Client, pseudo: []const Field, extra_headers: []const Field) Session.Error!*Request {
    const session = client.session;
    const stream = try session.station.openStream(session.connection, .bidirectional);
    const sent = session.allocator.create(Request) catch |err| {
        stream.close(@backingInt(code.Code.internal_error));
        return err;
    };
    sent.head = undefined;
    sent.exchange.init(session, stream);
    errdefer sent.deinit();
    try sent.exchange.sendHead(&.{ pseudo, extra_headers });
    return sent;
}

/// A request sent, its body written, its response read.
pub const Request = struct {
    exchange: Exchange,
    /// The response's head, once `receiveHead` read it.
    head: message.ResponseHead,

    /// The writer of the request's body.
    pub fn writer(sent: *Request) *Io.Writer {
        return sent.exchange.bodyWriter();
    }

    /// Sends what was written of the request's body, and its end.
    pub fn finish(sent: *Request) Session.Error!void {
        try sent.exchange.finish();
    }

    /// Reads the response's head, once it has come, each interim response's passed over.
    pub fn receiveHead(sent: *Request) Session.Error!void {
        while (true) {
            const section = try sent.exchange.receiveHead();
            sent.head = message.responseHeadOf(section) catch return sent.exchange.failed(error.MalformedMessage);
            if (@backingInt(sent.head.status) >= 200) return;
            sent.exchange.phase = .head;
        }
    }

    /// A reader of the response's body, read into `buffer`.
    pub fn reader(sent: *Request, buffer: []u8) *Io.Reader {
        return sent.exchange.bodyReader(buffer);
    }

    /// Lets the request go: its stream closed, what it held freed.
    pub fn deinit(sent: *Request) void {
        const allocator = sent.exchange.session.allocator;
        sent.exchange.deinit();
        allocator.destroy(sent);
    }
};

/// How a WebSocket is opened.
pub const WebSocketOptions = struct {
    authority: []const u8,
    /// What the server's messages are read into: the longest it may send.
    buffer: []u8,
    extra_headers: []const Field = &.{},
};

/// Opens a WebSocket at `target`: once the server's settings take an extended CONNECT, its request sent, and the
/// socket on the request's stream once the server accepts it; `Refused` where its settings or its response do not.
pub fn openWebSocket(client: Client, target: []const u8, options: WebSocketOptions) Session.Error!*WebSocket {
    if (!(try client.session.awaitSettings()).enable_connect_protocol) return error.Refused;
    const sent = try client.send(&.{
        .{ .name = ":method", .value = "CONNECT" },
        .{ .name = ":protocol", .value = "websocket" },
        .{ .name = ":scheme", .value = "https" },
        .{ .name = ":authority", .value = options.authority },
        .{ .name = ":path", .value = target },
        .{ .name = "sec-websocket-version", .value = "13" },
    }, options.extra_headers);
    errdefer sent.deinit();
    try sent.exchange.flush();
    try sent.receiveHead();
    if (sent.head.status.class() != .success) return error.Refused;
    const socket = try client.session.allocator.create(WebSocket);
    socket.* = .{ .request = sent, .input = undefined, .messages = options.buffer };
    socket.input = sent.reader(&socket.read_buffer);
    return socket;
}

/// A WebSocket the client opened: its messages written masked as DATA frames of its request, the server's read as they
/// come, each into the socket's buffer of messages.
pub const WebSocket = struct {
    request: *Request,
    input: *Io.Reader,
    messages: []u8,
    reading: websocket.Reading = .{},
    read_buffer: [4096]u8 = undefined,

    /// Sends one message, whole.
    pub fn send(socket: *WebSocket, opcode: websocket.Opcode, payload: []const u8) Session.Error!void {
        var mask: [4]u8 = undefined;
        socket.request.exchange.session.station.io.random(&mask);
        const exchange = &socket.request.exchange;
        websocket.writeFrame(exchange.bodyWriter(), opcode, payload, mask) catch return exchange.err.?;
        try exchange.flush();
    }

    /// The next message the server sends, its bytes in the socket's buffer till the next; the server's pings answered
    /// on the way.
    pub fn receive(socket: *WebSocket) (Session.Error || websocket.ReadError)!websocket.Message {
        const exchange = &socket.request.exchange;
        while (true) {
            const received = socket.reading.next(socket.input, socket.messages) catch |err| switch (err) {
                error.ReadFailed => return exchange.err.?,
                else => |other| return other,
            };
            switch (received) {
                .ping => |payload| try socket.send(.pong, payload),
                else => return received,
            }
        }
    }

    /// Closes the socket: the server told, and the request let go.
    pub fn close(socket: *WebSocket) void {
        const allocator = socket.request.exchange.session.allocator;
        socket.send(.close, &.{}) catch {};
        socket.request.exchange.hangUp();
        socket.request.deinit();
        allocator.destroy(socket);
    }
};
