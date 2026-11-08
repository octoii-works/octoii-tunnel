//! What ends an HTTP/3 session or a stream of it: the error codes its peer is told (RFC 9114, section 8.1; RFC 9204,
//! section 6), and the protocol's errors as the tunnel's HTTP/3 finds them, each told by its code. Every error a peer
//! makes ends the session, as an endpoint may treat any stream's error as the connection's.
const std = @import("std");

/// An error code of HTTP/3 or QPACK.
pub const Code = enum(u64) {
    no_error = 0x100,
    general_protocol_error = 0x101,
    internal_error = 0x102,
    stream_creation_error = 0x103,
    closed_critical_stream = 0x104,
    frame_unexpected = 0x105,
    frame_error = 0x106,
    excessive_load = 0x107,
    id_error = 0x108,
    settings_error = 0x109,
    missing_settings = 0x10a,
    request_rejected = 0x10b,
    request_cancelled = 0x10c,
    request_incomplete = 0x10d,
    message_error = 0x10e,
    connect_error = 0x10f,
    version_fallback = 0x110,
    qpack_decompression_failed = 0x200,
    qpack_encoder_stream_error = 0x201,
    qpack_decoder_stream_error = 0x202,
    _,
};

/// What a peer may do wrong.
pub const ProtocolError = error{
    /// A stream of a type or a number the peer may not open.
    StreamCreation,
    /// The peer ended a stream the session cannot go on without.
    ClosedCriticalStream,
    /// A frame where its type may not be.
    FrameUnexpected,
    /// A frame not laid out as its type is, or cut short.
    MalformedFrame,
    /// More than the session takes: a frame too long to hold whole.
    ExcessiveLoad,
    /// An identifier the peer may not use.
    BadIdentifier,
    /// Settings not as they may be.
    BadSettings,
    /// A control stream that does not begin with the peer's settings.
    MissingSettings,
    /// A request or a response not formed as HTTP's are.
    MalformedMessage,
    /// A field section that does not decode.
    DecompressionFailed,
};

/// The code that tells a peer of `err`.
pub fn of(err: ProtocolError) Code {
    return switch (err) {
        error.StreamCreation => .stream_creation_error,
        error.ClosedCriticalStream => .closed_critical_stream,
        error.FrameUnexpected => .frame_unexpected,
        error.MalformedFrame => .frame_error,
        error.ExcessiveLoad => .excessive_load,
        error.BadIdentifier => .id_error,
        error.BadSettings => .settings_error,
        error.MissingSettings => .missing_settings,
        error.MalformedMessage => .message_error,
        error.DecompressionFailed => .qpack_decompression_failed,
    };
}

test "each of a peer's errors is told by its code" {
    try std.testing.expectEqual(Code.frame_error, of(error.MalformedFrame));
    try std.testing.expectEqual(@as(u64, 0x200), @backingInt(of(error.DecompressionFailed)));
}
