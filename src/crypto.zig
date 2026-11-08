//! The crypto the tunnel's QUIC runs on, which picotls asks of a provider, on std.crypto: X25519 key exchange; the
//! AEADs AES-128-GCM and ChaCha20-Poly1305 of the cipher suites TLS_AES_128_GCM_SHA256 and
//! TLS_CHACHA20_POLY1305_SHA256, each with the stream cipher QUIC protects headers with, AES-128 in counter mode and
//! ChaCha20; SHA-256; and randomness, the host's io. picotls's descriptions of them are `crypto.c`'s.
const std = @import("std");
const c = @import("quic");
const host = @import("host.zig");
const allocation = @import("allocation.zig");

const Sha256 = std.crypto.hash.sha2.Sha256;
const X25519 = std.crypto.dh.X25519;
const Aes128 = std.crypto.core.aes.Aes128;
const Aes128Gcm = std.crypto.aead.aes_gcm.Aes128Gcm;
const ChaCha20 = std.crypto.stream.chacha.ChaCha20IETF;
const ChaCha20Poly1305 = std.crypto.aead.chacha_poly.ChaCha20Poly1305;

export fn octoii_tunnel_random_bytes(buffer: ?*anyopaque, length: usize) void {
    if (length == 0) return;
    host.current().io.random(@as([*]u8, @ptrCast(buffer.?))[0..length]);
}

// SHA-256: a context the tunnel allocates and frees itself, as picotls only holds what `create` gives it.

const Hash = struct {
    base: c.ptls_hash_context_t,
    state: Sha256,
};

export fn octoii_tunnel_sha256_create() ?*c.ptls_hash_context_t {
    const hash = allocation.create(Hash) orelse return null;
    hash.* = .{ .base = .{ .update = hashUpdate, .final = hashFinal, .clone_ = hashClone }, .state = .init(.{}) };
    return &hash.base;
}

fn hashOf(context: [*c]c.ptls_hash_context_t) *Hash {
    return @alignCast(@fieldParentPtr("base", @as(*c.ptls_hash_context_t, context)));
}

fn hashUpdate(context: [*c]c.ptls_hash_context_t, source: ?*const anyopaque, length: usize) callconv(.c) void {
    if (length == 0) return;
    hashOf(context).state.update(@as([*]const u8, @ptrCast(source.?))[0..length]);
}

fn hashFinal(context: [*c]c.ptls_hash_context_t, digest: ?*anyopaque, mode: c.ptls_hash_final_mode_t) callconv(.c) void {
    const hash = hashOf(context);
    switch (mode) {
        c.PTLS_HASH_FINAL_MODE_SNAPSHOT => {
            var copy = hash.state;
            copy.final(@ptrCast(digest.?));
        },
        c.PTLS_HASH_FINAL_MODE_RESET => {
            hash.state.final(@ptrCast(digest.?));
            hash.state = .init(.{});
        },
        else => {
            if (digest) |out| hash.state.final(@ptrCast(out));
            std.crypto.secureZero(u8, std.mem.asBytes(&hash.state));
            allocation.destroy(hash);
        },
    }
}

fn hashClone(context: [*c]c.ptls_hash_context_t) callconv(.c) [*c]c.ptls_hash_context_t {
    const copy = allocation.create(Hash) orelse return null;
    copy.* = hashOf(context).*;
    return &copy.base;
}

// The stream ciphers: contexts picotls allocates, laid out in `crypto.h`.

const StreamCipher = c.struct_octoii_tunnel_stream_cipher;

fn streamCipherOf(context: [*c]c.ptls_cipher_context_t) *StreamCipher {
    return @ptrCast(@alignCast(context));
}

export fn octoii_tunnel_stream_cipher_setup_aes128(context: [*c]c.ptls_cipher_context_t, is_enc: c_int, key: ?*const anyopaque) c_int {
    _ = is_enc;
    const cipher = streamCipherOf(context);
    @memcpy(cipher.key[0 .. Aes128.key_bits / 8], @as([*]const u8, @ptrCast(key.?)));
    cipher.base.do_dispose = disposeStreamCipher;
    cipher.base.do_init = initStreamCipher;
    cipher.base.do_transform = transformAes128;
    return 0;
}

export fn octoii_tunnel_stream_cipher_setup_chacha20(context: [*c]c.ptls_cipher_context_t, is_enc: c_int, key: ?*const anyopaque) c_int {
    _ = is_enc;
    const cipher = streamCipherOf(context);
    @memcpy(cipher.key[0..ChaCha20.key_length], @as([*]const u8, @ptrCast(key.?)));
    cipher.base.do_dispose = disposeStreamCipher;
    cipher.base.do_init = initStreamCipher;
    cipher.base.do_transform = transformChaCha20;
    return 0;
}

fn disposeStreamCipher(context: [*c]c.ptls_cipher_context_t) callconv(.c) void {
    const cipher = streamCipherOf(context);
    std.crypto.secureZero(u8, &cipher.key);
    std.crypto.secureZero(u8, &cipher.keystream);
}

/// Starts the keystream at the counter block `iv`: AES-128's, or ChaCha20's counter and nonce.
fn initStreamCipher(context: [*c]c.ptls_cipher_context_t, iv: ?*const anyopaque) callconv(.c) void {
    const cipher = streamCipherOf(context);
    @memcpy(&cipher.counter, @as([*]const u8, @ptrCast(iv.?))[0..16]);
    cipher.available = 0;
}

fn transformAes128(context: [*c]c.ptls_cipher_context_t, output: ?*anyopaque, input: ?*const anyopaque, length: usize) callconv(.c) void {
    const cipher = streamCipherOf(context);
    const aes = Aes128.initEnc(cipher.key[0 .. Aes128.key_bits / 8].*);
    const out: [*]u8 = @ptrCast(output orelse return);
    const in: [*]const u8 = @ptrCast(input orelse return);
    for (0..length) |index| {
        if (cipher.available == 0) {
            aes.encrypt(cipher.keystream[0..16], &cipher.counter);
            std.mem.writeInt(u128, &cipher.counter, std.mem.readInt(u128, &cipher.counter, .big) +% 1, .big);
            cipher.available = 16;
        }
        out[index] = in[index] ^ cipher.keystream[16 - cipher.available];
        cipher.available -= 1;
    }
}

fn transformChaCha20(context: [*c]c.ptls_cipher_context_t, output: ?*anyopaque, input: ?*const anyopaque, length: usize) callconv(.c) void {
    const cipher = streamCipherOf(context);
    const out: [*]u8 = @ptrCast(output orelse return);
    const in: [*]const u8 = @ptrCast(input orelse return);
    for (0..length) |index| {
        if (cipher.available == 0) {
            const counter = std.mem.readInt(u32, cipher.counter[0..4], .little);
            ChaCha20.stream(&cipher.keystream, counter, cipher.key, cipher.counter[4..16].*);
            std.mem.writeInt(u32, cipher.counter[0..4], counter +% 1, .little);
            cipher.available = cipher.keystream.len;
        }
        out[index] = in[index] ^ cipher.keystream[cipher.keystream.len - cipher.available];
        cipher.available -= 1;
    }
}

// The AEADs: contexts picotls allocates, laid out in `crypto.h`; each record's nonce the static IV with the record's
// sequence number laid over its last eight bytes, as TLS 1.3 and QUIC make it.

const Aead = c.struct_octoii_tunnel_aead;

fn aeadOf(context: [*c]c.ptls_aead_context_t) *Aead {
    return @ptrCast(@alignCast(context));
}

export fn octoii_tunnel_aead_setup_aes128gcm(context: [*c]c.ptls_aead_context_t, is_enc: c_int, key: ?*const anyopaque, iv: ?*const anyopaque) c_int {
    _ = is_enc;
    setUpAead(Aes128Gcm, aeadOf(context), key.?, iv.?);
    return 0;
}

export fn octoii_tunnel_aead_setup_chacha20poly1305(context: [*c]c.ptls_aead_context_t, is_enc: c_int, key: ?*const anyopaque, iv: ?*const anyopaque) c_int {
    _ = is_enc;
    setUpAead(ChaCha20Poly1305, aeadOf(context), key.?, iv.?);
    return 0;
}

fn setUpAead(comptime Algorithm: type, aead: *Aead, key: *const anyopaque, iv: *const anyopaque) void {
    @memcpy(aead.key[0..Algorithm.key_length], @as([*]const u8, @ptrCast(key)));
    @memcpy(&aead.iv, @as([*]const u8, @ptrCast(iv))[0..Algorithm.nonce_length]);
    aead.base.dispose_crypto = disposeAead;
    aead.base.do_get_iv = getIv;
    aead.base.do_set_iv = setIv;
    aead.base.do_encrypt_init = null;
    aead.base.do_encrypt_update = null;
    aead.base.do_encrypt_final = null;
    aead.base.do_encrypt = Sealing(Algorithm).encrypt;
    aead.base.do_encrypt_v = Sealing(Algorithm).encryptGathered;
    aead.base.do_decrypt = Sealing(Algorithm).decrypt;
}

fn disposeAead(context: [*c]c.ptls_aead_context_t) callconv(.c) void {
    std.crypto.secureZero(u8, &aeadOf(context).key);
}

fn getIv(context: [*c]c.ptls_aead_context_t, iv: ?*anyopaque) callconv(.c) void {
    @memcpy(@as([*]u8, @ptrCast(iv.?))[0..12], &aeadOf(context).iv);
}

fn setIv(context: [*c]c.ptls_aead_context_t, iv: ?*const anyopaque) callconv(.c) void {
    @memcpy(&aeadOf(context).iv, @as([*]const u8, @ptrCast(iv.?))[0..12]);
}

fn nonceOf(aead: *const Aead, sequence: u64) [12]u8 {
    var nonce = aead.iv;
    const tail = std.mem.readInt(u64, nonce[4..12], .big) ^ sequence;
    std.mem.writeInt(u64, nonce[4..12], tail, .big);
    return nonce;
}

fn bytesOf(pointer: ?*const anyopaque, length: usize) []const u8 {
    return if (length == 0) &.{} else @as([*]const u8, @ptrCast(pointer.?))[0..length];
}

/// An AEAD's sealing and opening, as picotls calls them.
fn Sealing(comptime Algorithm: type) type {
    return struct {
        const tag_length = Algorithm.tag_length;

        /// Seals `input` into `output`, its tag after it; then, where QUIC asks, the supplementary block, which may
        /// read what was sealed.
        fn encrypt(context: [*c]c.ptls_aead_context_t, output: ?*anyopaque, input: ?*const anyopaque, length: usize, sequence: u64, aad: ?*const anyopaque, aad_length: usize, supplementary: [*c]c.ptls_aead_supplementary_encryption_t) callconv(.c) void {
            var vector: c.ptls_iovec_t = .{ .base = @ptrCast(@constCast(input)), .len = length };
            encryptGathered(context, output, &vector, 1, sequence, aad, aad_length);
            if (supplementary) |block| {
                block.*.ctx.*.do_init.?(block.*.ctx, block.*.input);
                @memset(&block.*.output, 0);
                block.*.ctx.*.do_transform.?(block.*.ctx, &block.*.output, &block.*.output, block.*.output.len);
            }
        }

        /// Seals the parts of `input`, gathered in order into `output`, its tag after them.
        fn encryptGathered(context: [*c]c.ptls_aead_context_t, output: ?*anyopaque, input: [*c]c.ptls_iovec_t, count: usize, sequence: u64, aad: ?*const anyopaque, aad_length: usize) callconv(.c) void {
            const aead = aeadOf(context);
            const out: [*]u8 = @ptrCast(output.?);
            var length: usize = 0;
            for (input[0..count]) |part| {
                @memmove(out[length..][0..part.len], bytesOf(part.base, part.len));
                length += part.len;
            }
            Algorithm.encrypt(out[0..length], out[length..][0..tag_length], out[0..length], bytesOf(aad, aad_length), nonceOf(aead, sequence), aead.key[0..Algorithm.key_length].*);
        }

        /// Opens `input`, its tag at its end, into `output`; how many bytes it opened, or the most a size can be where
        /// the tag does not hold.
        fn decrypt(context: [*c]c.ptls_aead_context_t, output: ?*anyopaque, input: ?*const anyopaque, length: usize, sequence: u64, aad: ?*const anyopaque, aad_length: usize) callconv(.c) usize {
            if (length < tag_length) return std.math.maxInt(usize);
            const aead = aeadOf(context);
            const sealed = bytesOf(input, length);
            const opened = sealed.len - tag_length;
            const out: [*]u8 = @ptrCast(output.?);
            Algorithm.decrypt(out[0..opened], sealed[0..opened], sealed[opened..][0..tag_length].*, bytesOf(aad, aad_length), nonceOf(aead, sequence), aead.key[0..Algorithm.key_length].*) catch return std.math.maxInt(usize);
            return opened;
        }
    };
}

// X25519: a context the tunnel allocates and frees itself, as picotls only holds what `create` gives it; each secret
// it gives is freed by picotls with the C library's `free`, which `allocation` takes.

const KeyExchange = struct {
    base: c.ptls_key_exchange_context_t,
    secret_key: [X25519.secret_length]u8,
    public_key: [X25519.public_length]u8,
};

export fn octoii_tunnel_x25519_create(algorithm: ?*const c.ptls_key_exchange_algorithm_t, out: [*c][*c]c.ptls_key_exchange_context_t) c_int {
    const exchange = allocation.create(KeyExchange) orelse return c.PTLS_ERROR_NO_MEMORY;
    const pair = X25519.KeyPair.generate(host.current().io);
    exchange.* = .{ .base = .{ .algo = algorithm, .pubkey = undefined, .on_exchange = onExchange }, .secret_key = pair.secret_key, .public_key = pair.public_key };
    exchange.base.pubkey = .{ .base = &exchange.public_key, .len = exchange.public_key.len };
    out.* = &exchange.base;
    return 0;
}

fn onExchange(context: [*c][*c]c.ptls_key_exchange_context_t, release: c_int, secret: [*c]c.ptls_iovec_t, peer_key: c.ptls_iovec_t) callconv(.c) c_int {
    const exchange: *KeyExchange = @alignCast(@fieldParentPtr("base", @as(*c.ptls_key_exchange_context_t, context.*)));
    const result = if (secret) |out| derive(out, exchange.secret_key, peer_key) else 0;
    if (release != 0) {
        std.crypto.secureZero(u8, &exchange.secret_key);
        allocation.destroy(exchange);
        context.* = null;
    }
    return result;
}

export fn octoii_tunnel_x25519_exchange(algorithm: ?*const c.ptls_key_exchange_algorithm_t, public_out: [*c]c.ptls_iovec_t, secret_out: [*c]c.ptls_iovec_t, peer_key: c.ptls_iovec_t) c_int {
    _ = algorithm;
    var pair = X25519.KeyPair.generate(host.current().io);
    defer std.crypto.secureZero(u8, &pair.secret_key);
    const public_key = allocation.allocate(pair.public_key.len, 16) orelse return c.PTLS_ERROR_NO_MEMORY;
    const result = derive(secret_out, pair.secret_key, peer_key);
    if (result != 0) {
        allocation.free(public_key);
        return result;
    }
    @memcpy(public_key[0..pair.public_key.len], &pair.public_key);
    public_out.* = .{ .base = public_key, .len = pair.public_key.len };
    return 0;
}

/// The secret `secret_key` shares with `peer_key`, given in `out`; an alert where the peer's key is no X25519 key or
/// one of low order.
fn derive(out: *c.ptls_iovec_t, secret_key: [X25519.secret_length]u8, peer_key: c.ptls_iovec_t) c_int {
    if (peer_key.len != X25519.public_length) return c.PTLS_ALERT_DECRYPT_ERROR;
    var shared = X25519.scalarmult(secret_key, peer_key.base[0..X25519.public_length].*) catch return c.PTLS_ERROR_INCOMPATIBLE_KEY;
    defer std.crypto.secureZero(u8, &shared);
    const bytes = allocation.allocate(shared.len, 16) orelse return c.PTLS_ERROR_NO_MEMORY;
    @memcpy(bytes[0..shared.len], &shared);
    out.* = .{ .base = bytes, .len = shared.len };
    return 0;
}

const testing = std.testing;

fn hex(comptime text: []const u8) [text.len / 2]u8 {
    var bytes: [text.len / 2]u8 = undefined;
    _ = std.fmt.hexToBytes(&bytes, text) catch unreachable;
    return bytes;
}

fn enterTesting(testing_host: *host.Host) ?*const host.Host {
    testing_host.* = .{ .allocator = testing.allocator, .io = testing.io };
    return host.enter(testing_host);
}

fn testedCipher(comptime setup: anytype, key: []const u8) !StreamCipher {
    var cipher: StreamCipher = std.mem.zeroes(StreamCipher);
    try testing.expectEqual(0, setup(&cipher.base, 1, key.ptr));
    return cipher;
}

fn maskOf(cipher: *StreamCipher, sample: [16]u8) [5]u8 {
    var mask: [5]u8 = @splat(0);
    cipher.base.do_init.?(&cipher.base, &sample);
    cipher.base.do_transform.?(&cipher.base, &mask, &mask, mask.len);
    return mask;
}

/// A header's mask as a QUIC version's RFC gives it: its header protection key, the sample of its packet, the mask.
const Masking = struct { key: []const u8, sample: [16]u8, mask: [5]u8 };

test "AES-128 in counter mode masks the client Initial of RFC 9001 (QUIC v1) and RFC 9369 (QUIC v2)" {
    for ([_]Masking{
        .{ .key = &hex("9f50449e04a0e810283a1e9933adedd2"), .sample = hex("d1b1c98dd7689fb8ec11d242b123dc9b"), .mask = hex("437b9aec36") },
        .{ .key = &hex("45b95e15235d6f45a6b19cbcb0294ba9"), .sample = hex("ffe67b6abcdb4298b485dd04de806071"), .mask = hex("94a0c95e80") },
    }) |masking| {
        var cipher = try testedCipher(octoii_tunnel_stream_cipher_setup_aes128, masking.key);
        try testing.expectEqualSlices(u8, &masking.mask, &maskOf(&cipher, masking.sample));
    }
}

test "ChaCha20 masks the short header packet of RFC 9001 (QUIC v1) and RFC 9369 (QUIC v2)" {
    for ([_]Masking{
        .{ .key = &hex("25a282b9e82f06f21f488917a4fc8f1b73573685608597d0efcb076b0ab7a7a4"), .sample = hex("5e5cd55c41f69080575d7999c25a5bfb"), .mask = hex("aefefe7d03") },
        .{ .key = &hex("d659760d2ba434a226fd37b35c69e2da8211d10c4f12538787d65645d5d1b8e2"), .sample = hex("e7b6b932bc27d786f4bc2bb20f2162ba"), .mask = hex("97580e32bf") },
    }) |masking| {
        var cipher = try testedCipher(octoii_tunnel_stream_cipher_setup_chacha20, masking.key);
        try testing.expectEqualSlices(u8, &masking.mask, &maskOf(&cipher, masking.sample));
    }
}

test "a stream cipher's keystream runs on across its calls as one call's would" {
    var whole = try testedCipher(octoii_tunnel_stream_cipher_setup_chacha20, &@as([32]u8, @splat(7)));
    var parts = try testedCipher(octoii_tunnel_stream_cipher_setup_chacha20, &@as([32]u8, @splat(7)));
    const iv: [16]u8 = @splat(3);
    var one: [150]u8 = @splat(0);
    var many: [150]u8 = @splat(0);
    whole.base.do_init.?(&whole.base, &iv);
    whole.base.do_transform.?(&whole.base, &one, &one, one.len);
    parts.base.do_init.?(&parts.base, &iv);
    for ([_][2]usize{ .{ 0, 5 }, .{ 5, 64 }, .{ 64, 70 }, .{ 70, 150 } }) |range| parts.base.do_transform.?(&parts.base, many[range[0]..].ptr, many[range[0]..].ptr, range[1] - range[0]);
    try testing.expectEqualSlices(u8, &one, &many);
}

fn testedAead(comptime setup: anytype, key: []const u8, iv: []const u8) !Aead {
    var aead: Aead = std.mem.zeroes(Aead);
    try testing.expectEqual(0, setup(&aead.base, 1, key.ptr, iv.ptr));
    return aead;
}

/// A sealing as a QUIC version's RFC gives it: the AEAD's key and IV, the record's sequence number, its associated
/// data and plaintext, and what they seal to, the tag at its end.
const Sealed = struct { key: []const u8, iv: [12]u8, sequence: u64, aad: []const u8, plaintext: []const u8, sealed: []const u8 };

fn expectSealing(comptime setup: anytype, sealings: []const Sealed) !void {
    for (sealings) |sealing| {
        var aead = try testedAead(setup, sealing.key, &sealing.iv);
        var out: [64]u8 = undefined;
        aead.base.do_encrypt.?(&aead.base, &out, sealing.plaintext.ptr, sealing.plaintext.len, sealing.sequence, sealing.aad.ptr, sealing.aad.len, null);
        try testing.expectEqualSlices(u8, sealing.sealed, out[0..sealing.sealed.len]);
    }
}

test "ChaCha20-Poly1305 seals the short header packet of RFC 9001 (QUIC v1) and RFC 9369 (QUIC v2), its nonce the IV with the packet number laid over it" {
    try expectSealing(octoii_tunnel_aead_setup_chacha20poly1305, &.{
        .{ .key = &hex("c6d98ff3441c3fe1b2182094f69caa2ed4b716b65488960a7a984979fb23e1c8"), .iv = hex("e0459b3474bdd0e44a41c144"), .sequence = 654360564, .aad = &hex("4200bff4"), .plaintext = &hex("01"), .sealed = &hex("655e5cd55c41f69080575d7999c25a5bfb") },
        .{ .key = &hex("3bfcddd72bcf02541d7fa0dd1f5f9eeea817e09a6963a0e6c7df0f9a1bab90f2"), .iv = hex("a6b5bc6ab7dafce30ffff5dd"), .sequence = 654360564, .aad = &hex("4200bff4"), .plaintext = &hex("01"), .sealed = &hex("0ae7b6b932bc27d786f4bc2bb20f2162ba") },
    });
}

test "AES-128-GCM seals the Retry integrity tag of RFC 9001 (QUIC v1) and RFC 9369 (QUIC v2)" {
    try expectSealing(octoii_tunnel_aead_setup_aes128gcm, &.{
        .{ .key = &hex("be0c690b9f66575a1d766b54e368c84e"), .iv = hex("461599d35d632bf2239825bb"), .sequence = 0, .aad = &hex("088394c8f03e515708ff000000010008f067a5502a4262b5746f6b656e"), .plaintext = &.{}, .sealed = &hex("04a265ba2eff4d829058fb3f0f2496ba") },
        .{ .key = &hex("8fb4b01b56ac48e260fbcbcead7ccc92"), .iv = hex("d86969bc2d7c6d9990efb04a"), .sequence = 0, .aad = &hex("088394c8f03e515708cf6b3343cf0008f067a5502a4262b5746f6b656e"), .plaintext = &.{}, .sealed = &hex("c8646ce8bfe33952d955543665dcc7b6") },
    });
}

test "an AEAD opens in place what it sealed, and refuses it with a byte changed" {
    inline for (.{ octoii_tunnel_aead_setup_aes128gcm, octoii_tunnel_aead_setup_chacha20poly1305 }) |setup| {
        var aead = try testedAead(setup, &@as([32]u8, @splat(1)), &@as([12]u8, @splat(2)));
        var packet: [5 + 16]u8 = undefined;
        @memcpy(packet[0..5], "hello");
        aead.base.do_encrypt.?(&aead.base, &packet, &packet, 5, 9, "head", 4, null);
        var changed = packet;
        changed[2] ^= 1;
        try testing.expectEqual(5, aead.base.do_decrypt.?(&aead.base, &packet, &packet, packet.len, 9, "head", 4));
        try testing.expectEqualStrings("hello", packet[0..5]);
        try testing.expectEqual(std.math.maxInt(usize), aead.base.do_decrypt.?(&aead.base, &changed, &changed, changed.len, 9, "head", 4));
        try testing.expectEqual(std.math.maxInt(usize), aead.base.do_decrypt.?(&aead.base, &changed, &changed, 10, 9, "head", 4));
    }
}

test "SHA-256's context snapshots, resets, clones and frees as picotls asks" {
    var testing_host: host.Host = undefined;
    const before = enterTesting(&testing_host);
    defer host.leave(before);
    const hash = octoii_tunnel_sha256_create().?;
    hash.*.update.?(hash, "oct", 3);
    const copy = hash.*.clone_.?(hash);
    var digest: [32]u8 = undefined;
    hash.*.final.?(hash, &digest, c.PTLS_HASH_FINAL_MODE_SNAPSHOT);
    var begun: [32]u8 = undefined;
    Sha256.hash("oct", &begun, .{});
    try testing.expectEqualSlices(u8, &begun, &digest);
    hash.*.update.?(hash, "oii", 3);
    hash.*.final.?(hash, &digest, c.PTLS_HASH_FINAL_MODE_RESET);
    var expected: [32]u8 = undefined;
    Sha256.hash("octoii", &expected, .{});
    try testing.expectEqualSlices(u8, &expected, &digest);
    hash.*.final.?(hash, &digest, c.PTLS_HASH_FINAL_MODE_FREE);
    try testing.expectEqualSlices(u8, &hex("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"), &digest);
    copy.*.update.?(copy, "oii", 3);
    copy.*.final.?(copy, &digest, c.PTLS_HASH_FINAL_MODE_FREE);
    try testing.expectEqualSlices(u8, &expected, &digest);
}

test "X25519's two sides come to one secret, and refuse a peer key of the wrong length" {
    var testing_host: host.Host = undefined;
    const before = enterTesting(&testing_host);
    defer host.leave(before);
    var client: [*c]c.ptls_key_exchange_context_t = null;
    try testing.expectEqual(0, octoii_tunnel_x25519_create(null, &client));
    var server_public: c.ptls_iovec_t = undefined;
    var server_secret: c.ptls_iovec_t = undefined;
    try testing.expectEqual(0, octoii_tunnel_x25519_exchange(null, &server_public, &server_secret, client.*.pubkey));
    var client_secret: c.ptls_iovec_t = undefined;
    try testing.expectEqual(0, client.*.on_exchange.?(&client, 1, &client_secret, server_public));
    try testing.expectEqual(null, client);
    try testing.expectEqualSlices(u8, server_secret.base[0..server_secret.len], client_secret.base[0..client_secret.len]);
    for ([_]c.ptls_iovec_t{ server_public, server_secret, client_secret }) |bytes| allocation.free(bytes.base);
    var short: c.ptls_iovec_t = .{ .base = server_public.base, .len = 31 };
    try testing.expectEqual(c.PTLS_ALERT_DECRYPT_ERROR, octoii_tunnel_x25519_exchange(null, &server_public, &server_secret, short));
    _ = &short;
}
