//! The relay as a WebAssembly module, for a host that holds the links itself, as a Durable Object holds its peers'
//! WebSockets: what the relay does with each message, through areas of the module's memory the host writes into and
//! reads back — the exchange, which holds a message; a key as text, which names a peer as the host tags its link; a
//! challenge's nonce, which the host draws and keeps; and the relay's host name.
const std = @import("std");
const Identity = @import("Identity.zig");
const frame = @import("relay/frame.zig");
const authentication = @import("relay/authentication.zig");

const Key = Identity.PublicKey;

/// A message the host writes and the module reads or rewrites, or a frame the module writes for the host to send.
var exchange: [frame.max_length]u8 = undefined;
/// A peer's key as text, as the host tags the peer's link.
var key_text: [Key.text_length]u8 = undefined;
/// The nonce of a link's challenge.
var nonce: [frame.nonce_length]u8 = undefined;
/// The relay's host name, as peers reach it.
var host: [253]u8 = undefined;
/// A route's name, as a home opens a stream to it.
var route_name: [frame.max_route]u8 = undefined;
/// What `relay_stream_decode` read last: the stream's number, the window it grants, and where its bytes lie in the
/// exchange.
var decoded: struct { id: u32 = 0, grant: u32 = 0, offset: usize = 0, length: usize = 0 } = .{};

export fn relay_exchange() [*]u8 {
    return &exchange;
}

export fn relay_key() [*]u8 {
    return &key_text;
}

export fn relay_nonce() [*]u8 {
    return &nonce;
}

export fn relay_host() [*]u8 {
    return &host;
}

export fn relay_route() [*]u8 {
    return &route_name;
}

/// Reads the frame in the exchange, `length` long, as what a machine says to its home: its type's byte, what it says
/// left for the getters below; 0 where it is no such frame.
export fn relay_stream_decode(length: usize) u32 {
    const read = frame.decode(exchange[0..length]) catch return 0;
    decoded = .{};
    switch (read) {
        .stream_data => |data| decoded = .{ .id = data.id, .offset = frame.stream_header, .length = data.bytes.len },
        .stream_end, .stream_reset => |id| decoded.id = id,
        .stream_window => |window| decoded = .{ .id = window.id, .grant = window.grant },
        .routes => |names| decoded = .{ .offset = 1, .length = names.len },
        else => return 0,
    }
    return exchange[0];
}

export fn relay_stream_id() u32 {
    return decoded.id;
}

export fn relay_stream_grant() u32 {
    return decoded.grant;
}

export fn relay_stream_offset() usize {
    return decoded.offset;
}

export fn relay_stream_length() usize {
    return decoded.length;
}

/// Where in the exchange the host puts the bytes of a stream's frame.
export fn relay_stream_header() usize {
    return frame.stream_header;
}

/// The most bytes of a stream one frame holds.
export fn relay_stream_max() usize {
    return frame.max_stream_data;
}

/// Writes in the exchange the frame opening stream `id` to the route named in the route area, `name_length` long; its
/// length.
export fn relay_write_open(id: u32, name_length: usize) usize {
    var writer: std.Io.Writer = .fixed(&exchange);
    frame.writeStreamOpen(&writer, id, route_name[0..name_length]) catch unreachable;
    return writer.buffered().len;
}

/// Writes the head of the frame of stream `id` around the `length` bytes the host put in the exchange; the frame's
/// length.
export fn relay_write_data(id: u32, length: usize) usize {
    exchange[0] = @backingInt(frame.Type.stream_data);
    std.mem.writeInt(u32, exchange[1..5], id, .big);
    return frame.stream_header + length;
}

/// Writes in the exchange the frame ending stream `id`; its length.
export fn relay_write_end(id: u32) usize {
    return writeSignal(.stream_end, id);
}

/// Writes in the exchange the frame giving up stream `id`; its length.
export fn relay_write_reset(id: u32) usize {
    return writeSignal(.stream_reset, id);
}

fn writeSignal(kind: frame.Type, id: u32) usize {
    var writer: std.Io.Writer = .fixed(&exchange);
    frame.writeStreamSignal(&writer, kind, id) catch unreachable;
    return writer.buffered().len;
}

/// Writes in the exchange the frame granting `grant` more bytes of stream `id`; its length.
export fn relay_write_window(id: u32, grant: u32) usize {
    var writer: std.Io.Writer = .fixed(&exchange);
    frame.writeStreamWindow(&writer, id, grant) catch unreachable;
    return writer.buffered().len;
}

/// Writes in the exchange the frame asking a machine to remove the route named in the route area, `name_length` long;
/// its length.
export fn relay_write_remove(name_length: usize) usize {
    var writer: std.Io.Writer = .fixed(&exchange);
    frame.writeRouteRemove(&writer, route_name[0..name_length]) catch unreachable;
    return writer.buffered().len;
}

/// Whether the route area holds a route's name, `name_length` long: 1, or 0.
export fn relay_valid_route(name_length: usize) u32 {
    return @intFromBool(name_length <= route_name.len and frame.isRouteName(route_name[0..name_length]));
}

/// Whether the key area holds a key's text: 1, or 0.
export fn relay_valid_key() u32 {
    _ = Key.parse(&key_text) catch return 0;
    return 1;
}

/// Writes in the exchange the challenge of the nonce; its length.
export fn relay_challenge() usize {
    var writer: std.Io.Writer = .fixed(&exchange);
    frame.writeChallenge(&writer, nonce) catch unreachable;
    return writer.buffered().len;
}

/// Whether the message in the exchange, `length` long, answers the challenge of the nonce that the relay at the host
/// name, `host_length` long, set, by the key whose text is in the key area: 1, or 0.
export fn relay_admit(length: usize, host_length: usize) u32 {
    const claimed = Key.parse(&key_text) catch return 0;
    const answer = switch (frame.decode(exchange[0..length]) catch return 0) {
        .answer => |answer| answer,
        else => return 0,
    };
    if (!answer.key.eql(claimed)) return 0;
    authentication.check(answer, host[0..host_length], nonce) catch return 0;
    return 1;
}

/// Writes in the exchange the frame telling a peer the relay took its answer; its length.
export fn relay_welcome() usize {
    var writer: std.Io.Writer = .fixed(&exchange);
    frame.writeWelcome(&writer) catch unreachable;
    return writer.buffered().len;
}

/// Takes the frame in the exchange, `length` long, that the peer whose key's text is in the key area sent: datagrams
/// for another peer are rewritten in place as from their sender, the addressee's key's text written in the key area,
/// and 1 given; anything else gives 0, which ends the sender's link.
export fn relay_forward(length: usize) u32 {
    const sender = Key.parse(&key_text) catch return 0;
    const bytes = exchange[0..length];
    const addressee = frame.addresseeOf(bytes) orelse return 0;
    frame.forwardFrom(bytes, sender);
    key_text = addressee.text();
    return 1;
}

/// Writes in the exchange the frame telling that the peer whose key's text is in the key area is not on the relay; its
/// length.
export fn relay_gone() usize {
    const key = Key.parse(&key_text) catch return 0;
    var writer: std.Io.Writer = .fixed(&exchange);
    frame.writeGone(&writer, key) catch unreachable;
    return writer.buffered().len;
}

const testing = std.testing;

fn give(bytes: []const u8) usize {
    @memcpy(exchange[0..bytes.len], bytes);
    return bytes.len;
}

test "a peer's answer admits it by the key it claimed, at the relay and for the challenge it answered" {
    const identity = Identity.generate(testing.io);
    nonce = authentication.nonce(testing.io);
    const name = "relay.octoii.dev";
    @memcpy(host[0..name.len], name);
    key_text = identity.publicKey().text();
    try testing.expect(relay_challenge() == 1 + frame.nonce_length);
    var buffer: [256]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&buffer);
    try frame.writeAnswer(&writer, try authentication.answer(identity, name, nonce));
    const answer = writer.buffered();
    try testing.expectEqual(1, relay_admit(give(answer), name.len));
    key_text = Identity.generate(testing.io).publicKey().text();
    try testing.expectEqual(0, relay_admit(give(answer), name.len));
    key_text = identity.publicKey().text();
    try testing.expectEqual(0, relay_admit(give(answer), name.len - 1));
}

test "a peer's datagrams are forwarded as from it, to the key they name; anything else is refused" {
    const sender: Key = .{ .bytes = @splat(1) };
    const addressee: Key = .{ .bytes = @splat(2) };
    var buffer: [64]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&buffer);
    _ = try frame.writeDatagrams(&writer, addressee, &.{"hello"});
    const length = give(writer.buffered());
    key_text = sender.text();
    try testing.expectEqual(1, relay_forward(length));
    try testing.expectEqualStrings(&addressee.text(), &key_text);
    try testing.expect((try frame.decode(exchange[0..length])).datagrams.key.eql(sender));
    key_text = sender.text();
    try testing.expectEqual(0, relay_forward(relay_welcome()));
}

test "the gone frame names the key in the key area" {
    const absent: Key = .{ .bytes = @splat(3) };
    key_text = absent.text();
    try testing.expect((try frame.decode(exchange[0..relay_gone()])).gone.eql(absent));
    try testing.expectEqual(1, relay_valid_key());
    key_text[0] = '!';
    try testing.expectEqual(0, relay_valid_key());
}
