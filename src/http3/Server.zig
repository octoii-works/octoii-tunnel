//! The server's side of an HTTP/3 session on a station: the requests its client sends, each taken once its head came,
//! read and answered on its own stream — a response whole, or the WebSocket an extended CONNECT opens (RFC 9220), its
//! messages read and written as the standard library's server reads and writes a WebSocket's over HTTP/1.1. The
//! session's state is driven under the station's lock.
const Server = @This();
const std = @import("std");
const Station = @import("../Station.zig");
const Connection = @import("../Connection.zig");
const Session = @import("Session.zig");
const Exchange = @import("Exchange.zig");
const message = @import("message.zig");

const Io = std.Io;
const Field = std.http.Header;

allocator: std.mem.Allocator,
station: *Station,
session: *Session,

/// The server's side of an HTTP/3 session on `connection`, a session a peer opened to `station`.
pub fn init(allocator: std.mem.Allocator, station: *Station, connection: *Connection) Exchange.Error!Server {
    std.debug.assert(connection.side == .server);
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
pub fn deinit(server: Server) void {
    server.station.drive(server.session, deinitStep) catch {};
    server.allocator.destroy(server.session);
}

fn deinitStep(session: *Session) error{}!?void {
    session.deinit();
}

/// The next request the client sends, once its head came; `Closed` once the session ended.
pub fn accept(server: Server) Exchange.Error!*Request {
    const stream = try server.station.drive(server.session, acceptStep);
    const request = try server.allocator.create(Request);
    request.head = undefined;
    request.exchange.init(server.station, server.session, stream);
    return request;
}

fn acceptStep(session: *Session) Session.Error!?u64 {
    try session.poll();
    return session.takeRequest();
}

/// A request the client sent, read and answered on its stream.
pub const Request = struct {
    exchange: Exchange,
    /// The request's head, once `receiveHead` read it.
    head: message.RequestHead,

    pub const Error = Exchange.Error || error{UnknownMethod};

    /// Reads the request's head; `UnknownMethod`, answered as not implemented, where it asks with a method the
    /// tunnel's HTTP/3 does not serve.
    pub fn receiveHead(request: *Request) Request.Error!void {
        const section = try request.exchange.receiveHead();
        request.head = message.requestHeadOf(section) catch |err| switch (err) {
            error.MalformedMessage => return request.exchange.fail(error.MalformedMessage),
            error.UnknownMethod => {
                request.sendHead(.not_implemented, 0, &.{}) catch {};
                request.exchange.finish() catch {};
                return error.UnknownMethod;
            },
        };
    }

    /// The request's fields, its pseudo-fields left out.
    pub fn iterateHeaders(request: *const Request) message.Fields {
        return request.head.iterateHeaders();
    }

    /// A reader of the request's body, read through `buffer`.
    pub fn reader(request: *Request, buffer: []u8) *Io.Reader {
        return request.exchange.bodyReader(buffer);
    }

    /// How a response is sent.
    pub const RespondOptions = struct {
        status: std.http.Status = .ok,
        extra_headers: []const Field = &.{},
    };

    /// Answers the request with `body` whole — no body for a HEAD, its length told all the same — and the stream's end
    /// after it.
    pub fn respond(request: *Request, body: []const u8, options: RespondOptions) Exchange.Error!void {
        try request.sendHead(options.status, body.len, options.extra_headers);
        if (request.head.method != .HEAD) request.exchange.bodyWriter().writeAll(body) catch return request.exchange.err.?;
        try request.exchange.finish();
    }

    /// Writes a response's head, of `status`, its body `length` bytes long.
    fn sendHead(request: *Request, status: std.http.Status, length: usize, extra_headers: []const Field) Exchange.Error!void {
        std.debug.assert(@backingInt(status) >= 200);
        var digits: [3]u8 = undefined;
        var length_digits: [20]u8 = undefined;
        const fields = [_]Field{
            message.statusField(&digits, status),
            .{ .name = "content-length", .value = std.fmt.bufPrint(&length_digits, "{d}", .{length}) catch unreachable },
        };
        try request.exchange.sendHead(&.{ &fields, extra_headers });
    }

    /// Whether the request asks to open a WebSocket, as RFC 9220's extended CONNECT does: of the protocol `websocket`,
    /// by the version of RFC 6455.
    pub fn webSocketRequested(request: *const Request) bool {
        const protocol = request.head.protocol orelse return false;
        if (request.head.method != .CONNECT or !std.mem.eql(u8, protocol, "websocket")) return false;
        var fields = request.iterateHeaders();
        while (fields.next()) |field| {
            if (std.mem.eql(u8, field.name, "sec-websocket-version")) return std.mem.eql(u8, field.value, "13");
        }
        return false;
    }

    /// How a WebSocket is opened.
    pub const WebSocketOptions = struct {
        /// What the client's messages are read into: the longest it may send.
        buffer: []u8,
        extra_headers: []const Field = &.{},
    };

    /// Opens the WebSocket the request asks for: its acceptance sent, then the socket on the request's stream, the
    /// client's messages read into `options.buffer`. The request's stream is the socket's till it is hung up.
    pub fn respondWebSocket(request: *Request, options: WebSocketOptions) Exchange.Error!std.http.Server.WebSocket {
        std.debug.assert(request.webSocketRequested());
        var digits: [3]u8 = undefined;
        try request.exchange.sendHead(&.{ &.{message.statusField(&digits, .ok)}, options.extra_headers });
        return .{ .key = "", .input = request.exchange.bodyReader(options.buffer), .output = request.exchange.bodyWriter() };
    }

    /// Ends both ways of the request's stream, as a socket is shut down both ways: what was written sent, the response's
    /// end after it, and the request's body no more read, a read waiting on it finding its end.
    pub fn hangUp(request: *Request) void {
        request.exchange.hangUp();
    }

    /// Lets the request go: its stream closed, what it held freed.
    pub fn deinit(request: *Request) void {
        const allocator = request.exchange.session.allocator;
        request.exchange.deinit();
        allocator.destroy(request);
    }
};
