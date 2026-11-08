//! The server's side of an HTTP/3 session: the requests its client sends, taken as their streams open, each read and
//! answered on its own stream — a response whole, or the WebSocket an extended CONNECT opens (RFC 9220), its messages
//! read and written as the standard library's server reads and writes a WebSocket's over HTTP/1.1.
const Server = @This();
const std = @import("std");
const Station = @import("../Station.zig");
const Connection = @import("../Connection.zig");
const Session = @import("Session.zig");
const Exchange = @import("Exchange.zig");
const message = @import("message.zig");
const code = @import("code.zig");

const Io = std.Io;
const Field = std.http.Header;

session: *Session,

/// The server's side of an HTTP/3 session on `connection`, a session a peer opened to `station`.
pub fn init(allocator: std.mem.Allocator, station: *Station, connection: *Connection) !Server {
    std.debug.assert(connection.side == .server);
    return .{ .session = try Session.init(allocator, station, connection) };
}

/// Stops the session's tasks; the station's session stays its holder's to close.
pub fn deinit(server: Server) void {
    server.session.deinit();
}

/// The next request the client sends, its head yet to be read; `Closed` once the session ended.
pub fn accept(server: Server) Session.Error!*Request {
    const session = server.session;
    const stream = try session.station.acceptStream(session.connection, .bidirectional);
    const request = session.allocator.create(Request) catch |err| {
        stream.close(@backingInt(code.Code.internal_error));
        return err;
    };
    request.head = undefined;
    request.exchange.init(session, stream);
    return request;
}

/// A request the client sent, read and answered on its stream.
pub const Request = struct {
    exchange: Exchange,
    /// The request's head, once `receiveHead` read it.
    head: message.RequestHead,

    pub const Error = Session.Error || error{UnknownMethod};

    /// Reads the request's head, once it has come; `UnknownMethod`, answered as not implemented, where it asks with a
    /// method the tunnel's HTTP/3 does not serve.
    pub fn receiveHead(request: *Request) Request.Error!void {
        const section = try request.exchange.receiveHead();
        request.head = message.requestHeadOf(section) catch |err| switch (err) {
            error.MalformedMessage => return request.exchange.failed(error.MalformedMessage),
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

    /// A reader of the request's body, read into `buffer`.
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
    pub fn respond(request: *Request, body: []const u8, options: RespondOptions) Session.Error!void {
        try request.sendHead(options.status, body.len, options.extra_headers);
        if (request.head.method != .HEAD) request.exchange.bodyWriter().writeAll(body) catch return request.exchange.err.?;
        try request.exchange.finish();
    }

    /// Writes a response's head, of `status`, its body `length` bytes long.
    fn sendHead(request: *Request, status: std.http.Status, length: usize, extra_headers: []const Field) Session.Error!void {
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
    pub fn respondWebSocket(request: *Request, options: WebSocketOptions) Session.Error!std.http.Server.WebSocket {
        std.debug.assert(request.webSocketRequested());
        var digits: [3]u8 = undefined;
        try request.exchange.sendHead(&.{ &.{message.statusField(&digits, .ok)}, options.extra_headers });
        try request.exchange.flush();
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
