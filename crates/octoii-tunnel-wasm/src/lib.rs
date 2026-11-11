//! The tunnel as WebAssembly, for a browser: a session to a machine, by the machine's key, through the machine's relay
//! at first and then, where the browser's ICE punches through to it, over a data channel straight to it — speaking
//! HTTP/3 to it end to end, the relay seeing nothing of what they say. Each page reaches the machine as a key of its own, made for it and kept in memory, so the tabs of one
//! device never displace each other at the relay; the device proves who it is by its credential, in its requests, as it does
//! to a machine on its own network. The machine's key is the one the pairing gave: no other answers as it.

use std::rc::Rc;

use bytes::Bytes;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt as _, StreamExt as _};
use octoii_tunnel::{EndpointAddr, Message, Peer, PublicKey, RelayConfig, RelayUrl, SecretKey, Socket as TunnelSocket, Tunnel, Via};
use tokio::sync::Mutex;
use wasm_bindgen::prelude::*;

/// A session to a machine.
#[wasm_bindgen]
#[derive(Debug)]
pub struct Session {
    tunnel: Tunnel,
    peer: Peer,
}

/// The path a session sends on: `direct`, `relay` or `ice`, and its round trip in milliseconds.
#[wasm_bindgen(getter_with_clone)]
#[derive(Debug)]
pub struct Path {
    pub via: String,
    pub rtt_ms: f64,
}

/// A machine's answer: its status, its headers as name and value in turn, and its body.
#[wasm_bindgen(getter_with_clone)]
#[derive(Debug)]
pub struct Answer {
    pub status: u16,
    pub headers: Vec<String>,
    pub body: Vec<u8>,
}

fn failed(error: impl std::fmt::Display) -> JsError {
    JsError::new(&error.to_string())
}

/// `headers`, names and values in turn, on `builder`.
fn with_headers(mut builder: http::request::Builder, headers: &[String]) -> http::request::Builder {
    for [name, value] in headers.as_chunks::<2>().0 {
        builder = builder.header(name.as_str(), value.as_str());
    }
    builder
}

#[wasm_bindgen]
impl Session {
    /// Opens a session to the machine of the key `machine`, through its relay at `relay`, as a key made for this
    /// session alone.
    ///
    /// # Errors
    /// Where the key or the relay is not one, or the machine cannot be reached.
    pub async fn open(relay: String, machine: String) -> Result<Session, JsError> {
        let relay: RelayUrl = relay.parse().map_err(failed)?;
        let machine: PublicKey = machine.parse().map_err(failed)?;
        let tunnel = Tunnel::builder(SecretKey::generate())
            .relays(vec![RelayConfig::new(relay.clone(), None)])
            .bind()
            .await
            .map_err(failed)?;
        let peer = tunnel
            .connect(EndpointAddr::new(machine).with_relay_url(relay))
            .await
            .map_err(failed)?;
        Ok(Self { tunnel, peer })
    }

    /// The path the session sends on now; none before it has one.
    #[must_use]
    pub fn path(&self) -> Option<Path> {
        let path = self.peer.path()?;
        let via = match path.via {
            Via::Direct => "direct",
            Via::Relay => "relay",
            Via::Ice => "ice",
        };
        Some(Path {
            via: via.to_owned(),
            rtt_ms: path.rtt.as_secs_f64() * 1000.0,
        })
    }

    /// The machine's key.
    #[must_use]
    pub fn machine(&self) -> String {
        self.peer.key().to_string()
    }

    /// Sends a request — its method, its path at the machine, its headers as name and value in turn, its body — and
    /// gives the machine's answer.
    ///
    /// # Errors
    /// Where the request is no request, or it could not be sent or answered.
    pub async fn request(&self, method: String, path: String, headers: Vec<String>, body: Vec<u8>) -> Result<Answer, JsError> {
        let request = with_headers(http::Request::builder().method(method.as_str()).uri(path), &headers)
            .body(Bytes::from(body))
            .map_err(failed)?;
        let response = self.peer.request(request).await.map_err(failed)?;
        let headers = response
            .headers()
            .iter()
            .flat_map(|(name, value)| [name.to_string(), String::from_utf8_lossy(value.as_bytes()).into_owned()])
            .collect();
        Ok(Answer {
            status: response.status().as_u16(),
            headers,
            body: response.into_body().to_vec(),
        })
    }

    /// Opens a WebSocket at `path` at the machine, with `headers`, names and values in turn.
    ///
    /// # Errors
    /// Where the machine refused it, or it could not be opened.
    pub async fn socket(&self, path: String, headers: Vec<String>) -> Result<Socket, JsError> {
        let head = with_headers(http::Request::builder(), &headers).body(()).map_err(failed)?;
        let stream = self.peer.websocket(&path, head).await.map_err(failed)?;
        let (sink, messages) = octoii_tunnel::socket::client(stream).await.split();
        Ok(Socket {
            sink: Rc::new(Mutex::new(sink)),
            messages: Rc::new(Mutex::new(messages)),
        })
    }

    /// Ends the session.
    pub async fn close(&self) {
        self.tunnel.close().await;
    }
}

/// A WebSocket to a machine: messages sent and received, as a page's WebSocket has them.
#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct Socket {
    sink: Rc<Mutex<SplitSink<TunnelSocket, Message>>>,
    messages: Rc<Mutex<SplitStream<TunnelSocket>>>,
}

#[wasm_bindgen]
impl Socket {
    /// Sends a message of text.
    ///
    /// # Errors
    /// Where the socket is closed.
    pub async fn send_text(&self, text: String) -> Result<(), JsError> {
        self.sink.lock().await.send(Message::text(text)).await.map_err(failed)
    }

    /// Sends a message of bytes.
    ///
    /// # Errors
    /// Where the socket is closed.
    pub async fn send_bytes(&self, bytes: Vec<u8>) -> Result<(), JsError> {
        self.sink.lock().await.send(Message::binary(bytes)).await.map_err(failed)
    }

    /// The next message: a string for text, a `Uint8Array` for bytes; null once the socket closed.
    ///
    /// # Errors
    /// Where the socket failed.
    pub async fn next(&self) -> Result<JsValue, JsError> {
        let mut messages = self.messages.lock().await;
        loop {
            return match messages.next().await {
                Some(Ok(Message::Text(text))) => Ok(JsValue::from_str(text.as_str())),
                Some(Ok(Message::Binary(bytes))) => Ok(js_sys::Uint8Array::from(&bytes[..]).into()),
                Some(Ok(Message::Close(_))) | None => Ok(JsValue::NULL),
                Some(Ok(_)) => continue,
                Some(Err(error)) => Err(failed(error)),
            };
        }
    }

    /// Closes the socket.
    pub async fn close(&self) {
        let _ = self.sink.lock().await.close().await;
    }
}
