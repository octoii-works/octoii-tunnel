//! The relay protocol, as a home speaks it: each message a frame — its type, a QUIC varint, then its body. A client is
//! challenged first, and proves the key it claims by signing a key derived from the challenge, as its endpoint does;
//! then every datagram frame it sends is forwarded to the key it names, the key in front rewritten to the sender's and
//! the rest carried as it came, a ping answered with its pong, and a key not here told gone.

use bytes::{BufMut, Bytes, BytesMut};
use iroh_base::{PublicKey, Signature};
use serde::{Deserialize, Serialize};

/// The subprotocols of the relay's WebSocket, newest first; a home answers with the first a client offers that it
/// speaks.
pub const PROTOCOLS: [&str; 2] = ["iroh-relay-v2", "iroh-relay-v1"];
/// The path of the relay's WebSocket, and of the probe a client measures its latency by.
pub const RELAY_PATH: &str = "/relay";
pub const PROBE_PATH: &str = "/ping";

/// The frame types a home reads and writes.
mod types {
    pub const SERVER_CHALLENGE: u8 = 0;
    pub const CLIENT_AUTH: u8 = 1;
    pub const SERVER_CONFIRMS_AUTH: u8 = 2;
    pub const SERVER_DENIES_AUTH: u8 = 3;
    pub const CLIENT_TO_RELAY_DATAGRAM: u8 = 4;
    pub const CLIENT_TO_RELAY_DATAGRAM_BATCH: u8 = 5;
    pub const RELAY_TO_CLIENT_DATAGRAM: u8 = 6;
    pub const RELAY_TO_CLIENT_DATAGRAM_BATCH: u8 = 7;
    pub const ENDPOINT_GONE: u8 = 8;
    pub const PING: u8 = 9;
    pub const PONG: u8 = 10;
}

/// The domain the key a client signs is derived in, from the challenge.
const CHALLENGE_DOMAIN: &str = "iroh-relay handshake v1 challenge signature";

/// The most a frame's body may hold.
pub const FRAME_BYTES_MAX: usize = 64 * 1024;

/// Why a frame was refused.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum Refused {
    #[error("not the frame expected")]
    Unexpected,
    #[error("a frame past its bound")]
    TooLarge,
    #[error("the signature does not prove the key")]
    NotProved,
    #[error("a frame that cannot be read")]
    Malformed,
}

/// A challenge, sent to a client as it comes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Challenge(pub [u8; 16]);

impl Challenge {
    /// A new challenge, of the system's randomness.
    ///
    /// # Panics
    /// Where the system gives no randomness.
    #[must_use]
    pub fn new() -> Self {
        let mut bytes = [0; 16];
        getrandom::fill(&mut bytes).expect("the system gives randomness");
        Self(bytes)
    }

    /// The challenge as its frame.
    #[must_use]
    pub fn frame(&self) -> Bytes {
        let mut out = BytesMut::with_capacity(17);
        out.put_u8(types::SERVER_CHALLENGE);
        out.put_slice(&self.0);
        out.freeze()
    }

    /// The key whose signature proves a client's key.
    fn signed(&self) -> [u8; 32] {
        blake3::derive_key(CHALLENGE_DOMAIN, &self.0)
    }

    /// The key the client's answer `frame` proves it holds.
    ///
    /// # Errors
    /// `Unexpected` for a frame no answer; `Malformed`; `NotProved` where its signature is not of this challenge.
    pub fn verify(&self, frame: &[u8]) -> Result<PublicKey, Refused> {
        #[derive(Deserialize)]
        struct ClientAuth {
            public_key: PublicKey,
            #[serde(with = "serde_bytes")]
            signature: [u8; 64],
        }
        let (&kind, body) = frame.split_first().ok_or(Refused::Malformed)?;
        if kind != types::CLIENT_AUTH {
            return Err(Refused::Unexpected);
        }
        let auth: ClientAuth = postcard::from_bytes(body).map_err(|_| Refused::Malformed)?;
        auth.public_key
            .verify(&self.signed(), &Signature::from_bytes(&auth.signature))
            .map_err(|_| Refused::NotProved)?;
        Ok(auth.public_key)
    }
}

impl Default for Challenge {
    fn default() -> Self {
        Self::new()
    }
}

/// The frame that tells a client its key is proved.
#[must_use]
pub fn confirmed() -> Bytes {
    Bytes::from_static(&[types::SERVER_CONFIRMS_AUTH])
}

/// The frame that tells a client it is denied, and why.
#[must_use]
pub fn denied(reason: &str) -> Bytes {
    #[derive(Serialize)]
    struct ServerDeniesAuth<'a> {
        reason: &'a str,
    }
    let mut out = vec![types::SERVER_DENIES_AUTH];
    out.extend(postcard::to_allocvec(&ServerDeniesAuth { reason }).unwrap_or_default());
    out.into()
}

/// The frame that tells a client the key `gone` is not here.
#[must_use]
pub fn gone(gone: &PublicKey) -> Bytes {
    let mut out = BytesMut::with_capacity(33);
    out.put_u8(types::ENDPOINT_GONE);
    out.put_slice(gone.as_bytes());
    out.freeze()
}

/// What a home does with a frame a proved client sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// Sends `frame` to the client of the key `to`.
    Forward { to: PublicKey, frame: Bytes },
    /// Answers the sender with `frame`.
    Answer(Bytes),
}

/// What a home does with the frame `frame` the client of the key `from` sent.
///
/// # Errors
/// `TooLarge`; `Malformed` for a datagram with no key, or a ping of no 8 bytes; `Unexpected` for a frame a client
/// does not send once proved.
pub fn route(from: &PublicKey, frame: &[u8]) -> Result<Route, Refused> {
    let (&kind, body) = frame.split_first().ok_or(Refused::Malformed)?;
    if body.len() > FRAME_BYTES_MAX {
        return Err(Refused::TooLarge);
    }
    match kind {
        types::CLIENT_TO_RELAY_DATAGRAM | types::CLIENT_TO_RELAY_DATAGRAM_BATCH => {
            let (key, rest) = body.split_first_chunk::<32>().ok_or(Refused::Malformed)?;
            let to = PublicKey::from_bytes(key).map_err(|_| Refused::Malformed)?;
            let mut out = BytesMut::with_capacity(frame.len());
            out.put_u8(if kind == types::CLIENT_TO_RELAY_DATAGRAM {
                types::RELAY_TO_CLIENT_DATAGRAM
            } else {
                types::RELAY_TO_CLIENT_DATAGRAM_BATCH
            });
            out.put_slice(from.as_bytes());
            out.put_slice(rest);
            Ok(Route::Forward { to, frame: out.freeze() })
        }
        types::PING if body.len() == 8 => {
            let mut out = BytesMut::with_capacity(9);
            out.put_u8(types::PONG);
            out.put_slice(body);
            Ok(Route::Answer(out.freeze()))
        }
        types::PING => Err(Refused::Malformed),
        _ => Err(Refused::Unexpected),
    }
}
