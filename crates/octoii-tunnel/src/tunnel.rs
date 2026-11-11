//! A place on the tunnel: the endpoint of a key, at home on its relays, which dials and is dialled by keys alone — no
//! service outside is asked where a key is: a device knows the machine's key and relay from the pairing that gave them.

use net::endpoint::{BindError, ConnectError, presets};
use net::tls::CaTlsConfig;
use net::{Endpoint, EndpointAddr, PublicKey, RelayConfig, RelayMap, RelayMode, SecretKey};

use crate::peer::Peer;

/// The protocol the tunnel's sessions speak: HTTP/3.
pub const ALPN: &[u8] = b"h3";

/// The STUN server a place asks where its sockets are seen from outside, where it is told none.
pub const STUN_SERVER: &str = "stun.cloudflare.com:3478";

/// A place on the tunnel, and its ICE where it has its own sockets.
#[derive(Debug, Clone)]
pub struct Tunnel {
    pub(crate) endpoint: Endpoint,
    #[cfg(not(target_family = "wasm"))]
    pub(crate) ice: crate::ice::Ice,
}

/// Why a place on the tunnel was not had, or a peer not reached.
#[derive(Debug, thiserror::Error)]
pub enum TunnelError {
    #[error(transparent)]
    Bind(#[from] BindError),
    #[error(transparent)]
    Connect(#[from] ConnectError),
    #[error(transparent)]
    Http(#[from] h3::error::ConnectionError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// What a place on the tunnel is built of: its key, its relays — each by its address, and whether it tells a client
/// its public address over QUIC, as a relay on a machine of its own does and one on Workers cannot — and the
/// authorities whose certificates of relays it trusts.
#[derive(Debug)]
pub struct Builder {
    key: SecretKey,
    relays: Vec<RelayConfig>,
    trust: Option<CaTlsConfig>,
    direct: bool,
    stun: Vec<String>,
}

impl Builder {
    /// At home on the nearest of `relays`; reached directly alone, where none.
    #[must_use]
    pub fn relays(mut self, relays: Vec<RelayConfig>) -> Self {
        self.relays = relays;
        self
    }

    /// Trusting the authorities `trust` gives of relays' certificates, in place of the web's.
    #[must_use]
    pub fn trust(mut self, trust: CaTlsConfig) -> Self {
        self.trust = Some(trust);
        self
    }

    /// Asking the STUN servers `stun`, by their names, where its sockets are seen from outside — none, asking none — in
    /// place of `STUN_SERVER`.
    #[must_use]
    pub fn stun(mut self, stun: Vec<String>) -> Self {
        self.stun = stun;
        self
    }

    /// Reaching peers through relays and ICE alone, never straight to their addresses — as a test of ICE has it.
    #[must_use]
    pub fn without_direct_paths(mut self) -> Self {
        self.direct = false;
        self
    }

    /// The place, its sockets bound.
    ///
    /// # Errors
    /// Where its sockets cannot be bound.
    pub async fn bind(self) -> Result<Tunnel, TunnelError> {
        let relay_mode = if self.relays.is_empty() {
            RelayMode::Disabled
        } else {
            RelayMode::Custom(self.relays.into_iter().collect::<RelayMap>())
        };
        let mut builder = Endpoint::builder(presets::Minimal)
            .secret_key(self.key.clone())
            .alpns(vec![ALPN.to_vec()])
            .relay_mode(relay_mode);
        if let Some(trust) = self.trust {
            builder = builder.ca_tls_config(trust);
        }
        #[cfg(not(target_family = "wasm"))]
        if !self.direct {
            builder = builder.clear_ip_transports();
        }
        #[cfg(not(target_family = "wasm"))]
        let ice = crate::ice::Ice::start(self.key.public(), &self.stun).await?;
        #[cfg(not(target_family = "wasm"))]
        {
            builder = builder
                .add_custom_transport(std::sync::Arc::new(ice.clone()))
                .address_lookup(ice.lookup());
        }
        Ok(Tunnel {
            endpoint: builder.bind().await?,
            #[cfg(not(target_family = "wasm"))]
            ice,
        })
    }
}

impl Tunnel {
    /// The place of `key`, to be built.
    #[must_use]
    pub fn builder(key: SecretKey) -> Builder {
        Builder {
            key,
            relays: Vec::new(),
            trust: None,
            direct: true,
            stun: vec![STUN_SERVER.to_owned()],
        }
    }

    /// Its key, by which it is reached.
    #[must_use]
    pub fn key(&self) -> PublicKey {
        self.endpoint.id()
    }

    /// Where it is reached as it knows now: its key, its home relay and its direct addresses.
    #[must_use]
    pub fn addr(&self) -> EndpointAddr {
        self.endpoint.addr()
    }

    /// Where its sockets are seen from outside, as STUN servers said: the addresses a peer behind another NAT reaches
    /// it at, where its own NAT lets it.
    #[cfg(not(target_family = "wasm"))]
    #[must_use]
    pub fn seen_from_outside(&self) -> Vec<std::net::SocketAddr> {
        self.ice.seen_from_outside()
    }

    /// Waits till it is reached at its home relay.
    pub async fn online(&self) {
        self.endpoint.online().await;
    }

    /// The peer at `addr`, its session opened.
    ///
    /// # Errors
    /// Where it cannot be reached, or speaks no HTTP/3.
    pub async fn connect(&self, addr: impl Into<EndpointAddr>) -> Result<Peer, TunnelError> {
        let connection = self.endpoint.connect(addr, ALPN).await?;
        let peer = Peer::open(connection).await?;
        #[cfg(not(target_family = "wasm"))]
        {
            let (ice, offering) = (self.ice.clone(), peer.clone());
            n0_future::task::spawn(async move { offering.offer_ice(&ice).await });
        }
        Ok(peer)
    }

    /// Leaves the tunnel: every session closed.
    pub async fn close(&self) {
        self.endpoint.close().await;
    }
}
