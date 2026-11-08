//! The client's side of an HTTP/3 session on a station: requests sent, each on a stream of its own, their bodies
//! written and their responses read; and WebSockets opened by the extended CONNECT of RFC 9220, once the server's
//! settings take one, the client's messages masked as RFC 6455 has a client mask them. The session's state is driven
//! under the station's lock.
const Client = @This();
const std = @import("std");
const Station = @import("../Station.zig");
const Connection = @import("../Connection.zig");
const websocket = @import("../websocket.zig");
const Session = @import("Session.zig");
const Exchange = @import("Exchange.zig");
const message = @import("message.zig");
const frame = @import("frame.zig");

const Io = std.Io;
const Field = std.http.Header;

allocator: std.mem.Allocator,
station: *Station,
session: *Session,

/// The client's side of an HTTP/3 session on `connection`, a session `station` opened.
pub fn init(allocator: std.mem.Allocator, station: *Station, connection: *Connection) Exchange.Error!Client {
    std.debug.assert(connection.side == .client);
    const session = try allocator.create(Session);
    errdefer allocator.destroy(session);
    const Opening = struct { allocator: std.mem.Allocator, connection: *Connection };
    session.* = try station.drive(Opening{ .allocator = allocator, .connection = connection }, struct {
        fn step(opening: Opening) Session.Error!?Session {
            return try Session.init(opening.allocator, opening.connection);
        }
    }.step);
    return .{ .allocator = allocator, .station = station, .session = session };
}

/// Frees what the session holds; the station's session stays its holder's to close. No request may be left.
pub fn deinit(client: Client) void {
    client.station.drive(client.session, deinitStep) catch {};
    client.allocator.destroy(client.session);
}

fn deinitStep(session: *Session) error{}!?void {
    session.deinit();
}

/// How a request is sent.
pub const RequestOptions = struct {
    /// The server's name, as the request names it.
    authority: []const u8,
    extra_headers: []const Field = &.{},
};

/// Sends the head of a request of `method` for `target`: the request, its body to write, then its response to read.
pub fn request(client: Client, method: std.http.Method, target: []const u8, options: RequestOptions) Exchange.Error!*Request {
    return client.send(&.{
        .{ .name = ":method", .value = @tagName(method) },
        .{ .name = ":scheme", .value = "https" },
        .{ .name = ":authority", .value = options.authority },
        .{ .name = ":path", .value = target },
    }, options.extra_headers);
}

/// Sends a request whose head holds `pseudo`, then `extra_headers`, on a stream of its own.
fn send(client: Client, pseudo: []const Field, extra_headers: []const Field) Exchange.Error!*Request {
    const stream = try client.station.drive(client.session, openStep);
    const sent = client.allocator.create(Request) catch |err| {
        client.station.drive(Closing{ .session = client.session, .stream = stream }, Closing.step) catch {};
        return err;
    };
    sent.head = undefined;
    sent.exchange.init(client.station, client.session, stream);
    errdefer sent.deinit();
    try sent.exchange.sendHead(&.{ pseudo, extra_headers });
    return sent;
}

fn openStep(session: *Session) Session.Error!?u64 {
    return try session.openRequest();
}

const Closing = struct {
    session: *Session,
    stream: u64,

    fn step(closing: Closing) error{}!?void {
        closing.session.closeStream(closing.stream);
    }
};

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
    pub fn finish(sent: *Request) Exchange.Error!void {
        try sent.exchange.finish();
    }

    /// Reads the final response's head, once it came.
    pub fn receiveHead(sent: *Request) Exchange.Error!void {
        const section = try sent.exchange.receiveHead();
        sent.head = message.responseHeadOf(section) catch unreachable;
    }

    /// A reader of the response's body, read through `buffer`.
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
pub fn openWebSocket(client: Client, target: []const u8, options: WebSocketOptions) Exchange.Error!*WebSocket {
    if (!(try client.station.drive(client.session, settingsStep)).enable_connect_protocol) return error.Refused;
    const sent = try client.send(&.{
        .{ .name = ":method", .value = "CONNECT" },
        .{ .name = ":protocol", .value = "websocket" },
        .{ .name = ":scheme", .value = "https" },
        .{ .name = ":authority", .value = options.authority },
        .{ .name = ":path", .value = target },
        .{ .name = "sec-websocket-version", .value = "13" },
    }, options.extra_headers);
    errdefer sent.deinit();
    try sent.receiveHead();
    if (sent.head.status.class() != .success) return error.Refused;
    const socket = try client.allocator.create(WebSocket);
    socket.* = .{ .request = sent, .input = undefined, .messages = options.buffer };
    socket.input = sent.reader(&socket.read_buffer);
    return socket;
}

fn settingsStep(session: *Session) Session.Error!?frame.Settings {
    try session.poll();
    return session.peer_settings;
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
    pub fn send(socket: *WebSocket, opcode: websocket.Opcode, payload: []const u8) Exchange.Error!void {
        var mask: [4]u8 = undefined;
        socket.request.exchange.station.io.random(&mask);
        const exchange = &socket.request.exchange;
        websocket.writeFrame(exchange.bodyWriter(), opcode, payload, mask) catch return exchange.err.?;
        try exchange.flush();
    }

    /// The next message the server sends, its bytes in the socket's buffer of messages till the next; the server's
    /// pings answered on the way.
    pub fn receive(socket: *WebSocket) (Exchange.Error || websocket.ReadError)!websocket.Message {
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
