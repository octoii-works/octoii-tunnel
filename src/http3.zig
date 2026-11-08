//! HTTP/3 (RFC 9114) on the tunnel's sessions: QUIC's variable-length integers, HTTP/3's frames and error codes, QPACK
//! by its static table alone, the heads of HTTP's messages; and a session's two sides — the server's, answering its
//! client's requests and opening the WebSockets they ask for, and the client's, sending requests and opening WebSockets.
pub const varint = @import("http3/varint.zig");
pub const frame = @import("http3/frame.zig");
pub const qpack = @import("http3/qpack.zig");
pub const message = @import("http3/message.zig");
pub const Code = @import("http3/code.zig").Code;
pub const ProtocolError = @import("http3/code.zig").ProtocolError;
pub const Session = @import("http3/Session.zig");
pub const Server = @import("http3/Server.zig");
pub const Client = @import("http3/Client.zig");

test {
    _ = varint;
    _ = frame;
    _ = qpack;
    _ = message;
    _ = @import("http3/code.zig");
    _ = Session;
    _ = Server;
    _ = Client;
}
