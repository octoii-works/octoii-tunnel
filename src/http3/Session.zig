//! An HTTP/3 session (RFC 9114) on a station's session, either side: its control stream opened as it starts, its
//! settings the first frame on it; the streams its peer opens one way taken as they come, each read by a task of its
//! own — the peer's control stream, its settings and then its frames, and QPACK's two streams, on which a dynamic table
//! of no capacity leaves nothing the session needs, drained; and the session ended, with the code that tells it, at
//! whatever error its peer makes on any stream. Its requests are the server's and the client's to take and to make.
const Session = @This();
const std = @import("std");
const Station = @import("../Station.zig");
const Connection = @import("../Connection.zig");
const frame = @import("frame.zig");
const varint = @import("varint.zig");
const code = @import("code.zig");

const Io = std.Io;
const ProtocolError = code.ProtocolError;

allocator: std.mem.Allocator,
station: *Station,
connection: *Connection,
/// The settings the session's control stream told its peer.
settings: frame.Settings,
control: Station.Stream,
lock: Io.Mutex = .init,
/// Whether the peer opened its control stream, as it may once.
peer_control: bool = false,
/// The peer's settings, once its control stream told them.
peer_settings: ?frame.Settings = null,
/// Set once the peer's settings came, or the session ended before they did.
settled: Io.Event = .unset,
/// The tasks taking and reading the peer's streams.
tasks: Io.Group = .init,

/// The most bytes of a field section a session takes, as its settings tell its peer.
pub const max_field_section = 64 * 1024;

/// What using a session fails with: an error of its peer's, which ended it, or its stream's.
pub const Error = ProtocolError || Station.Stream.Error;

/// The types of the streams a side opens one way (RFC 9114, section 6.2; RFC 9204, section 4.2).
const StreamType = enum(u64) {
    control = 0x00,
    push = 0x01,
    encoder = 0x02,
    decoder = 0x03,
    _,
};

/// An HTTP/3 session on `connection`, a session of `station`'s: its control stream opened and its settings sent, the
/// peer's streams taken from then on. A server's settings take a CONNECT that opens a WebSocket.
pub fn init(allocator: std.mem.Allocator, station: *Station, connection: *Connection) !*Session {
    const session = try allocator.create(Session);
    errdefer allocator.destroy(session);
    session.* = .{
        .allocator = allocator,
        .station = station,
        .connection = connection,
        .settings = .{ .max_field_section_size = max_field_section, .enable_connect_protocol = connection.side == .server },
        .control = try station.openStream(connection, .unidirectional),
    };
    var buffer: [64]u8 = undefined;
    var writer = session.control.writer(&buffer);
    varint.write(&writer.interface, @backingInt(StreamType.control)) catch unreachable;
    session.settings.write(&writer.interface) catch unreachable;
    writer.interface.flush() catch return writer.err.?;
    try session.tasks.concurrent(station.io, acceptStreams, .{session});
    return session;
}

/// Stops the session's tasks and frees it; the station's session stays its holder's to close.
pub fn deinit(session: *Session) void {
    session.tasks.cancel(session.station.io);
    session.allocator.destroy(session);
}

/// Ends the session at the peer's `err`, with the code that tells it.
pub fn fail(session: *Session, err: ProtocolError) void {
    session.station.end(session.connection, @backingInt(code.of(err)));
}

/// The peer's settings, once they came; `Closed` where the session ended before they did.
pub fn awaitSettings(session: *Session) Error!frame.Settings {
    session.settled.wait(session.station.io) catch return error.Canceled;
    return session.peer_settings orelse error.Closed;
}

/// Takes each stream the peer opens one way, reading it in a task of its own, till the session ends.
fn acceptStreams(session: *Session) void {
    const io = session.station.io;
    defer session.settled.set(io);
    while (true) {
        const stream = session.station.acceptStream(session.connection, .unidirectional) catch return;
        session.tasks.concurrent(io, readStream, .{ session, stream }) catch return session.fail(error.ExcessiveLoad);
    }
}

/// Reads a stream the peer opened one way, as its type, its first bytes, tells; one of a type HTTP/3 does not know is
/// let go, as the peer may open any.
fn readStream(session: *Session, stream: Station.Stream) void {
    var buffer: [1024]u8 = undefined;
    var reader = stream.reader(&buffer);
    const type_: StreamType = @fromBackingInt(varint.read(&reader.interface) catch return stream.close(@backingInt(code.Code.no_error)));
    switch (type_) {
        .control => session.readControl(&reader),
        .encoder, .decoder => session.drain(&reader),
        // The server pushes nothing to a client that never let it, and a client pushes nothing.
        .push => session.fail(switch (session.connection.side) {
            .client => error.BadIdentifier,
            .server => error.StreamCreation,
        }),
        _ => stream.close(@backingInt(code.Code.stream_creation_error)),
    }
}

/// Reads the peer's control stream: its settings, then its frames, till the session ends; the stream ending before it
/// ends the session.
fn readControl(session: *Session, reader: *Station.Stream.Reader) void {
    session.lock.lockUncancelable(session.station.io);
    const again = session.peer_control;
    session.peer_control = true;
    session.lock.unlock(session.station.io);
    if (again) return session.fail(error.StreamCreation);
    var incoming: Incoming = .init(reader);
    session.followControl(&incoming) catch |err| switch (err) {
        error.Reset => session.fail(error.ClosedCriticalStream),
        error.Closed, error.Canceled, error.Stopped, error.Refused, error.OutOfMemory => {},
        else => |protocol| session.fail(protocol),
    };
}

fn followControl(session: *Session, incoming: *Incoming) Error!void {
    const first = try incoming.next(1) orelse return error.ClosedCriticalStream;
    if (first != .frame or first.frame.type != .settings) return error.MissingSettings;
    session.peer_settings = try frame.Settings.decode(first.frame.payload);
    session.settled.set(session.station.io);
    while (try incoming.next(1)) |piece| switch (piece) {
        .data => return error.FrameUnexpected,
        .frame => |whole| switch (whole.type) {
            .goaway, .cancel_push => _ = try frame.identifierOf(whole.payload),
            .max_push_id => switch (session.connection.side) {
                .client => return error.FrameUnexpected,
                .server => _ = try frame.identifierOf(whole.payload),
            },
            else => return error.FrameUnexpected,
        },
    };
    return error.ClosedCriticalStream;
}

/// Reads one of the peer's QPACK streams to its end, which ends the session, as the session cannot go on without it.
fn drain(session: *Session, reader: *Station.Stream.Reader) void {
    _ = reader.interface.discardRemaining() catch {
        if (reader.err.? == error.Reset) session.fail(error.ClosedCriticalStream);
        return;
    };
    session.fail(error.ClosedCriticalStream);
}

/// A stream's frames as they come, read by a station stream's reader: what came in its buffer, and where in a frame
/// the reading is.
pub const Incoming = struct {
    reader: *Station.Stream.Reader,
    framing: frame.Framing,

    /// What comes next: bytes of a DATA frame's payload, or another frame whole.
    pub const Piece = union(enum) {
        data: []const u8,
        frame: frame.Frame,
    };

    /// The frames `reader` reads, those taken whole as long as its buffer holds.
    pub fn init(reader: *Station.Stream.Reader) Incoming {
        return .{ .reader = reader, .framing = .init(reader.interface.buffer.len - frame.max_head) };
    }

    /// The next piece, once it has come — of a DATA frame's payload, at most `most` bytes; null where the stream ended
    /// between frames. A piece is in the reader's buffer till the next is read.
    pub fn next(incoming: *Incoming, most: usize) Error!?Piece {
        const reader = &incoming.reader.interface;
        while (true) {
            const step = try incoming.framing.next(reader.buffered(), most);
            reader.toss(step.consumed);
            switch (step.piece) {
                .data => |bytes| return .{ .data = bytes },
                .frame => |whole| return .{ .frame = whole },
                .incomplete => {},
            }
            reader.fillMore() catch |err| switch (err) {
                error.EndOfStream => {
                    if (reader.bufferedLen() == 0 and incoming.framing.isBetween()) return null;
                    return error.MalformedFrame;
                },
                error.ReadFailed => return incoming.reader.err.?,
            };
        }
    }
};
