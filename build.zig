//! Builds the tunnel: `zig build check` is its gate — its sources formatted, its tests run — and `zig build test` runs
//! the tests alone. Its QUIC is picoquic over picotls, compiled from their sources; their crypto is the tunnel's own, on
//! std.crypto, and all they allocate comes from the tunnel's allocator.
const std = @import("std");
const Translator = @import("translate_c").Translator;

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const picoquic = b.dependency("picoquic", .{});
    const picotls = b.dependency("picotls", .{});

    const quic = quicLibrary(b, picoquic, picotls, target);
    const header: Translator = .init(b.dependency("translate_c", .{}), .{ .name = "quic", .c_source_file = b.path("src/quic.h"), .target = target, .optimize = optimize });
    withQuicIncludes(b, header, picoquic, picotls, target);

    const tunnel = b.addModule("tunnel", .{ .root_source_file = b.path("src/root.zig"), .target = target, .optimize = optimize, .link_libc = true, .imports = &.{.{ .name = "quic", .module = header.mod }} });
    tunnel.linkLibrary(quic);

    // The tests, on a module of their own that also knows the relay a test may be pointed at (`-Drelay`), which the
    // stations' tests then reach as well as their own on the loopback.
    const test_options = b.addOptions();
    test_options.addOption(?[]const u8, "relay", b.option([]const u8, "relay", "A relay's address for the stations' tests to reach, as ws://host:port"));
    const tested = b.createModule(.{ .root_source_file = b.path("src/root.zig"), .target = target, .optimize = optimize, .link_libc = true, .imports = &.{
        .{ .name = "quic", .module = header.mod },
        .{ .name = "test_options", .module = test_options.createModule() },
    } });
    tested.linkLibrary(quic);
    const tests = b.addTest(.{ .root_module = tested });
    const run_tests = b.addRunArtifact(tests);
    const test_step = b.step("test", "Run the tunnel's tests");
    test_step.dependOn(&run_tests.step);

    // The relay on Cloudflare Workers: its WebAssembly module and the Worker and Durable Object that hold its links,
    // installed together in `relay/` and given to dependents as the path `relay-worker`.
    const relay_wasm = b.addExecutable(.{ .name = "relay", .root_module = b.createModule(.{
        .root_source_file = b.path("src/relay_wasm.zig"),
        .target = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .freestanding }),
        .optimize = .ReleaseSmall,
    }) });
    relay_wasm.entry = .disabled;
    relay_wasm.rdynamic = true;
    const relay_worker = b.addWriteFiles();
    _ = relay_worker.addCopyFile(relay_wasm.getEmittedBin(), "relay.wasm");
    _ = relay_worker.addCopyFile(b.path("src/relay/worker.js"), "worker.js");
    _ = relay_worker.addCopyFile(b.path("src/relay/worker.d.ts"), "worker.d.ts");
    b.addNamedLazyPath("relay-worker", relay_worker.getDirectory());
    const install_relay_worker = b.addInstallDirectory(.{ .source_dir = relay_worker.getDirectory(), .install_dir = .prefix, .install_subdir = "relay" });
    b.step("relay-worker", "Build the relay for Cloudflare Workers into relay/").dependOn(&install_relay_worker.step);

    // The session for a browser: picoquic and picotls compiled for WebAssembly.
    const wasm_target = b.resolveTargetQuery(.{ .cpu_arch = .wasm32, .os_tag = .wasi });
    const wasm_header: Translator = .init(b.dependency("translate_c", .{}), .{ .name = "quic", .c_source_file = b.path("src/quic.h"), .target = wasm_target, .optimize = .ReleaseSmall });
    withQuicIncludes(b, wasm_header, picoquic, picotls, wasm_target);
    // The C translator does not predefine it for WebAssembly, as a C compiler does; the C library's socket types need it.
    wasm_header.defineCMacro("__BIGGEST_ALIGNMENT__", "16");
    const session_wasm = b.addExecutable(.{ .name = "tunnel", .root_module = b.createModule(.{
        .root_source_file = b.path("src/tunnel_wasm.zig"),
        .target = wasm_target,
        .optimize = .ReleaseSmall,
        .link_libc = true,
        .imports = &.{.{ .name = "quic", .module = wasm_header.mod }},
    }) });
    session_wasm.root_module.linkLibrary(quicLibrary(b, picoquic, picotls, wasm_target));
    session_wasm.entry = .disabled;
    session_wasm.rdynamic = true;
    const page_client = b.addWriteFiles();
    _ = page_client.addCopyFile(session_wasm.getEmittedBin(), "tunnel.wasm");
    _ = page_client.addCopyFile(b.path("src/page/tunnel.js"), "tunnel.js");
    _ = page_client.addCopyFile(b.path("src/page/tunnel.d.ts"), "tunnel.d.ts");
    b.addNamedLazyPath("page-client", page_client.getDirectory());
    const install_page_client = b.addInstallDirectory(.{ .source_dir = page_client.getDirectory(), .install_dir = .prefix, .install_subdir = "page" });
    b.step("wasm", "Build the session for a browser into page/").dependOn(&install_page_client.step);

    const format = b.addFmt(.{ .paths = &.{ b.path("build.zig"), b.path("src") }, .check = true });
    const check_step = b.step("check", "Check the tunnel: its sources formatted and its tests passing");
    check_step.dependOn(&format.step);
    check_step.dependOn(&run_tests.step);
    check_step.dependOn(&install_relay_worker.step);
    check_step.dependOn(&install_page_client.step);
}

/// picoquic's transport, as its own build lists it, without what the tunnel does itself: the sockets and their loops, the
/// Linux packet paths, the simulated links, and the crypto providers, the tunnel's being on std.crypto.
const picoquic_sources = [_][]const u8{
    "picoquic/bbr.c",           "picoquic/bbr1.c",        "picoquic/bytestream.c",      "picoquic/cc_common.c",
    "picoquic/config.c",        "picoquic/cubic.c",       "picoquic/c4.c",              "picoquic/dualq_aqm.c",
    "picoquic/ech.c",           "picoquic/error_names.c", "picoquic/fastcc.c",          "picoquic/frames.c",
    "picoquic/frame_names.c",   "picoquic/intformat.c",   "picoquic/logger.c",          "picoquic/logwriter.c",
    "picoquic/loss_recovery.c", "picoquic/newreno.c",     "picoquic/pacing.c",          "picoquic/packet.c",
    "picoquic/packet_names.c",  "picoquic/paths.c",       "picoquic/performance_log.c", "picoquic/picohash.c",
    "picoquic/picoquic_lb.c",   "picoquic/picorbtree.c",  "picoquic/picosplay.c",       "picoquic/port_blocking.c",
    "picoquic/prague.c",        "picoquic/qmux.c",        "picoquic/quicctx.c",         "picoquic/register_all_cc_algorithms.c",
    "picoquic/sacks.c",         "picoquic/scone.c",       "picoquic/sender.c",          "picoquic/siphash.c",
    "picoquic/spinbit.c",       "picoquic/streams.c",     "picoquic/ticket_store.c",    "picoquic/timing.c",
    "picoquic/token_store.c",   "picoquic/tls_api.c",     "picoquic/tp_names.c",        "picoquic/transport.c",
    "picoquic/unified_log.c",   "picoquic/util.c",
};

/// picotls's core — its TLS 1.3, its HPKE and its PEM and base64 — and the ASN.1 reader picoquic's encrypted
/// ClientHello takes keys with, without its crypto backends.
const picotls_sources = [_][]const u8{ "lib/picotls.c", "lib/hpke.c", "lib/pembase64.c", "lib/asn1.c" };

/// What picoquic and picotls compile with: no crypto of their own — neither OpenSSL nor minicrypto, the tunnel's being
/// its own provider — no debug printing, and each call of the C library's allocation
/// functions taken over by a function-like macro, so all they allocate comes from the tunnel's allocator
/// (`src/allocation.zig`). The C library's declarations, read through the same macros, declare the tunnel's functions.
const quic_flags: []const []const u8 = &.{
    "-std=gnu11",
    "-fno-sanitize=undefined",
    "-DPTLS_WITHOUT_OPENSSL",
    "-DPICOQUIC_WITHOUT_MINICRYPTO",
    "-DDISABLE_DEBUG_PRINTF",
    "-Dmalloc(size)=octoii_tunnel_malloc(size)",
    "-Dcalloc(count,size)=octoii_tunnel_calloc(count,size)",
    "-Drealloc(pointer,size)=octoii_tunnel_realloc(pointer,size)",
    "-Dfree(pointer)=octoii_tunnel_free(pointer)",
    "-Dposix_memalign(pointer,alignment,size)=octoii_tunnel_posix_memalign(pointer,alignment,size)",
    "-D_aligned_malloc(size,alignment)=octoii_tunnel_aligned_malloc(size,alignment)",
    "-D_aligned_free(pointer)=octoii_tunnel_free(pointer)",
    "-Dstrdup(text)=octoii_tunnel_strdup(text)",
};

/// picoquic and picotls as a library, compiled optimized whatever the tunnel's own mode, so a Debug build runs no
/// unoptimized transport; with them the tunnel's C, `src/crypto.c`, picotls's descriptions of the tunnel's crypto.
fn quicLibrary(b: *std.Build, picoquic: *std.Build.Dependency, picotls: *std.Build.Dependency, target: std.Build.ResolvedTarget) *std.Build.Step.Compile {
    const module = b.createModule(.{ .target = target, .optimize = .fast, .link_libc = true });
    // picoquic and picotls know Windows by `_WINDOWS`, as their own Windows builds define it, and picotls takes its
    // Windows header from the folder of its Windows build.
    if (target.result.os.tag == .windows) {
        module.addCMacro("_WINDOWS", "1");
        module.addIncludePath(picotls.path("picotlsvs/picotls"));
        module.linkSystemLibrary("ws2_32", .{});
    }
    for ([_]std.Build.LazyPath{ picoquic.path("picoquic"), picoquic.path("loglib"), picotls.path("include") }) |path| module.addIncludePath(path);
    module.addCSourceFiles(.{ .root = picoquic.path(""), .files = &picoquic_sources, .flags = quic_flags });
    module.addCSourceFiles(.{ .root = picotls.path(""), .files = &picotls_sources, .flags = quic_flags });
    module.addIncludePath(b.path("src"));
    module.addCSourceFile(.{ .file = b.path("src/crypto.c"), .flags = quic_flags });
    return b.addLibrary(.{ .name = "quic", .linkage = .static, .root_module = module });
}

/// Gives the translation of `src/quic.h` the headers it includes, as picoquic is compiled.
fn withQuicIncludes(b: *std.Build, header: Translator, picoquic: *std.Build.Dependency, picotls: *std.Build.Dependency, target: std.Build.ResolvedTarget) void {
    if (target.result.os.tag == .windows) {
        header.defineCMacro("_WINDOWS", "1");
        header.addIncludePath(picotls.path("picotlsvs/picotls"));
    }
    header.addIncludePath(b.path("src"));
    header.addIncludePath(picoquic.path("picoquic"));
    header.addIncludePath(picotls.path("include"));
    header.defineCMacro("PTLS_WITHOUT_OPENSSL", null);
}
