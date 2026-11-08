//! An exchange on a request stream of an HTTP/3 session — a request and its response — from either side: the frames
//! that come read as they come, a head and then the body's DATA, which a reader of the body reads, and trailers, which
//! are let be; and those that go written, a head and then the body as DATA frames, the stream's end after them. It
//! lives where its holder puts it, and its readers and writers point into it.
const Exchange = @This();
const std = @import("std");
const Station = @import("../Station.zig");
const Session = @import("Session.zig");
const frame = @import("frame.zig");
const qpack = @import("qpack.zig");
const code = @import("code.zig");

const Io = std.Io;
const Field = std.http.Header;

session: *Session,
stream: Station.Stream,
reader: Station.Stream.Reader,
incoming: Session.Incoming,
writer: Station.Stream.Writer,
/// What reads the body that comes.
body: Body,
/// What writes the body that goes, as DATA frames.
data: Data,
/// Where the frames that come are.
phase: Phase = .head,
/// The payload of the head that came last, which its section points into.
head: []u8 = &.{},
/// Why the body's reader or writer failed, where one did.
err: ?Session.Error = null,
/// Whether its holder hung it up: the body that comes is no more read, and its reading ends where it stopped.
hung_up: bool = false,
read_buffer: [frame.max_head + Session.max_field_section]u8 = undefined,
write_buffer: [256]u8 = undefined,
data_buffer: [16 * 1024]u8 = undefined,

/// Where the frames that come are: a head to come, the body's, the trailers', or past the stream's end.
pub const Phase = enum { head, body, trailers, done };

/// Puts an exchange on `stream` of `session` where `exchange` is.
pub fn init(exchange: *Exchange, session: *Session, stream: Station.Stream) void {
    exchange.* = .{
        .session = session,
        .stream = stream,
        .reader = undefined,
        .incoming = undefined,
        .writer = undefined,
        .body = .{ .interface = .{ .vtable = &.{ .stream = Body.streamOut }, .buffer = &.{}, .seek = 0, .end = 0 } },
        .data = undefined,
    };
    exchange.reader = stream.reader(&exchange.read_buffer);
    exchange.incoming = .init(&exchange.reader);
    exchange.writer = stream.writer(&exchange.write_buffer);
    exchange.data = .{ .interface = .{ .vtable = &.{ .drain = Data.drain, .flush = Data.flush }, .buffer = &exchange.data_buffer } };
}

/// Lets the exchange go: its stream closed, what it held freed.
pub fn deinit(exchange: *Exchange) void {
    exchange.stream.close(@backingInt(code.Code.no_error));
    exchange.session.allocator.free(exchange.head);
}

/// The next head that comes — a request's, a response's, or an interim response's — once it has come, kept till the
/// next; the body's frames come after it.
pub fn receiveHead(exchange: *Exchange) Session.Error!qpack.Section {
    std.debug.assert(exchange.phase == .head);
    const piece = try exchange.next(1) orelse return exchange.failed(error.MalformedMessage);
    if (piece != .frame or piece.frame.type != .headers) return exchange.failed(error.FrameUnexpected);
    _ = qpack.Section.decode(piece.frame.payload) catch |err| return exchange.failed(err);
    const allocator = exchange.session.allocator;
    const head = try allocator.dupe(u8, piece.frame.payload);
    allocator.free(exchange.head);
    exchange.head = head;
    exchange.phase = .body;
    return qpack.Section.decode(head) catch unreachable;
}

/// A reader of the body that comes, read into `buffer`.
pub fn bodyReader(exchange: *Exchange, buffer: []u8) *Io.Reader {
    exchange.body.interface.buffer = buffer;
    return &exchange.body.interface;
}

/// The next of the body's bytes, at most `most` of them, once they have come; null at its end.
fn nextData(exchange: *Exchange, most: usize) Session.Error!?[]const u8 {
    while (true) switch (exchange.phase) {
        .head => unreachable,
        .body => {
            const piece = try exchange.next(most) orelse {
                exchange.phase = .done;
                return null;
            };
            switch (piece) {
                .data => |bytes| return bytes,
                .frame => |whole| {
                    if (whole.type != .headers) return exchange.failed(error.FrameUnexpected);
                    _ = qpack.Section.decode(whole.payload) catch |err| return exchange.failed(err);
                    exchange.phase = .trailers;
                },
            }
        },
        .trailers => {
            if (try exchange.next(most) != null) return exchange.failed(error.FrameUnexpected);
            exchange.phase = .done;
        },
        .done => return null,
    };
}

fn next(exchange: *Exchange, most: usize) Session.Error!?Session.Incoming.Piece {
    return exchange.incoming.next(most) catch |err| {
        if (@atomicLoad(bool, &exchange.hung_up, .acquire)) return null;
        return exchange.failed(err);
    };
}

/// Ends the session where `err` is the peer's: `err`.
pub fn failed(exchange: *Exchange, err: Session.Error) Session.Error {
    switch (err) {
        error.Closed, error.Reset, error.Canceled, error.Stopped, error.Refused, error.OutOfMemory => {},
        else => |protocol| exchange.session.fail(protocol),
    }
    return err;
}

/// Writes a head of the fields of `groups`, in order, before the body.
pub fn sendHead(exchange: *Exchange, groups: []const []const Field) Session.Error!void {
    var encoded: Io.Writer.Allocating = .init(exchange.session.allocator);
    defer encoded.deinit();
    qpack.write(&encoded.writer, groups) catch return error.OutOfMemory;
    frame.write(&exchange.writer.interface, .headers, encoded.written()) catch return exchange.writer.err.?;
}

/// The writer of the body that goes, as DATA frames, each flush one.
pub fn bodyWriter(exchange: *Exchange) *Io.Writer {
    return &exchange.data.interface;
}

/// Sends what was written.
pub fn flush(exchange: *Exchange) Session.Error!void {
    exchange.data.interface.flush() catch return exchange.err.?;
}

/// Sends what was written, and the stream's end after it.
pub fn finish(exchange: *Exchange) Session.Error!void {
    try exchange.flush();
    try exchange.stream.shutdown();
}

/// Ends both ways, as a socket is shut down both ways: what was written sent and the stream's end after it, and the
/// body that comes no more read, a read waiting on it finding its end.
pub fn hangUp(exchange: *Exchange) void {
    exchange.finish() catch {};
    @atomicStore(bool, &exchange.hung_up, true, .release);
    exchange.stream.stopReceiving(@backingInt(code.Code.no_error));
}

/// What the body's reader reads: the payloads of its DATA frames.
const Body = struct {
    interface: Io.Reader,

    fn streamOut(r: *Io.Reader, w: *Io.Writer, limit: Io.Limit) Io.Reader.StreamError!usize {
        const body: *Body = @alignCast(@fieldParentPtr("interface", r));
        const exchange: *Exchange = @alignCast(@fieldParentPtr("body", body));
        const into = limit.slice(try w.writableSliceGreedy(1));
        if (into.len == 0) return 0;
        const bytes = exchange.nextData(into.len) catch |err| {
            exchange.err = err;
            return error.ReadFailed;
        } orelse return error.EndOfStream;
        @memcpy(into[0..bytes.len], bytes);
        w.advance(bytes.len);
        return bytes.len;
    }
};

/// What the body's writer writes: a DATA frame of what it gathered, at each drain.
const Data = struct {
    interface: Io.Writer,

    fn drain(w: *Io.Writer, data: []const []const u8, splat: usize) Io.Writer.Error!usize {
        const exchange: *Exchange = @alignCast(@fieldParentPtr("data", @as(*Data, @alignCast(@fieldParentPtr("interface", w)))));
        const gathered = w.buffered();
        const last = data[data.len - 1];
        var length: u64 = gathered.len + last.len * splat;
        for (data[0 .. data.len - 1]) |bytes| length += bytes.len;
        if (length == 0) return 0;
        const out = &exchange.writer.interface;
        errdefer if (exchange.writer.err) |err| {
            exchange.err = err;
        };
        try frame.writeHead(out, .data, length);
        try out.writeAll(gathered);
        for (data[0 .. data.len - 1]) |bytes| try out.writeAll(bytes);
        for (0..splat) |_| try out.writeAll(last);
        w.end = 0;
        return @intCast(length - gathered.len);
    }

    fn flush(w: *Io.Writer) Io.Writer.Error!void {
        const exchange: *Exchange = @alignCast(@fieldParentPtr("data", @as(*Data, @alignCast(@fieldParentPtr("interface", w)))));
        try w.defaultFlush();
        exchange.writer.interface.flush() catch |err| {
            if (exchange.writer.err) |cause| exchange.err = cause;
            return err;
        };
    }
};
