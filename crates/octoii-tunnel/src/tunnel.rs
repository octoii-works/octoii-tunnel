//! A place on the tunnel: the endpoint of a key, at home on its relays, which dials and is dialled by keys alone — no
//! service outside is asked where a key is: a device knows the machine's key and relay from the pairing that gave them.

use iroh::endpoint::{BindError, ConnectError, presets};
use iroh::tls::CaTlsConfig;
use iroh::{Endpoint, EndpointAddr, PublicKey, RelayConfig, RelayMap, RelayMode, SecretKey};

use crate::peer::Peer;

/// The protocol the tunnel's sessions speak: HTTP/3.
pub const ALPN: &[u8] = b"h3";

/// A place on the tunnel.
#[derive(Debug, Clone)]
pub struct Tunnel {
    pub(crate) endpoint: Endpoint,
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
}

/// What a place on the tunnel is built of: its key, its relays — each by its address, and whether it tells a client
/// its public address over QUIC, as a relay on a machine of its own does and one on Workers cannot — and the
/// authorities whose certificates of relays it trusts.
#[derive(Debug)]
pub struct Builder {
    key: SecretKey,
    relays: Vec<RelayConfig>,
    trust: Option<CaTlsConfig>,
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
            .secret_key(self.key)
            .alpns(vec![ALPN.to_vec()])
            .relay_mode(relay_mode);
        if let Some(trust) = self.trust {
            builder = builder.ca_tls_config(trust);
        }
        Ok(Tunnel {
            endpoint: builder.bind().await?,
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
        Peer::open(connection).await
    }

    /// Leaves the tunnel: every session closed.
    pub async fn close(&self) {
        self.endpoint.close().await;
    }
}
