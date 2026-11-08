//! An HTTP/3 session (RFC 9114) on a tunnel session, either side, as state its driver steps: no I/O, no task and no
//! lock of its own — its driver holds the connection as it is held, under a station's lock or on a page's one thread,
//! and calls it as bytes come and as its holder asks. It opens its control stream and sends its settings as it starts;
//! takes the streams its peer opens, reading the peer's control stream, its settings and then its frames, and QPACK's
//! two streams, on which a dynamic table of no capacity leaves nothing the session needs, as they come; reads each
//! request's or response's head once it came whole, and a body's DATA as its holder reads it, in place in the stream's
//! buffer; and writes heads, and bodies as DATA frames, as there is room. Whatever error the peer makes ends the
//! session with the code that tells it, as an endpoint may treat any stream's error as the connection's.
const Session = @This();
const std = @import("std");
const Connection = @import("../Connection.zig");
const frame = @import("frame.zig");
const varint = @import("varint.zig");
const qpack = @import("qpack.zig");
const message = @import("message.zig");
const code = @import("code.zig");

const Io = std.Io;
const Field = std.http.Header;
pub const ProtocolError = code.ProtocolError;

allocator: std.mem.Allocator,
connection: *Connection,
/// The settings the session's control stream told its peer.
settings: frame.Settings,
/// The session's own control stream.
control: u64,
/// The peer's settings, once its control stream told them.
peer_settings: ?frame.Settings = null,
/// Whether the peer opened its control stream, as it may once.
peer_control: bool = false,
/// The HTTP/3 streams of the session, by number.
streams: std.AutoArrayHashMapUnmanaged(u64, Stream) = .empty,
/// The client's requests whose heads came, not yet taken, in the order they came.
requests: std.ArrayList(u64) = .empty,

/// The most bytes of a field section a session takes, as its settings tell its peer: a head is read whole, in place,
/// before any of it is consumed, so it fits the window a stream opens with.
pub const max_field_section = 32 * 1024;

/// The most bytes of a frame on a control stream a session takes.
const max_control_frame = 1024;

/// What using a session fails with: an error of its peer's, which ended it, or its stream's.
pub const Error = ProtocolError || error{ Closed, Reset, OutOfMemory };

/// The types of the streams a side opens one way (RFC 9114, section 6.2; RFC 9204, section 4.2).
const StreamType = enum(u64) {
    control = 0x00,
    push = 0x01,
    encoder = 0x02,
    decoder = 0x03,
    _,
};

/// An HTTP/3 stream: what it is, and where in its frames the reading is.
const Stream = struct {
    role: Role,
    framing: frame.Framing,
    /// A request stream's: where its frames are.
    phase: Phase = .head,
    /// A request stream's: the payload of the head that came, which its section points into.
    head: []u8 = &.{},
    /// A request stream's: whether its holder hung it up, reading no more of it.
    hung_up: bool = false,
};

const Role = enum {
    /// One the peer opened one way, its type yet to come.
    typing,
    /// The peer's control stream.
    control,
    /// One of the peer's QPACK streams, drained.
    drained,
    /// A request and its response.
    request,
};

/// Where a request stream's frames are: its head to come, its body's, its trailers', or past its end.
pub const Phase = enum { head, body, trailers, done };

/// An HTTP/3 session on `connection`: its control stream opened and its settings written. A server's settings take a
/// CONNECT that opens a WebSocket.
pub fn init(allocator: std.mem.Allocator, connection: *Connection) Error!Session {
    var session: Session = .{
        .allocator = allocator,
        .connection = connection,
        .settings = .{ .max_field_section_size = max_field_section, .enable_connect_protocol = connection.side == .server },
        .control = connection.openStream(.unidirectional) catch |err| return err,
    };
    var buffer: [64]u8 = undefined;
    var writer: Io.Writer = .fixed(&buffer);
    varint.write(&writer, @backingInt(StreamType.control)) catch unreachable;
    session.settings.write(&writer) catch unreachable;
    _ = try connection.write(session.control, writer.buffered());
    return session;
}

pub fn deinit(session: *Session) void {
    for (session.streams.values()) |stream| session.allocator.free(stream.head);
    session.streams.deinit(session.allocator);
    session.requests.deinit(session.allocator);
}

/// Ends the session at the peer's `err`, with the code that tells it.
pub fn end(session: *Session, err: ProtocolError) void {
    session.connection.close(@backingInt(code.of(err)));
}

/// Ends the session at the peer's `err`: `err`.
fn fail(session: *Session, err: ProtocolError) ProtocolError {
    session.end(err);
    return err;
}

/// `Closed` where the session ended.
fn checkOpen(session: *const Session) Error!void {
    if (session.connection.state == .closed) return error.Closed;
}

/// Takes what came: the streams the peer opened, what came on its control and QPACK streams, and the heads that came
/// whole on request streams; a client's request whose head came waits to be taken.
pub fn poll(session: *Session) Error!void {
    try session.checkOpen();
    session.pollChecked() catch |err| return switch (err) {
        error.OutOfMemory, error.Closed, error.Reset => err,
        else => |protocol| session.fail(protocol),
    };
}

fn pollChecked(session: *Session) Error!void {
    while (session.connection.takeOpened(.unidirectional)) |stream| try session.add(stream, .typing, max_control_frame);
    while (session.connection.takeOpened(.bidirectional)) |stream| switch (session.connection.side) {
        .server => try session.add(stream, .request, max_field_section),
        // A server opens no request streams.
        .client => return error.StreamCreation,
    };
    var index: usize = 0;
    while (index < session.streams.count()) : (index += 1) {
        const stream = session.streams.keys()[index];
        const entry = &session.streams.values()[index];
        switch (entry.role) {
            .typing => if (try session.readType(stream, entry)) {
                // Let go, it is no more.
                index -%= 1;
            },
            .control => try session.readControl(stream, entry),
            .drained => try session.drain(stream),
            .request => if (entry.phase == .head and try session.readHead(stream, entry)) {
                index -%= 1;
            },
        }
    }
}

fn add(session: *Session, stream: u64, role: Role, max_whole: usize) !void {
    try session.streams.put(session.allocator, stream, .{ .role = role, .framing = .init(max_whole) });
}

/// Reads the type of a stream the peer opened one way, once it came: whether the stream is let go — of a type HTTP/3
/// does not know, as a peer may open any, or ended before its type.
fn readType(session: *Session, stream: u64, entry: *Stream) Error!bool {
    const unread = session.connection.peek(stream) catch return session.letGo(stream, .no_error);
    var reader: Io.Reader = .fixed(unread.bytes);
    const type_: StreamType = @fromBackingInt(varint.read(&reader) catch {
        if (unread.ended) return session.letGo(stream, .no_error);
        return false;
    });
    session.connection.consume(stream, reader.seek);
    switch (type_) {
        .control => {
            if (session.peer_control) return error.StreamCreation;
            session.peer_control = true;
            entry.role = .control;
        },
        .encoder, .decoder => entry.role = .drained,
        // The server pushes nothing to a client that never let it, and a client pushes nothing.
        .push => return switch (session.connection.side) {
            .client => error.BadIdentifier,
            .server => error.StreamCreation,
        },
        _ => return session.letGo(stream, .stream_creation_error),
    }
    return false;
}

/// Lets go of a stream the peer opened, asking it to stop sending with `reason`: true, for the stream is no more.
fn letGo(session: *Session, stream: u64, reason: code.Code) bool {
    session.connection.closeStream(stream, @backingInt(reason));
    _ = session.streams.swapRemove(stream);
    return true;
}

/// Reads what came on the peer's control stream: its settings first, then its frames; its end ends the session.
fn readControl(session: *Session, stream: u64, entry: *Stream) Error!void {
    while (true) {
        const unread = session.connection.peek(stream) catch return error.ClosedCriticalStream;
        const step = try entry.framing.next(unread.bytes, 1);
        switch (step.piece) {
            .data => return error.FrameUnexpected,
            .frame => |whole| try session.takeControl(whole),
            .incomplete => {
                session.connection.consume(stream, step.consumed);
                if (unread.ended) return error.ClosedCriticalStream;
                return;
            },
        }
        session.connection.consume(stream, step.consumed);
    }
}

fn takeControl(session: *Session, whole: frame.Frame) ProtocolError!void {
    if (session.peer_settings == null) {
        if (whole.type != .settings) return error.MissingSettings;
        session.peer_settings = try frame.Settings.decode(whole.payload);
        return;
    }
    switch (whole.type) {
        .goaway, .cancel_push => _ = try frame.identifierOf(whole.payload),
        .max_push_id => switch (session.connection.side) {
            .client => return error.FrameUnexpected,
            .server => _ = try frame.identifierOf(whole.payload),
        },
        else => return error.FrameUnexpected,
    }
}

/// Drains one of the peer's QPACK streams; its end ends the session, which cannot go on without it.
fn drain(session: *Session, stream: u64) Error!void {
    const unread = session.connection.peek(stream) catch return error.ClosedCriticalStream;
    session.connection.consume(stream, unread.bytes.len);
    if (unread.ended) return error.ClosedCriticalStream;
}

/// Reads a request stream's head once it came whole — on the client's side, the final response's, each interim one
/// passed over; a request whose head came waits to be taken. A request its client reset before its head came is let
/// go: whether it was.
fn readHead(session: *Session, stream: u64, entry: *Stream) Error!bool {
    while (true) {
        const unread = session.connection.peek(stream) catch switch (session.connection.side) {
            .server => return session.letGo(stream, .request_cancelled),
            .client => {
                entry.phase = .done;
                return false;
            },
        };
        const step = try entry.framing.next(unread.bytes, 1);
        const whole = switch (step.piece) {
            .data => return error.FrameUnexpected,
            .frame => |whole| whole,
            .incomplete => {
                session.connection.consume(stream, step.consumed);
                if (unread.ended) return error.MalformedMessage;
                return false;
            },
        };
        if (whole.type != .headers) return error.FrameUnexpected;
        const section = try qpack.Section.decode(whole.payload);
        const interim = switch (session.connection.side) {
            .server => false,
            .client => @backingInt((message.responseHeadOf(section) catch return error.MalformedMessage).status) < 200,
        };
        if (!interim) {
            const kept = try session.allocator.dupe(u8, whole.payload);
            session.allocator.free(entry.head);
            entry.head = kept;
            entry.phase = .body;
        }
        session.connection.consume(stream, step.consumed);
        if (interim) continue;
        if (session.connection.side == .server) try session.requests.append(session.allocator, stream);
        return false;
    }
}

/// The next request whose head came, not yet taken.
pub fn takeRequest(session: *Session) ?u64 {
    if (session.requests.items.len == 0) return null;
    return session.requests.orderedRemove(0);
}

/// The head that came on `stream`, once it came: a request's, on the server's side; the final response's, on the
/// client's; `Reset` where the peer reset the stream before it.
pub fn head(session: *const Session, stream: u64) error{Reset}!?qpack.Section {
    const entry = session.streams.getPtr(stream).?;
    if (entry.phase == .head) return null;
    if (entry.head.len == 0) return error.Reset;
    return qpack.Section.decode(entry.head) catch unreachable;
}

/// Opens a request stream, on the client's side.
pub fn openRequest(session: *Session) Error!u64 {
    std.debug.assert(session.connection.side == .client);
    try session.streams.ensureUnusedCapacity(session.allocator, 1);
    const stream = try session.connection.openStream(.bidirectional);
    session.streams.putAssumeCapacity(stream, .{ .role = .request, .framing = .init(max_field_section) });
    return stream;
}

/// Reads into `buffer` the next of the body that came on `stream`: how many bytes, none where nothing more has come
/// yet, null at the body's end — or where its holder hung it up.
pub fn readBody(session: *Session, stream: u64, buffer: []u8) Error!?usize {
    std.debug.assert(buffer.len > 0);
    const entry = session.streams.getPtr(stream).?;
    if (entry.hung_up) return null;
    return session.readBodyChecked(stream, entry, buffer) catch |err| switch (err) {
        error.OutOfMemory, error.Closed, error.Reset => err,
        else => |protocol| session.fail(protocol),
    };
}

fn readBodyChecked(session: *Session, stream: u64, entry: *Stream, buffer: []u8) Error!?usize {
    while (true) {
        std.debug.assert(entry.phase != .head);
        if (entry.phase == .done) return null;
        const unread = try session.connection.peek(stream);
        const step = try entry.framing.next(unread.bytes, buffer.len);
        switch (step.piece) {
            .data => |bytes| {
                if (entry.phase == .trailers) return error.FrameUnexpected;
                @memcpy(buffer[0..bytes.len], bytes);
                session.connection.consume(stream, step.consumed);
                return bytes.len;
            },
            .frame => |whole| {
                if (whole.type != .headers or entry.phase == .trailers) return error.FrameUnexpected;
                _ = try qpack.Section.decode(whole.payload);
                entry.phase = .trailers;
                session.connection.consume(stream, step.consumed);
            },
            .incomplete => {
                session.connection.consume(stream, step.consumed);
                if (!unread.ended) {
                    try session.checkOpen();
                    return 0;
                }
                if (unread.bytes.len > step.consumed or !entry.framing.isBetween()) return error.MalformedFrame;
                entry.phase = .done;
            },
        }
    }
}

/// Writes a head of the fields of `groups`, in order, before `stream`'s body, where there is room for it: whether
/// there was.
pub fn sendHead(session: *Session, stream: u64, groups: []const []const Field) Error!bool {
    try session.checkOpen();
    var encoded: Io.Writer.Allocating = .init(session.allocator);
    defer encoded.deinit();
    qpack.write(&encoded.writer, groups) catch return error.OutOfMemory;
    var head_bytes: [frame.max_head]u8 = undefined;
    var writer: Io.Writer = .fixed(&head_bytes);
    frame.writeHead(&writer, .headers, encoded.written().len) catch unreachable;
    if (session.connection.room(stream) < writer.buffered().len + encoded.written().len) return false;
    _ = try session.connection.write(stream, writer.buffered());
    _ = try session.connection.write(stream, encoded.written());
    return true;
}

/// Writes as much of `bytes` as there is room for, as one DATA frame of `stream`'s body: how many it took, none where
/// there is no room.
pub fn writeBody(session: *Session, stream: u64, bytes: []const u8) Error!usize {
    try session.checkOpen();
    const room = session.connection.room(stream);
    if (room <= frame.max_head) return 0;
    const length = @min(bytes.len, room - frame.max_head);
    var head_bytes: [frame.max_head]u8 = undefined;
    var writer: Io.Writer = .fixed(&head_bytes);
    frame.writeHead(&writer, .data, length) catch unreachable;
    _ = try session.connection.write(stream, writer.buffered());
    _ = try session.connection.write(stream, bytes[0..length]);
    return length;
}

/// Ends `stream`'s side of the exchange: its end sent once all written is.
pub fn finish(session: *Session, stream: u64) Error!void {
    try session.connection.shutdown(stream);
}

/// Ends both ways of `stream`, as a socket is shut down both ways: its end sent, and what comes on it no more read — a
/// body's reading ends where it stopped.
pub fn hangUp(session: *Session, stream: u64) void {
    session.connection.shutdown(stream) catch {};
    session.connection.stopReceiving(stream, @backingInt(code.Code.no_error));
    session.streams.getPtr(stream).?.hung_up = true;
}

/// Lets go of `stream`: it is closed, and what the session held of it freed.
pub fn closeStream(session: *Session, stream: u64) void {
    session.connection.closeStream(stream, @backingInt(code.Code.no_error));
    const removed = session.streams.fetchSwapRemove(stream) orelse return;
    session.allocator.free(removed.value.head);
}
