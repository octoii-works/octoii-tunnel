//! An exchange on a request stream of an HTTP/3 session on a station — a request and its response, from either side —
//! the session's state driven under the station's lock: the body that comes read through a reader, waiting till some
//! has come; the body that goes written through a writer, as DATA frames, waiting for room; a head, the stream's end,
//! and hanging up. It lives where its holder puts it, and its reader and writer point into it.
const Exchange = @This();
const std = @import("std");
const Station = @import("../Station.zig");
const Session = @import("Session.zig");
const qpack = @import("qpack.zig");

const Io = std.Io;
const Field = std.http.Header;

station: *Station,
session: *Session,
stream: u64,
/// What reads the body that comes.
body: Body,
/// What writes the body that goes, as DATA frames.
data: Data,
/// Why the body's reader or writer failed, where one did.
err: ?Error = null,
data_buffer: [16 * 1024]u8 = undefined,

/// What an exchange fails with: its session's error, or its station's.
pub const Error = Session.Error || Station.Error;

/// Puts an exchange on `stream` of `session`, a session on `station`, where `exchange` is.
pub fn init(exchange: *Exchange, station: *Station, session: *Session, stream: u64) void {
    exchange.* = .{
        .station = station,
        .session = session,
        .stream = stream,
        .body = .{ .interface = .{ .vtable = &.{ .stream = Body.streamOut }, .buffer = &.{}, .seek = 0, .end = 0 } },
        .data = undefined,
    };
    exchange.data = .{ .interface = .{ .vtable = &.{ .drain = Data.drain }, .buffer = &exchange.data_buffer } };
}

/// Lets the exchange go: its stream closed, and what the session held of it freed.
pub fn deinit(exchange: *Exchange) void {
    exchange.station.drive(exchange, closeStep) catch {};
}

fn closeStep(exchange: *Exchange) error{}!?void {
    exchange.session.closeStream(exchange.stream);
}

/// The head that came on the exchange's stream, once it came, kept till the stream is let go.
pub fn receiveHead(exchange: *Exchange) Error!qpack.Section {
    return exchange.station.drive(exchange, headStep);
}

fn headStep(exchange: *Exchange) Session.Error!?qpack.Section {
    try exchange.session.poll();
    return exchange.session.head(exchange.stream);
}

/// Ends the session at the peer's `err`, as a head its holder read was not formed as HTTP/3 forms one: `err`.
pub fn fail(exchange: *Exchange, err: Session.ProtocolError) Error {
    const Failing = struct { exchange: *Exchange, err: Session.ProtocolError };
    exchange.station.drive(Failing{ .exchange = exchange, .err = err }, struct {
        fn step(failing: Failing) error{}!?void {
            failing.exchange.session.end(failing.err);
        }
    }.step) catch {};
    return err;
}

/// Writes a head of the fields of `groups`, in order, before the body, once there is room for it.
pub fn sendHead(exchange: *Exchange, groups: []const []const Field) Error!void {
    const Sending = struct { exchange: *Exchange, groups: []const []const Field };
    return exchange.station.drive(Sending{ .exchange = exchange, .groups = groups }, struct {
        fn step(sending: Sending) Session.Error!?void {
            return if (try sending.exchange.session.sendHead(sending.exchange.stream, sending.groups)) {} else null;
        }
    }.step);
}

/// A reader of the body that comes, read through `buffer`.
pub fn bodyReader(exchange: *Exchange, buffer: []u8) *Io.Reader {
    exchange.body.interface.buffer = buffer;
    return &exchange.body.interface;
}

/// The writer of the body that goes, as DATA frames.
pub fn bodyWriter(exchange: *Exchange) *Io.Writer {
    return &exchange.data.interface;
}

/// Sends what was written.
pub fn flush(exchange: *Exchange) Error!void {
    exchange.data.interface.flush() catch return exchange.err.?;
}

/// Sends what was written, and the stream's end after it.
pub fn finish(exchange: *Exchange) Error!void {
    try exchange.flush();
    return exchange.station.drive(exchange, finishStep);
}

fn finishStep(exchange: *Exchange) Session.Error!?void {
    try exchange.session.finish(exchange.stream);
}

/// Ends both ways, as a socket is shut down both ways: what was written sent and the stream's end after it, and the
/// body that comes no more read, a read waiting on it finding its end.
pub fn hangUp(exchange: *Exchange) void {
    exchange.flush() catch {};
    exchange.station.drive(exchange, hangUpStep) catch {};
}

fn hangUpStep(exchange: *Exchange) error{}!?void {
    exchange.session.hangUp(exchange.stream);
}

/// What the body's reader reads: the payloads of its DATA frames, each read once some has come.
const Body = struct {
    interface: Io.Reader,

    const Read = union(enum) { bytes: usize, end };
    const Reading = struct { exchange: *Exchange, into: []u8 };

    fn streamOut(r: *Io.Reader, w: *Io.Writer, limit: Io.Limit) Io.Reader.StreamError!usize {
        const body: *Body = @alignCast(@fieldParentPtr("interface", r));
        const exchange: *Exchange = @alignCast(@fieldParentPtr("body", body));
        const into = limit.slice(try w.writableSliceGreedy(1));
        if (into.len == 0) return 0;
        const read = exchange.station.drive(Reading{ .exchange = exchange, .into = into }, step) catch |err| {
            exchange.err = err;
            return error.ReadFailed;
        };
        switch (read) {
            .bytes => |length| {
                w.advance(length);
                return length;
            },
            .end => return error.EndOfStream,
        }
    }

    fn step(reading: Reading) Session.Error!?Read {
        const length = try reading.exchange.session.readBody(reading.exchange.stream, reading.into) orelse return .end;
        return if (length == 0) null else .{ .bytes = length };
    }
};

/// What the body's writer writes: what it gathered and what it is given, as DATA frames, each written once there is
/// room for some of it.
const Data = struct {
    interface: Io.Writer,

    const Writing = struct { exchange: *Exchange, bytes: []const u8 };

    fn drain(w: *Io.Writer, data: []const []const u8, splat: usize) Io.Writer.Error!usize {
        const exchange: *Exchange = @alignCast(@fieldParentPtr("data", @as(*Data, @alignCast(@fieldParentPtr("interface", w)))));
        try write(exchange, w.buffered());
        w.end = 0;
        var written: usize = 0;
        for (data[0 .. data.len - 1]) |bytes| {
            try write(exchange, bytes);
            written += bytes.len;
        }
        const last = data[data.len - 1];
        for (0..splat) |_| try write(exchange, last);
        return written + last.len * splat;
    }

    fn write(exchange: *Exchange, bytes: []const u8) Io.Writer.Error!void {
        var taken: usize = 0;
        while (taken < bytes.len) {
            taken += exchange.station.drive(Writing{ .exchange = exchange, .bytes = bytes[taken..] }, step) catch |err| {
                exchange.err = err;
                return error.WriteFailed;
            };
        }
    }

    fn step(writing: Writing) Session.Error!?usize {
        const taken = try writing.exchange.session.writeBody(writing.exchange.stream, writing.bytes);
        return if (taken == 0) null else taken;
    }
};
