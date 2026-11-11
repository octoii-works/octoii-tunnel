//! A peer reached over the tunnel, as HTTP/3 has it: its session's connection driven by a task of its own, requests
//! sent over it at once on streams of their own, and a WebSocket opened by extended CONNECT, its stream handed over as
//! the peer answers it with success.

use std::time::Duration;

use bytes::{Buf, Bytes, BytesMut};
use h3::client::SendRequest;
use h3::error::{ConnectionError, StreamError};
use http::{Method, Request, Response, StatusCode};
use iroh::PublicKey;
use iroh::endpoint::Connection;

use crate::stream::{Stream, carried};
use crate::tunnel::TunnelError;

/// A peer reached over the tunnel.
#[derive(Clone)]
pub struct Peer {
    key: PublicKey,
    connection: Connection,
    requests: SendRequest<iroh_h3::OpenStreams, Bytes>,
}

/// The path a session sends on now: through what, and its round trip.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Path {
    pub via: Via,
    pub rtt: Duration,
}

/// What a session's path goes through: straight to the peer's address, through the relay, or a transport of its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    Direct,
    Relay,
    Other,
}

impl std::fmt::Debug for Peer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Peer").field("key", &self.key).finish_non_exhaustive()
    }
}

/// Why a request was not answered.
#[derive(Debug, thiserror::Error)]
pub enum PeerError {
    #[error(transparent)]
    Stream(#[from] StreamError),
    #[error(transparent)]
    Request(#[from] http::Error),
    #[error("the peer answered {0}")]
    Refused(StatusCode),
}

impl Peer {
    /// The peer of `connection`, its HTTP/3 session opened and driven.
    pub(crate) async fn open(connection: Connection) -> Result<Self, TunnelError> {
        let key = connection.remote_id();
        let (mut driver, requests) = h3::client::builder()
            .enable_extended_connect(true)
            .build::<_, _, Bytes>(iroh_h3::Connection::new(connection.clone()))
            .await?;
        n0_future::task::spawn(async move {
            let _: ConnectionError = driver.wait_idle().await;
        });
        Ok(Self { key, connection, requests })
    }

    /// Offers the peer ICE over the session, and takes its answer: a path through NATs to come, once its channel
    /// opens.
    #[cfg(not(target_family = "wasm"))]
    pub(crate) async fn offer_ice(&self, ice: &crate::ice::Ice) {
        let Ok(offer) = ice.offer(self.key).await else { return };
        let request = Request::post(crate::ice::OFFER_PATH).body(Bytes::from(offer));
        let Ok(request) = request else { return };
        let Ok(answer) = self.request(request).await else { return };
        if answer.status().is_success() {
            ice.accept(self.key, String::from_utf8_lossy(answer.body()).into_owned());
        }
    }

    /// The path the session sends on now; none before it has one.
    #[must_use]
    pub fn path(&self) -> Option<Path> {
        let paths = self.connection.paths();
        let selected = paths.iter().find(iroh::endpoint::Path::is_selected)?;
        let via = if selected.is_ip() {
            Via::Direct
        } else if selected.is_relay() {
            Via::Relay
        } else {
            Via::Other
        };
        Some(Path { via, rtt: selected.rtt() })
    }

    /// Its key.
    #[must_use]
    pub fn key(&self) -> PublicKey {
        self.key
    }

    /// The address of `path` at the peer, as its requests name it.
    fn uri(&self, path: &str) -> String {
        format!("https://{}{path}", self.key)
    }

    /// Sends `request` — its path the peer's, as `/files/x` — and gives the peer's response, its body read whole.
    ///
    /// # Errors
    /// Where the request could not be sent or its response read.
    pub async fn request(&self, request: Request<Bytes>) -> Result<Response<Bytes>, PeerError> {
        let (mut parts, body) = request.into_parts();
        let path = parts.uri.path_and_query().map_or("/", |path| path.as_str()).to_owned();
        parts.uri = self.uri(&path).parse().map_err(http::Error::from)?;
        let mut stream = self.requests.clone().send_request(Request::from_parts(parts, ())).await?;
        if !body.is_empty() {
            stream.send_data(body).await?;
        }
        stream.finish().await?;
        let head = stream.recv_response().await?;
        let mut read = BytesMut::new();
        while let Some(mut data) = stream.recv_data().await? {
            read.extend_from_slice(&data.copy_to_bytes(data.remaining()));
        }
        let (parts, ()) = head.into_parts();
        Ok(Response::from_parts(parts, read.freeze()))
    }

    /// Opens a WebSocket at `path` — the request `head` with the path, and its headers — by extended CONNECT: the
    /// stream it runs on, as the peer answers with success.
    ///
    /// # Errors
    /// `Refused` where the peer answered otherwise; where the request could not be sent.
    pub async fn websocket(&self, path: &str, head: Request<()>) -> Result<Stream, PeerError> {
        let (mut parts, ()) = head.into_parts();
        parts.method = Method::CONNECT;
        parts.uri = self.uri(path).parse().map_err(http::Error::from)?;
        parts.extensions.insert(h3::ext::Protocol::WEBSOCKET);
        let mut stream = self.requests.clone().send_request(Request::from_parts(parts, ())).await?;
        let response = stream.recv_response().await?;
        if !response.status().is_success() {
            return Err(PeerError::Refused(response.status()));
        }
        let (send, receive) = stream.split();
        Ok(carried(send, receive))
    }
}
