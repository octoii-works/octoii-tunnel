# octoii-tunnel

Sessions between a person's devices and their machines, end to end encrypted by their keys: QUIC with multipath over a
relay, direct paths and ICE through NATs, speaking HTTP/3, in Rust.

- `crates/octoii-tunnel` — a place on the tunnel: dial and serve by key, requests and WebSockets over HTTP/3, ICE.
- `crates/octoii-relay` — the relay as a Cloudflare Worker, a Durable Object per machine.
- `crates/octoii-tunnel-wasm` — the tunnel in a browser, as WebAssembly.

`cargo test` runs the tests; CI also checks formatting and clippy's lints, natively and for `wasm32-unknown-unknown`.
