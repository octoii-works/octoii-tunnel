//! HTTP's messages as HTTP/3 forms their heads (RFC 9114, section 4; RFC 9220, section 3): a field section whose
//! pseudo-fields come first — a request's method, scheme, authority, path and the protocol an extended CONNECT opens; a
//! response's status — each at most once, then the head's fields, each named in lowercase, none of the fields HTTP/1.1
//! keeps for its connection, no value holding a line's end. A head formed otherwise is malformed.
const std = @import("std");
const qpack = @import("qpack.zig");

const Field = std.http.Header;

/// A request's head, read from its field section, which its strings point into.
pub const RequestHead = struct {
    method: std.http.Method,
    /// The request's target, as `:path` tells it: its path and its query; empty for a CONNECT that opens no protocol.
    target: []const u8,
    scheme: ?[]const u8,
    authority: ?[]const u8,
    /// The protocol an extended CONNECT opens, as `:protocol` tells it.
    protocol: ?[]const u8,
    section: qpack.Section,

    /// The head's fields, its pseudo-fields left out.
    pub fn iterateHeaders(head: *const RequestHead) Fields {
        return .{ .lines = head.section.iterator() };
    }
};

/// A response's head, read from its field section, which its fields point into.
pub const ResponseHead = struct {
    status: std.http.Status,
    section: qpack.Section,

    /// The head's fields, its pseudo-field left out.
    pub fn iterateHeaders(head: *const ResponseHead) Fields {
        return .{ .lines = head.section.iterator() };
    }
};

/// A head's fields, its pseudo-fields left out.
pub const Fields = struct {
    lines: qpack.Section.Iterator,

    pub fn next(fields: *Fields) ?Field {
        while (fields.lines.next()) |field| {
            if (!isPseudo(field)) return field;
        }
        return null;
    }
};

/// What a head's form fails with.
pub const Error = error{
    /// The head is not formed as HTTP/3 forms one.
    MalformedMessage,
    /// The request's method is one HTTP has that the tunnel's HTTP/3 does not serve.
    UnknownMethod,
};

/// The request head `section` holds.
pub fn requestHeadOf(section: qpack.Section) Error!RequestHead {
    var method: ?[]const u8 = null;
    var scheme: ?[]const u8 = null;
    var authority: ?[]const u8 = null;
    var path: ?[]const u8 = null;
    var protocol: ?[]const u8 = null;
    var host = false;
    var lines = section.iterator();
    var pseudo = true;
    while (lines.next()) |field| {
        try checkField(field);
        if (!isPseudo(field)) {
            pseudo = false;
            host = host or std.mem.eql(u8, field.name, "host");
            continue;
        }
        if (!pseudo) return error.MalformedMessage;
        const named: *?[]const u8 = if (std.mem.eql(u8, field.name, ":method"))
            &method
        else if (std.mem.eql(u8, field.name, ":scheme"))
            &scheme
        else if (std.mem.eql(u8, field.name, ":authority"))
            &authority
        else if (std.mem.eql(u8, field.name, ":path"))
            &path
        else if (std.mem.eql(u8, field.name, ":protocol"))
            &protocol
        else
            return error.MalformedMessage;
        if (named.* != null) return error.MalformedMessage;
        named.* = field.value;
    }
    const name = method orelse return error.MalformedMessage;
    const known = std.meta.stringToEnum(std.http.Method, name);
    const connect = std.mem.eql(u8, name, "CONNECT");
    if (connect and protocol == null) {
        // A CONNECT to a host names it alone.
        if (scheme != null or path != null or authority == null) return error.MalformedMessage;
    } else {
        // An extended CONNECT is formed as any other request is, the protocol it opens named.
        if (protocol != null and !connect) return error.MalformedMessage;
        if (scheme == null or path == null or path.?.len == 0) return error.MalformedMessage;
        if (authority == null and !host) return error.MalformedMessage;
    }
    return .{
        .method = known orelse return error.UnknownMethod,
        .target = path orelse "",
        .scheme = scheme,
        .authority = authority,
        .protocol = protocol,
        .section = section,
    };
}

/// The response head `section` holds.
pub fn responseHeadOf(section: qpack.Section) Error!ResponseHead {
    var status: ?[]const u8 = null;
    var lines = section.iterator();
    var pseudo = true;
    while (lines.next()) |field| {
        try checkField(field);
        if (!isPseudo(field)) {
            pseudo = false;
            continue;
        }
        if (!pseudo or !std.mem.eql(u8, field.name, ":status") or status != null) return error.MalformedMessage;
        status = field.value;
    }
    const digits = status orelse return error.MalformedMessage;
    if (digits.len != 3) return error.MalformedMessage;
    const code = std.fmt.parseInt(u10, digits, 10) catch return error.MalformedMessage;
    // HTTP/3 switches no protocol.
    if (code < 100 or code == 101) return error.MalformedMessage;
    return .{ .status = @fromBackingInt(code), .section = section };
}

/// The field naming `status`, its digits in `buffer`.
pub fn statusField(buffer: *[3]u8, status: std.http.Status) Field {
    _ = std.fmt.bufPrint(buffer, "{d}", .{@backingInt(status)}) catch unreachable;
    return .{ .name = ":status", .value = buffer };
}

fn isPseudo(field: Field) bool {
    return field.name.len > 0 and field.name[0] == ':';
}

/// The fields HTTP/1.1 keeps for its connection, which HTTP/3 has no use for.
const connection_specific = [_][]const u8{ "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade" };

/// Checks a field as HTTP/3 forms one: a name of a token's characters in lowercase, none HTTP/1.1 keeps for its
/// connection, `te` only as `trailers`; a value holding no line's end.
fn checkField(field: Field) Error!void {
    if (std.mem.indexOfAny(u8, field.value, "\x00\r\n") != null) return error.MalformedMessage;
    const name = if (isPseudo(field)) field.name[1..] else field.name;
    if (name.len == 0) return error.MalformedMessage;
    for (name) |char| {
        if (std.ascii.isUpper(char) or !isTokenCharacter(char)) return error.MalformedMessage;
    }
    if (isPseudo(field)) return;
    for (connection_specific) |specific| {
        if (std.mem.eql(u8, name, specific)) return error.MalformedMessage;
    }
    if (std.mem.eql(u8, name, "te") and !std.mem.eql(u8, field.value, "trailers")) return error.MalformedMessage;
}

fn isTokenCharacter(char: u8) bool {
    return std.ascii.isAlphanumeric(char) or std.mem.indexOfScalar(u8, "!#$%&'*+-.^_`|~", char) != null;
}

const testing = std.testing;

fn sectionOf(buffer: []u8, fields: []const Field) !qpack.Section {
    var writer: std.Io.Writer = .fixed(buffer);
    try qpack.write(&writer, &.{fields});
    return qpack.Section.decode(writer.buffered());
}

test "a request's head reads its pseudo-fields, and its fields without them" {
    var buffer: [256]u8 = undefined;
    const head = try requestHeadOf(try sectionOf(&buffer, &.{
        .{ .name = ":method", .value = "POST" },
        .{ .name = ":scheme", .value = "https" },
        .{ .name = ":authority", .value = "machine" },
        .{ .name = ":path", .value = "/files?width_max=1" },
        .{ .name = "content-type", .value = "image/png" },
    }));
    try testing.expectEqual(std.http.Method.POST, head.method);
    try testing.expectEqualStrings("/files?width_max=1", head.target);
    try testing.expectEqualStrings("machine", head.authority.?);
    var fields = head.iterateHeaders();
    try testing.expectEqualStrings("content-type", fields.next().?.name);
    try testing.expectEqual(null, fields.next());
}

test "an extended CONNECT names the protocol it opens, as a request names its target" {
    var buffer: [256]u8 = undefined;
    const head = try requestHeadOf(try sectionOf(&buffer, &.{
        .{ .name = ":method", .value = "CONNECT" },
        .{ .name = ":protocol", .value = "websocket" },
        .{ .name = ":scheme", .value = "https" },
        .{ .name = ":authority", .value = "machine" },
        .{ .name = ":path", .value = "/ws" },
        .{ .name = "sec-websocket-version", .value = "13" },
    }));
    try testing.expectEqual(std.http.Method.CONNECT, head.method);
    try testing.expectEqualStrings("websocket", head.protocol.?);
    try testing.expectEqualStrings("/ws", head.target);
}

test "a head formed otherwise is malformed: pseudo-fields after fields, twice, unknown, missing, or fields of HTTP/1.1's connection" {
    var buffer: [256]u8 = undefined;
    const get: Field = .{ .name = ":method", .value = "GET" };
    const scheme: Field = .{ .name = ":scheme", .value = "https" };
    const path: Field = .{ .name = ":path", .value = "/" };
    const authority: Field = .{ .name = ":authority", .value = "machine" };
    const malformed = [_][]const Field{
        &.{ get, scheme, .{ .name = "accept", .value = "*/*" }, path, authority },
        &.{ get, get, scheme, path, authority },
        &.{ get, scheme, path, authority, .{ .name = ":status", .value = "200" } },
        &.{ get, path, authority },
        &.{ get, scheme, path },
        &.{ get, scheme, path, authority, .{ .name = "connection", .value = "keep-alive" } },
        &.{ get, scheme, path, authority, .{ .name = "te", .value = "gzip" } },
        &.{ get, scheme, path, authority, .{ .name = "x-line", .value = "one\r\ntwo" } },
        &.{ get, scheme, path, authority, .{ .name = ":protocol", .value = "websocket" } },
        &.{ .{ .name = ":method", .value = "CONNECT" }, scheme, authority },
    };
    for (malformed) |fields| try testing.expectError(error.MalformedMessage, requestHeadOf(try sectionOf(&buffer, fields)));
    try testing.expectError(error.UnknownMethod, requestHeadOf(try sectionOf(&buffer, &.{ .{ .name = ":method", .value = "PROPFIND" }, scheme, path, authority })));
}

test "a response's head reads its status; one of no status, of HTTP/1.1's switch, or of a request's pseudo-fields is malformed" {
    var buffer: [128]u8 = undefined;
    var digits: [3]u8 = undefined;
    const head = try responseHeadOf(try sectionOf(&buffer, &.{ statusField(&digits, .not_found), .{ .name = "content-length", .value = "0" } }));
    try testing.expectEqual(std.http.Status.not_found, head.status);
    try testing.expectError(error.MalformedMessage, responseHeadOf(try sectionOf(&buffer, &.{.{ .name = "content-length", .value = "0" }})));
    try testing.expectError(error.MalformedMessage, responseHeadOf(try sectionOf(&buffer, &.{.{ .name = ":status", .value = "101" }})));
    try testing.expectError(error.MalformedMessage, responseHeadOf(try sectionOf(&buffer, &.{ statusField(&digits, .ok), .{ .name = ":path", .value = "/" } })));
}
