//! A path between two places that cannot reach each other's addresses: ICE, as WebRTC punches through NATs, a data
//! channel between them — unordered, never retransmitted — carrying the session's QUIC packets as a transport of the
//! endpoint's own, so the session's multipath takes it beside the relay and picks the faster. The ICE of a session is
//! negotiated over the session itself, the relay already carrying it: the side that dialled offers, by a request the
//! other side's tunnel answers before its service sees anything; once the channel opens, the dialler's address lookup
//! yields the peer's ICE address, and the session opens its path there. One task holds the UDP socket and every
//! peer's WebRTC state, as their one owner.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use bytes::Bytes;
use n0_future::boxed::BoxStream;
use net::address_lookup::{AddressLookup, EndpointData, EndpointInfo, Error as LookupError, Item};
use net::endpoint::transports::{CustomEndpoint, CustomSender, CustomTransport, RecvInfo, Transmit};
use net::{EndpointId, PublicKey, TransportAddr};
use net_base::CustomAddr;
use str0m::change::{SdpAnswer, SdpOffer, SdpPendingOffer};
use str0m::channel::{ChannelConfig, ChannelId, Reliability};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};
use tokio::net::UdpSocket;
use tokio::sync::{mpsc, oneshot, watch};

mod stun;

/// The id of ICE among the endpoint's transports.
pub const TRANSPORT: u64 = 0x0069_6365;

/// The path of the request that carries a dialler's offer.
pub const OFFER_PATH: &str = "/.octoii/ice";

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
        reply: oneshot::Sender<Result<String, String>>,
    },
    Answer {
        peer: PublicKey,
        offer: String,
        reply: oneshot::Sender<Result<String, String>>,
    },
    Accept {
        peer: PublicKey,
        answer: String,
    },
    Send {
        peer: PublicKey,
        packet: Bytes,
    },
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

impl Ice {
    /// The ICE of the place of the key `own`, a UDP socket bound on each local address, asking the STUN servers
    /// `stun` — by their names — where each is seen from outside.
    ///
    /// # Errors
    /// Where no UDP socket can be bound.
    pub async fn start(own: PublicKey, stun: &[String]) -> std::io::Result<Self> {
        let mut servers = Vec::new();
        for name in stun {
            if let Ok(found) = tokio::net::lookup_host(name.as_str()).await {
                servers.extend(found);
            }
        }
        let mut sockets = Vec::new();
        for ip in host_addresses() {
            if let Ok(socket) = UdpSocket::bind(SocketAddr::new(ip, 0)).await {
                sockets.push(Arc::new(socket));
            }
        }
        let (arrived, arrivals) = mpsc::channel(RECEIVED_AHEAD);
        for socket in &sockets {
            tokio::spawn(read(Arc::clone(socket), arrived.clone()));
        }
        let (orders, taken) = mpsc::unbounded_channel();
        let (delivered, received) = mpsc::channel(RECEIVED_AHEAD);
        let (opened, open) = watch::channel(HashSet::new());
        let (told, outside) = watch::channel(Vec::new());
        let agent = Agent {
            told,
            sockets,
            reflexive: stun::Reflexive::new(servers),
            peers: HashMap::new(),
            early: std::collections::VecDeque::new(),
            delivered,
            opened,
        };
        tokio::spawn(agent.run(taken, arrivals));
        Ok(Self {
            own: addr_of(&own),
            orders,
            received: Arc::new(Mutex::new(Some(received))),
            open,
            outside,
        })
    }

    /// An offer of ICE to the peer `peer`, to be sent to it.
    pub(crate) async fn offer(&self, peer: PublicKey) -> Result<String, String> {
        let (reply, offered) = oneshot::channel();
        self.orders.send(Order::Offer { peer, reply }).map_err(|_| "ICE is stopped")?;
        offered.await.map_err(|_| "ICE is stopped")?
    }

    /// The answer to the peer `peer`'s offer `offer`.
    pub(crate) async fn answer(&self, peer: PublicKey, offer: String) -> Result<String, String> {
        let (reply, answered) = oneshot::channel();
        self.orders
            .send(Order::Answer { peer, offer, reply })
            .map_err(|_| "ICE is stopped")?;
        answered.await.map_err(|_| "ICE is stopped")?
    }

    /// Where this place's sockets are seen from outside, as STUN servers said.
    #[must_use]
    pub fn seen_from_outside(&self) -> Vec<SocketAddr> {
        self.outside.borrow().clone()
    }

    /// Takes the peer `peer`'s answer to the offer made it.
    pub(crate) fn accept(&self, peer: PublicKey, answer: String) {
        let _ = self.orders.send(Order::Accept { peer, answer });
    }
}

/// The interfaces' addresses a peer may reach the socket at: those the machine routes out by, and loopback.
fn host_addresses() -> Vec<IpAddr> {
    let mut addresses = vec![IpAddr::V4(Ipv4Addr::LOCALHOST)];
    // A socket connected — no packet sent — tells the address the machine routes out by.
    if let Ok(socket) = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        && socket.connect((Ipv4Addr::new(192, 0, 2, 1), 9)).is_ok()
        && let Ok(local) = socket.local_addr()
    {
        addresses.push(local.ip());
    }
    addresses
}

/// A peer's WebRTC state: its offer waiting for an answer, and its channel once open.
struct Peering {
    rtc: Rtc,
    pending: Option<SdpPendingOffer>,
    channel: Option<ChannelId>,
}

/// A datagram that arrived: its bytes, where from, and the address of the socket it came to.
struct Arrival {
    datagram: Vec<u8>,
    source: SocketAddr,
    destination: SocketAddr,
}

/// Reads what comes to `socket`, each datagram with the socket's address, as the agent takes them.
async fn read(socket: Arc<UdpSocket>, arrived: mpsc::Sender<Arrival>) {
    let Ok(destination) = socket.local_addr() else { return };
    let mut buffer = vec![0; 2048];
    while let Ok((count, source)) = socket.recv_from(&mut buffer).await {
        let arrival = Arrival {
            datagram: buffer[..count].to_vec(),
            source,
            destination,
        };
        if arrived.send(arrival).await.is_err() {
            return;
        }
    }
}

/// How long a datagram no peer takes yet is kept for one to take, as one comes to: a peer's first DTLS flight can come
/// before this side's ICE says it is connected, and would wait out a retransmission otherwise.
const EARLY_KEPT: Duration = Duration::from_secs(2);
/// How many such datagrams are kept.
const EARLY_MAX: usize = 64;

/// The task that holds every peer's WebRTC state, sending from a socket per local address; and the datagrams no peer
/// took yet.
struct Agent {
    early: std::collections::VecDeque<(Instant, Arrival)>,
    reflexive: stun::Reflexive,
    told: watch::Sender<Vec<SocketAddr>>,
    sockets: Vec<Arc<UdpSocket>>,
    peers: HashMap<PublicKey, Peering>,
    delivered: mpsc::Sender<(PublicKey, Bytes)>,
    opened: watch::Sender<HashSet<PublicKey>>,
}

impl Agent {
    async fn run(mut self, mut orders: mpsc::UnboundedReceiver<Order>, mut arrivals: mpsc::Receiver<Arrival>) {
        let mut due = HashMap::<PublicKey, Instant>::new();
        loop {
            let next = due
                .values()
                .copied()
                .chain(self.reflexive.due())
                .min()
                .unwrap_or_else(|| Instant::now() + Duration::from_secs(1));
            tokio::select! {
                arrival = arrivals.recv() => {
                    let Some(arrival) = arrival else { return };
                    self.received(arrival, &mut due);
                }
                order = orders.recv() => {
                    let Some(order) = order else { return };
                    self.ordered(order, &mut due);
                }
                () = tokio::time::sleep_until(next.into()) => {
                    let now = Instant::now();
                    if self.reflexive.due().is_some_and(|at| at <= now) {
                        self.asked_stun();
                    }
                    let late: Vec<PublicKey> = due.iter().filter(|(_, at)| **at <= now).map(|(peer, _)| *peer).collect();
                    for peer in late {
                        if let Some(peering) = self.peers.get_mut(&peer) {
                            let _ = peering.rtc.handle_input(Input::Timeout(now));
                        }
                        self.drained(peer, &mut due);
                    }
                }
            }
        }
    }

    /// A datagram that arrived, handed to the peer whose state takes it — kept a while where none takes it yet; and
    /// each kept before tried again, as what came may have readied a peer to take it.
    fn received(&mut self, arrival: Arrival, due: &mut HashMap<PublicKey, Instant>) {
        if self.reflexive.take(&arrival.datagram) {
            let mut seen: Vec<SocketAddr> = self.reflexive.seen.values().copied().collect();
            seen.sort();
            seen.dedup();
            self.told.send_if_modified(|told| std::mem::replace(told, seen.clone()) != seen);
            return;
        }
        if self.taken(&arrival, due) {
            self.retried(due);
            return;
        }
        if self.early.len() == EARLY_MAX {
            self.early.pop_front();
        }
        self.early.push_back((Instant::now(), arrival));
    }

    /// Whether a peer's state took `arrival` — drained after — or it is no datagram any could take.
    fn taken(&mut self, arrival: &Arrival, due: &mut HashMap<PublicKey, Instant>) -> bool {
        let Ok(receive) = Receive::new(Protocol::Udp, arrival.source, arrival.destination, &arrival.datagram) else {
            return true;
        };
        let input = Input::Receive(Instant::now(), receive);
        let peer = self
            .peers
            .iter()
            .find(|(_, peering)| peering.rtc.accepts(&input))
            .map(|(peer, _)| *peer);
        let Some(peer) = peer else { return false };
        if let Some(peering) = self.peers.get_mut(&peer) {
            let _ = peering.rtc.handle_input(input);
        }
        self.drained(peer, due);
        true
    }

    /// The datagrams kept tried again: those a peer now takes taken, those past `EARLY_KEPT` let go of.
    fn retried(&mut self, due: &mut HashMap<PublicKey, Instant>) {
        for (at, arrival) in std::mem::take(&mut self.early) {
            if at.elapsed() < EARLY_KEPT && !self.taken(&arrival, due) {
                self.early.push_back((at, arrival));
            }
        }
    }

    /// Asks the STUN servers where each socket is seen from outside, from that socket.
    fn asked_stun(&mut self) {
        let locals: Vec<SocketAddr> = self.sockets.iter().filter_map(|socket| socket.local_addr().ok()).collect();
        for (local, server, request) in self.reflexive.requests(&locals) {
            if let Some(socket) = self.sockets.iter().find(|socket| socket.local_addr().is_ok_and(|at| at == local)) {
                let _ = socket.try_send_to(&request, server);
            }
        }
    }

    /// A WebRTC state of this place's candidates: each socket's address, and where it is seen from outside, where a
    /// STUN server said and it is another.
    fn rtc(&self) -> Rtc {
        let mut rtc = Rtc::new(Instant::now());
        for socket in &self.sockets {
            let Ok(local) = socket.local_addr() else { continue };
            if let Ok(candidate) = Candidate::host(local, "udp") {
                rtc.add_local_candidate(candidate);
            }
            if let Some(seen) = self.reflexive.seen.get(&local).filter(|seen| **seen != local)
                && let Ok(candidate) = Candidate::server_reflexive(*seen, local, "udp")
            {
                rtc.add_local_candidate(candidate);
            }
        }
        rtc
    }

    fn ordered(&mut self, order: Order, due: &mut HashMap<PublicKey, Instant>) {
        match order {
            Order::Offer { peer, reply } => {
                let mut rtc = self.rtc();
                let mut change = rtc.sdp_api();
                change.add_channel_with_config(ChannelConfig {
                    label: CHANNEL.into(),
                    ordered: false,
                    reliability: Reliability::MaxRetransmits { retransmits: 0 },
                    ..ChannelConfig::default()
                });
                let Some((offer, pending)) = change.apply() else {
                    let _ = reply.send(Err("nothing to offer".into()));
                    return;
                };
                self.peers.insert(
                    peer,
                    Peering {
                        rtc,
                        pending: Some(pending),
                        channel: None,
                    },
                );
                let _ = reply.send(Ok(offer.to_sdp_string()));
            }
            Order::Answer { peer, offer, reply } => {
                let mut rtc = self.rtc();
                let answered = SdpOffer::from_sdp_string(&offer)
                    .map_err(|error| error.to_string())
                    .and_then(|offer| rtc.sdp_api().accept_offer(offer).map_err(|error| error.to_string()));
                match answered {
                    Ok(answer) => {
                        self.peers.insert(
                            peer,
                            Peering {
                                rtc,
                                pending: None,
                                channel: None,
                            },
                        );
                        let _ = reply.send(Ok(answer.to_sdp_string()));
                    }
                    Err(why) => {
                        let _ = reply.send(Err(why));
                    }
                }
            }
            Order::Accept { peer, answer } => {
                let Some(peering) = self.peers.get_mut(&peer) else { return };
                let (Some(pending), Ok(answer)) = (peering.pending.take(), SdpAnswer::from_sdp_string(&answer)) else {
                    return;
                };
                let _ = peering.rtc.sdp_api().accept_answer(pending, answer);
            }
            Order::Send { peer, packet } => {
                let Some(peering) = self.peers.get_mut(&peer) else { return };
                let Some(id) = peering.channel else { return };
                if let Some(mut channel) = peering.rtc.channel(id) {
                    let _ = channel.write(true, &packet);
                }
            }
        }
        self.drained_all(due);
    }

    fn drained_all(&mut self, due: &mut HashMap<PublicKey, Instant>) {
        let peers: Vec<PublicKey> = self.peers.keys().copied().collect();
        for peer in peers {
            self.drained(peer, due);
        }
    }

    /// The peer `peer`'s state drained of all it has to do, till it waits for its next time.
    fn drained(&mut self, peer: PublicKey, due: &mut HashMap<PublicKey, Instant>) {
        loop {
            let Some(peering) = self.peers.get_mut(&peer) else { return };
            let Ok(output) = peering.rtc.poll_output() else {
                self.gone(peer, due);
                return;
            };
            match output {
                Output::Timeout(at) => {
                    due.insert(peer, at);
                    return;
                }
                Output::Transmit(transmit) => {
                    let socket = self
                        .sockets
                        .iter()
                        .find(|socket| socket.local_addr().is_ok_and(|local| local == transmit.source));
                    if let Some(socket) = socket {
                        let _ = socket.try_send_to(&transmit.contents, transmit.destination);
                    }
                }
                Output::Event(Event::ChannelOpen(id, _)) => {
                    peering.channel = Some(id);
                    self.opened.send_modify(|open| {
                        open.insert(peer);
                    });
                }
                Output::Event(Event::ChannelData(data)) => {
                    let _ = self.delivered.try_send((peer, Bytes::from(data.data)));
                }
                Output::Event(Event::IceConnectionStateChange(IceConnectionState::Disconnected) | Event::ChannelClose(_)) => {
                    self.gone(peer, due);
                    return;
                }
                Output::Event(_) => {}
            }
        }
    }

    fn gone(&mut self, peer: PublicKey, due: &mut HashMap<PublicKey, Instant>) {
        self.peers.remove(&peer);
        due.remove(&peer);
        self.opened.send_modify(|open| {
            open.remove(&peer);
        });
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

/// A machine's service with the ICE offers its peers send answered before it: an offer at `OFFER_PATH` answered by
/// the place's ICE, every other request the service's.
#[derive(Debug, Clone)]
pub(crate) struct Answering<S> {
    pub(crate) ice: Ice,
    pub(crate) service: S,
}

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
        if request.uri().path() != OFFER_PATH || request.method() != http::Method::POST {
            let answered = self.service.call(request);
            return Box::pin(async move { Ok(answered.await?.map(http_body_util::Either::Left)) });
        }
        let ice = self.ice.clone();
        Box::pin(async move {
            let Some(crate::Remote(peer)) = request.extensions().get::<crate::Remote>().copied() else {
                return Ok(refused(http::StatusCode::FORBIDDEN, "no peer"));
            };
            let body = http_body_util::BodyExt::collect(request.into_body()).await;
            let Ok(offer) = body.map(|body| String::from_utf8_lossy(&body.to_bytes()).into_owned()) else {
                return Ok(refused(http::StatusCode::BAD_REQUEST, "the offer was cut off"));
            };
            Ok(match ice.answer(peer, offer).await {
                Ok(answer) => http::Response::new(http_body_util::Either::Right(http_body_util::Full::new(Bytes::from(answer)))),
                Err(why) => refused(http::StatusCode::BAD_REQUEST, &why),
            })
        })
    }
}

fn refused<B>(status: http::StatusCode, why: &str) -> http::Response<http_body_util::Either<B, http_body_util::Full<Bytes>>> {
    let mut response = http::Response::new(http_body_util::Either::Right(http_body_util::Full::new(Bytes::from(
        why.to_owned(),
    ))));
    *response.status_mut() = status;
    response
}
