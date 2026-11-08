//! Relays: what carries a session's datagrams between peers that reach each other by their keys alone — the frames a
//! peer and a relay say to each other, a peer showing the relay its key, the relay's routing, and the book an endpoint
//! keeps of the peers it reaches through relays.
pub const frame = @import("relay/frame.zig");
pub const authentication = @import("relay/authentication.zig");
pub const Router = @import("relay/Router.zig");
pub const Book = @import("relay/Book.zig");
pub const Link = @import("relay/Link.zig");
pub const Server = @import("relay/Server.zig");
pub const Forwarder = @import("relay/Forwarder.zig");

test {
    _ = frame;
    _ = authentication;
    _ = Router;
    _ = Book;
    _ = Link;
    _ = Server;
    _ = Forwarder;
}
