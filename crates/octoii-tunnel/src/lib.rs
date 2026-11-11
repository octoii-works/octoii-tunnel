//! Octoii's tunnel: a machine and the devices that reach it, each known by its key, wherever each is. A machine waits at
//! its home relay; a device dials it there by its key, and the session moves to a direct path where the two can reach
//! each other, the relay kept as the path to fall back to. Between them, HTTP/3: the machine serves its HTTP service to
//! every device that reaches it, each request knowing the key of the device that sent it, and a WebSocket is a request
//! of extended CONNECT (RFC 9220) whose stream is handed over once answered.

#[cfg(not(target_family = "wasm"))]
pub mod ice;
#[cfg(not(target_family = "wasm"))]
pub mod key;
mod peer;
mod serve;
pub mod socket;
mod stream;
mod tunnel;

pub use net::tls::CaTlsConfig;
pub use net::{EndpointAddr, PublicKey, RelayConfig, RelayUrl, SecretKey};
pub use peer::{Path, Peer, PeerError, Via};
pub use serve::{Body, OnConnect, Remote};
pub use socket::Socket;
pub use stream::Stream;
pub use tokio_tungstenite::tungstenite::Message;
pub use tunnel::{ALPN, Builder, STUN_SERVER, Tunnel, TunnelError};
