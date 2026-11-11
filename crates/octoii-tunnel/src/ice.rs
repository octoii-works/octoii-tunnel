//! A path between two places that cannot reach each other's addresses: ICE, as WebRTC punches through NATs, a data
//! channel between them — unordered, never retransmitted — carrying the session's QUIC packets as a transport of the
//! endpoint's own, so the session's multipath takes it beside the relay and picks the faster. The ICE of a session is
//! negotiated over the session itself, the relay already carrying it: the side that dialled opens a WebSocket the
//! other side's tunnel answers before its service sees anything, and over it each side sends its description, then
//! each candidate it finds after — trickled, as RFC 8838 has it, so a path is tried as soon as an address is known.
//! Once the channel opens, the dialler's address lookup yields the peer's ICE address, and the session opens its path
//! there. One task holds every peer's WebRTC state, as its one owner: on a machine, the UDP sockets and a WebRTC
//! state of its own per peer; in a page, the browser's peer connections.

use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use bytes::Bytes;
use n0_future::boxed::BoxStream;
use net::address_lookup::{AddressLookup, EndpointData, EndpointInfo, Error as LookupError, Item};
use net::endpoint::transports::{CustomEndpoint, CustomSender, CustomTransport, RecvInfo, Transmit};
use net::{EndpointId, PublicKey, TransportAddr};
use net_base::CustomAddr;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::Message;

use crate::peer::Peer;
use crate::socket::Socket;

#[cfg(target_family = "wasm")]
mod browser;
#[cfg(not(target_family = "wasm"))]
mod native;
#[cfg(not(target_family = "wasm"))]
mod stun;

/// The id of ICE among the endpoint's transports.
pub const TRANSPORT: u64 = 0x0069_6365;

/// The path of the WebSocket a session's ICE is negotiated over.
pub const SIGNALING_PATH: &str = "/.octoii/ice";

/// The label of the channel the packets go over.
const CHANNEL: &str = "quic";

/// How many received packets wait for the session to take them.
const RECEIVED_AHEAD: usize = 1024;

/// The ICE address of the peer of the key `key`.
#[must_use]
pub fn addr_of(key: &PublicKey) -> CustomAddr {
    CustomAddr::from_parts(TRANSPORT, key.as_bytes())
}

/// The key an ICE address names.
fn key_of(addr: &CustomAddr) -> Option<PublicKey> {
    if addr.id() != TRANSPORT {
        return None;
    }
    PublicKey::from_bytes(addr.data().try_into().ok()?).ok()
}

/// What the task that holds the ICE state is asked.
enum Order {
    Offer {
        peer: PublicKey,
        reply: oneshot::Sender<Result<Described, String>>,
    },
    /// A page only dials, so it answers no offer.
    #[cfg(not(target_family = "wasm"))]
    Answer {
        peer: PublicKey,
        offer: String,
        reply: oneshot::Sender<Result<Described, String>>,
    },
    Accept {
        peer: PublicKey,
        answer: String,
    },
    Candidate {
        peer: PublicKey,
        candidate: String,
    },
    Send {
        peer: PublicKey,
        packet: Bytes,
    },
}

/// This side's part of a negotiation with a peer: its description, and each candidate it finds after, as found.
pub(crate) struct Described {
    sdp: String,
    candidates: mpsc::UnboundedReceiver<String>,
}

/// A place's ICE: a handle to the task that holds it.
#[derive(Debug, Clone)]
pub struct Ice {
    own: CustomAddr,
    orders: mpsc::UnboundedSender<Order>,
    received: Arc<Mutex<Option<Received>>>,
    open: watch::Receiver<HashSet<PublicKey>>,
    outside: watch::Receiver<Vec<SocketAddr>>,
}

/// The packets that came over ICE, each with the key of the peer it came from, till the endpoint binds and takes them.
type Received = mpsc::Receiver<(PublicKey, Bytes)>;

/// What the task that holds a place's ICE state is handed: the orders it takes, where it delivers the packets that
/// come, where it tells which peers' channels are open, and where it tells the addresses it is seen at from outside.
struct Agency {
    orders: mpsc::UnboundedReceiver<Order>,
    delivered: mpsc::Sender<(PublicKey, Bytes)>,
    opened: watch::Sender<HashSet<PublicKey>>,
    told: watch::Sender<Vec<SocketAddr>>,
}

impl Ice {
    /// The ICE of the place of the key `own`, asking the STUN servers `stun` — by their names — where it is seen from
    /// outside: on a machine, a UDP socket bound on each local address it can bind; in a page, the browser's.
    #[must_use]
    pub fn start(own: PublicKey, stun: &[String]) -> Self {
        let (ice, agency) = Self::new(own);
        #[cfg(not(target_family = "wasm"))]
        native::start(agency, stun);
        #[cfg(target_family = "wasm")]
        browser::start(agency, stun);
        ice
    }

    /// The ICE of the place of the key `own`, and what the task that holds its state is handed.
    fn new(own: PublicKey) -> (Self, Agency) {
        let (orders, taken) = mpsc::unbounded_channel();
        let (delivered, received) = mpsc::channel(RECEIVED_AHEAD);
        let (opened, open) = watch::channel(HashSet::new());
        let (told, outside) = watch::channel(Vec::new());
        let ice = Self {
            own: addr_of(&own),
            orders,
            received: Arc::new(Mutex::new(Some(received))),
            open,
            outside,
        };
        let agency = Agency {
            orders: taken,
            delivered,
            opened,
            told,
        };
        (ice, agency)
    }

    /// Where this place is seen from outside, as STUN servers said: the addresses a peer behind another NAT reaches it
    /// at, where its own NAT lets it.
    #[must_use]
    pub fn seen_from_outside(&self) -> Vec<SocketAddr> {
        self.outside.borrow().clone()
    }

    /// An offer of ICE to the peer `peer`, to be sent to it.
    async fn offer(&self, peer: PublicKey) -> Result<Described, String> {
        let (reply, offered) = oneshot::channel();
        self.orders.send(Order::Offer { peer, reply }).map_err(|_| "ICE is stopped")?;
        offered.await.map_err(|_| "ICE is stopped")?
    }

    /// The answer to the peer `peer`'s offer `offer`.
    #[cfg(not(target_family = "wasm"))]
    async fn answer(&self, peer: PublicKey, offer: String) -> Result<Described, String> {
        let (reply, answered) = oneshot::channel();
        self.orders
            .send(Order::Answer { peer, offer, reply })
            .map_err(|_| "ICE is stopped")?;
        answered.await.map_err(|_| "ICE is stopped")?
    }

    /// Takes the peer `peer`'s answer to the offer made it.
    fn accept(&self, peer: PublicKey, answer: String) {
        let _ = self.orders.send(Order::Accept { peer, answer });
    }

    /// Takes a candidate the peer `peer` found after its description.
    fn add_candidate(&self, peer: PublicKey, candidate: String) {
        let _ = self.orders.send(Order::Candidate { peer, candidate });
    }

    /// Negotiates ICE with the peer `peer` dialled, as the side that offers, over a WebSocket of its session — kept
    /// open for the candidates either side finds later.
    pub(crate) async fn offer_to(&self, peer: Peer) -> Option<()> {
        let key = peer.key();
        let stream = peer.websocket(SIGNALING_PATH, http::Request::new(())).await.ok()?;
        drop(peer);
        let mut socket = crate::socket::client(stream).await;
        let described = self.offer(key).await.ok()?;
        futures_util::SinkExt::send(&mut socket, Message::text(described.sdp)).await.ok()?;
        self.accept(key, next_text(&mut socket).await?);
        self.trickled(key, socket, described.candidates).await;
        Some(())
    }

    /// Negotiates ICE with the peer `peer` that dialled, as the side that answers, over `socket`.
    #[cfg(not(target_family = "wasm"))]
    async fn answer_over(&self, peer: PublicKey, mut socket: Socket) -> Option<()> {
        let offer = next_text(&mut socket).await?;
        let described = self.answer(peer, offer).await.ok()?;
        futures_util::SinkExt::send(&mut socket, Message::text(described.sdp)).await.ok()?;
        self.trickled(peer, socket, described.candidates).await;
        Some(())
    }

    /// Carries candidates both ways over `socket` once the descriptions are given: each this side finds sent, each the
    /// peer `peer` sends added — till either side lets go.
    async fn trickled(&self, peer: PublicKey, mut socket: Socket, mut candidates: mpsc::UnboundedReceiver<String>) {
        loop {
            tokio::select! {
                found = candidates.recv() => {
                    let Some(found) = found else { return };
                    if futures_util::SinkExt::send(&mut socket, Message::text(found)).await.is_err() {
                        return;
                    }
                }
                came = next_text(&mut socket) => {
                    let Some(came) = came else { return };
                    self.add_candidate(peer, came);
                }
            }
        }
    }
}

/// The next text message that comes over `socket`; none once it closes.
async fn next_text(socket: &mut Socket) -> Option<String> {
    loop {
        match futures_util::StreamExt::next(socket).await? {
            Ok(Message::Text(text)) => return Some(text.as_str().to_owned()),
            Ok(Message::Close(_)) | Err(_) => return None,
            Ok(_) => {}
        }
    }
}

impl CustomTransport for Ice {
    fn bind(&self) -> std::io::Result<Box<dyn CustomEndpoint>> {
        let received = self
            .received
            .lock()
            .map_err(|_| std::io::Error::other("ICE's lock was poisoned"))?
            .take()
            .ok_or_else(|| std::io::Error::other("ICE is bound already"))?;
        Ok(Box::new(Bound {
            own: self.own.clone(),
            local: n0_watcher::Watchable::new(vec![self.own.clone()]),
            orders: self.orders.clone(),
            received,
        }))
    }
}

/// ICE as the endpoint holds it once bound.
#[derive(Debug)]
struct Bound {
    own: CustomAddr,
    local: n0_watcher::Watchable<Vec<CustomAddr>>,
    orders: mpsc::UnboundedSender<Order>,
    received: mpsc::Receiver<(PublicKey, Bytes)>,
}

impl std::fmt::Debug for Order {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Order")
    }
}

impl CustomEndpoint for Bound {
    fn watch_local_addrs(&self) -> n0_watcher::Direct<Vec<CustomAddr>> {
        self.local.watch()
    }

    fn create_sender(&self) -> Arc<dyn CustomSender> {
        Arc::new(Sender {
            orders: self.orders.clone(),
        })
    }

    fn poll_recv(
        &mut self,
        cx: &mut Context,
        bufs: &mut [std::io::IoSliceMut<'_>],
        metas: &mut [noq_udp::RecvMeta],
        recv_infos: &mut [RecvInfo],
    ) -> Poll<std::io::Result<usize>> {
        let mut filled = 0;
        while filled < bufs.len() {
            let next = if filled == 0 {
                match self.received.poll_recv(cx) {
                    Poll::Ready(Some(next)) => next,
                    Poll::Ready(None) => return Poll::Ready(Err(std::io::Error::other("ICE is stopped"))),
                    Poll::Pending => return Poll::Pending,
                }
            } else {
                match self.received.try_recv() {
                    Ok(next) => next,
                    Err(_) => break,
                }
            };
            let (peer, packet) = next;
            let count = packet.len().min(bufs[filled].len());
            bufs[filled][..count].copy_from_slice(&packet[..count]);
            let mut meta = noq_udp::RecvMeta::default();
            meta.len = count;
            meta.stride = count;
            metas[filled] = meta;
            recv_infos[filled] = RecvInfo::new(addr_of(&peer), Some(self.own.clone()));
            filled += 1;
        }
        Poll::Ready(Ok(filled))
    }
}

/// What sends the session's packets over ICE.
#[derive(Debug)]
struct Sender {
    orders: mpsc::UnboundedSender<Order>,
}

impl CustomSender for Sender {
    fn is_valid_send_addr(&self, addr: &CustomAddr) -> bool {
        key_of(addr).is_some()
    }

    fn poll_send(
        &self,
        _cx: &mut Context,
        dst: &CustomAddr,
        _src: Option<&CustomAddr>,
        transmit: &Transmit<'_>,
    ) -> Poll<std::io::Result<()>> {
        let Some(peer) = key_of(dst) else {
            return Poll::Ready(Err(std::io::Error::other("no ICE address")));
        };
        let size = transmit.segment_size.unwrap_or(transmit.contents.len()).max(1);
        for packet in transmit.contents.chunks(size) {
            let _ = self.orders.send(Order::Send {
                peer,
                packet: Bytes::copy_from_slice(packet),
            });
        }
        Poll::Ready(Ok(()))
    }
}

/// The address lookup that tells a dialler a peer's ICE address once their channel is open.
#[derive(Debug, Clone)]
pub(crate) struct Lookup(pub(crate) watch::Receiver<HashSet<PublicKey>>);

impl Ice {
    pub(crate) fn lookup(&self) -> Lookup {
        Lookup(self.open.clone())
    }
}

impl AddressLookup for Lookup {
    fn resolve(&self, endpoint_id: EndpointId) -> Option<BoxStream<Result<Item, LookupError>>> {
        let mut open = self.0.clone();
        let found = async move {
            open.wait_for(|open| open.contains(&endpoint_id)).await.ok()?;
            let data = EndpointData::new(vec![TransportAddr::Custom(addr_of(&endpoint_id))]);
            Some(Ok(Item::new(EndpointInfo::from_parts(endpoint_id, data), "ice", None)))
        };
        Some(Box::pin(futures_util::StreamExt::filter_map(
            futures_util::stream::once(found),
            std::future::ready,
        )))
    }
}

#[cfg(not(target_family = "wasm"))]
/// A machine's service with the ICE offers its peers send answered before it: an offer at `OFFER_PATH` answered by
/// the place's ICE, every other request the service's.
#[derive(Debug, Clone)]
pub(crate) struct Answering<S> {
    pub(crate) ice: Ice,
    pub(crate) service: S,
}

#[cfg(not(target_family = "wasm"))]
impl<S, B> tower_service::Service<http::Request<crate::Body>> for Answering<S>
where
    S: tower_service::Service<http::Request<crate::Body>, Response = http::Response<B>, Error = std::convert::Infallible>,
    S::Future: Send + 'static,
    B: Send + 'static,
{
    type Response = http::Response<http_body_util::Either<B, http_body_util::Full<Bytes>>>;
    type Error = std::convert::Infallible;
    type Future = n0_future::boxed::BoxFuture<Result<Self::Response, Self::Error>>;

    fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        self.service.poll_ready(cx)
    }

    fn call(&mut self, request: http::Request<crate::Body>) -> Self::Future {
        if request.uri().path() != SIGNALING_PATH || request.method() != http::Method::CONNECT {
            let answered = self.service.call(request);
            return Box::pin(async move { Ok(answered.await?.map(http_body_util::Either::Left)) });
        }
        let (remote, connect) = (
            request.extensions().get::<crate::Remote>(),
            request.extensions().get::<crate::OnConnect>(),
        );
        let (Some(crate::Remote(peer)), Some(connect)) = (remote.copied(), connect.cloned()) else {
            return Box::pin(std::future::ready(Ok(refused(
                http::StatusCode::BAD_REQUEST,
                "no peer's WebSocket",
            ))));
        };
        let ice = self.ice.clone();
        n0_future::task::spawn(async move {
            let Some(stream) = connect.stream().await else { return };
            ice.answer_over(peer, crate::socket::server(stream).await).await;
        });
        Box::pin(std::future::ready(Ok(http::Response::new(http_body_util::Either::Right(
            http_body_util::Full::new(Bytes::new()),
        )))))
    }
}

#[cfg(not(target_family = "wasm"))]
fn refused<B>(status: http::StatusCode, why: &str) -> http::Response<http_body_util::Either<B, http_body_util::Full<Bytes>>> {
    let mut response = http::Response::new(http_body_util::Either::Right(http_body_util::Full::new(Bytes::from(
        why.to_owned(),
    ))));
    *response.status_mut() = status;
    response
}
