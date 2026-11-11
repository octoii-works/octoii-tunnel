//! A machine's home on Cloudflare: a Durable Object per machine, named by the host the machine is reached at, holding
//! the sockets of the machine and of the devices that reach it, hibernating between their messages. Each socket's
//! attachment keeps where it stands — the challenge it was sent, till it proved its key; then its key — so the home
//! needs no memory of its own across hibernation; a key that comes again displaces the socket it had.

use net_base::PublicKey;
use serde::{Deserialize, Serialize};
use worker::{
    Context, DurableObject, Env, Request, Response, Result, State, WebSocket, WebSocketIncomingMessage, WebSocketPair, durable_object,
    event,
};

use crate::protocol::{self, Challenge, Route};

/// The binding of the homes' namespace, as the Worker's configuration names it.
pub const HOMES: &str = "HOMES";

/// Where a socket stands, as its attachment keeps it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum Standing {
    Challenged([u8; 16]),
    Proved([u8; 32]),
}

/// A machine's home.
#[durable_object]
pub struct Home {
    state: State,
}

impl std::fmt::Debug for Home {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Home").finish_non_exhaustive()
    }
}

impl Home {
    /// The socket of the key `key`, where it is here.
    fn socket_of(&self, key: &PublicKey) -> Option<WebSocket> {
        self.state
            .get_websockets()
            .into_iter()
            .find(|socket| socket.deserialize_attachment::<Standing>().ok().flatten() == Some(Standing::Proved(*key.as_bytes())))
    }

    /// Takes the client of `socket`'s answer to its challenge: its key proved, and any socket it had before closed.
    fn proved(&self, socket: &WebSocket, challenge: Challenge, frame: &[u8]) -> Result<()> {
        let Ok(key) = challenge.verify(frame) else {
            socket.send_with_bytes(protocol::denied("signature invalid"))?;
            return socket.close(Some(1008), Some("the key was not proved"));
        };
        if let Some(before) = self.socket_of(&key) {
            let _ = before.close(Some(1000), Some("the key came again"));
        }
        socket.serialize_attachment(Standing::Proved(*key.as_bytes()))?;
        socket.send_with_bytes(protocol::confirmed())
    }

    /// Carries the frame `frame` the client of `from` sent: to the key it names, or back to it.
    fn carried(&self, socket: &WebSocket, from: &PublicKey, frame: &[u8]) -> Result<()> {
        match protocol::route(from, frame) {
            Ok(Route::Forward { to, frame }) => match self.socket_of(&to) {
                Some(target) => target.send_with_bytes(frame),
                None => socket.send_with_bytes(protocol::gone(&to)),
            },
            Ok(Route::Answer(frame)) => socket.send_with_bytes(frame),
            Err(_) => Ok(()),
        }
    }
}

#[expect(clippy::unused_async_trait_impl, reason = "the runtime calls each handler as async")]
impl DurableObject for Home {
    fn new(state: State, _env: Env) -> Self {
        Self { state }
    }

    async fn fetch(&self, request: Request) -> Result<Response> {
        let offered = request.headers().get("Sec-WebSocket-Protocol")?.unwrap_or_default();
        let chosen = offered.split(',').map(str::trim).find(|offer| protocol::PROTOCOLS.contains(offer));
        let pair = WebSocketPair::new()?;
        self.state.accept_web_socket(&pair.server);
        let challenge = Challenge::new();
        pair.server.serialize_attachment(Standing::Challenged(challenge.0))?;
        pair.server.send_with_bytes(challenge.frame())?;
        let response = Response::from_websocket(pair.client)?;
        if let Some(chosen) = chosen {
            response.headers().set("Sec-WebSocket-Protocol", chosen)?;
        }
        Ok(response)
    }

    async fn websocket_message(&self, socket: WebSocket, message: WebSocketIncomingMessage) -> Result<()> {
        let WebSocketIncomingMessage::Binary(frame) = message else {
            return Ok(());
        };
        match socket.deserialize_attachment::<Standing>()? {
            Some(Standing::Challenged(challenge)) => self.proved(&socket, Challenge(challenge), &frame),
            Some(Standing::Proved(key)) => match PublicKey::from_bytes(&key) {
                Ok(from) => self.carried(&socket, &from, &frame),
                Err(_) => socket.close(Some(1011), Some("a key not kept as written")),
            },
            None => Ok(()),
        }
    }

    async fn websocket_close(&self, _socket: WebSocket, _code: usize, _reason: String, _clean: bool) -> Result<()> {
        Ok(())
    }

    async fn websocket_error(&self, _socket: WebSocket, _error: worker::Error) -> Result<()> {
        Ok(())
    }
}

/// The relay's Worker: a client's WebSocket at `/relay` handed to the home of the host it came to, the probe at
/// `/ping` answered at once, and `/generate_204` with no content, so a client knows it is past no captive portal.
#[event(fetch)]
async fn fetch(request: Request, env: Env, _context: Context) -> Result<Response> {
    let url = request.url()?;
    match url.path() {
        protocol::RELAY_PATH => {
            let host = url.host_str().unwrap_or_default().to_owned();
            let home = env.durable_object(HOMES)?.id_from_name(&host)?.get_stub()?;
            home.fetch_with_request(request).await
        }
        protocol::PROBE_PATH => Response::ok(""),
        protocol::PORTAL_PATH => Ok(Response::empty()?.with_status(204)),
        _ => Response::error("no such path", 404),
    }
}
