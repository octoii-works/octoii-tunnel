//! ICE on a machine: a UDP socket bound on each local address, a WebRTC state of its own per peer, sans I/O — the
//! socket's datagrams handed to the state that takes them, STUN's answers read before — and STUN servers asked where
//! each socket is seen from outside.

use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use net::PublicKey;
use str0m::change::{SdpAnswer, SdpOffer, SdpPendingOffer};
use str0m::channel::{ChannelConfig, ChannelId, Reliability};
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};
use tokio::net::UdpSocket;
use tokio::sync::{mpsc, watch};

use super::{Agency, CHANNEL, Described, Order, RECEIVED_AHEAD, stun};

/// Starts the task that holds a machine's ICE, handed `agency`: a UDP socket bound on each local address, the STUN
/// servers `stun` — by their names, looked up by the task, so binding waits for no lookup — asked where each is seen
/// from outside.
pub(super) fn start(agency: Agency, stun: &[String]) {
    let sockets: Vec<Arc<UdpSocket>> = host_addresses().into_iter().filter_map(bound).map(Arc::new).collect();
    let (arrived, arrivals) = mpsc::channel(RECEIVED_AHEAD);
    for socket in &sockets {
        tokio::spawn(read(Arc::clone(socket), arrived.clone()));
    }
    let mut agent = Agent {
        told: agency.told,
        sockets,
        reflexive: stun::Reflexive::new(Vec::new()),
        peers: HashMap::new(),
        early: std::collections::VecDeque::new(),
        delivered: agency.delivered,
        opened: agency.opened,
    };
    let names = stun.to_vec();
    tokio::spawn(async move {
        agent.reflexive = stun::Reflexive::new(looked_up(&names).await);
        agent.run(agency.orders, arrivals).await;
    });
}

/// A UDP socket bound at `ip`, on a port of the system's choice.
fn bound(ip: IpAddr) -> Option<UdpSocket> {
    let socket = std::net::UdpSocket::bind(SocketAddr::new(ip, 0)).ok()?;
    socket.set_nonblocking(true).ok()?;
    UdpSocket::from_std(socket).ok()
}

/// The addresses the names `names` have; none of a name that has none.
async fn looked_up(names: &[String]) -> Vec<SocketAddr> {
    let mut found = Vec::new();
    for name in names {
        if let Ok(addresses) = tokio::net::lookup_host(name.as_str()).await {
            found.extend(addresses);
        }
    }
    found
}

/// The candidate of the socket at `local` seen from outside at `seen`; none where it is seen at its own address.
fn reflexive(seen: SocketAddr, local: SocketAddr) -> Option<Candidate> {
    (seen != local)
        .then(|| Candidate::server_reflexive(seen, local, "udp").ok())
        .flatten()
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

/// A peer's WebRTC state: its offer waiting for an answer, its channel once open, and where the candidates found after
/// its description go to be sent it.
struct Peering {
    rtc: Rtc,
    pending: Option<SdpPendingOffer>,
    channel: Option<ChannelId>,
    found: mpsc::UnboundedSender<String>,
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
        let before = self.reflexive.seen.clone();
        if self.reflexive.take(&arrival.datagram) {
            let mut seen: Vec<SocketAddr> = self.reflexive.seen.values().copied().collect();
            seen.sort();
            seen.dedup();
            self.told.send_if_modified(|told| std::mem::replace(told, seen.clone()) != seen);
            let changed = self.reflexive.seen.iter().filter(|(local, seen)| before.get(*local) != Some(*seen));
            let found: Vec<Candidate> = changed.filter_map(|(local, seen)| reflexive(*seen, *local)).collect();
            self.found(&found, due);
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
            if let Some(candidate) = self.reflexive.seen.get(&local).and_then(|seen| reflexive(*seen, local)) {
                rtc.add_local_candidate(candidate);
            }
        }
        rtc
    }

    /// The candidates `found` after the peers' descriptions were given, added to each peer's state and sent it.
    fn found(&mut self, found: &[Candidate], due: &mut HashMap<PublicKey, Instant>) {
        for peering in self.peers.values_mut() {
            for candidate in found {
                if let Some(added) = peering.rtc.add_local_candidate(candidate.clone()) {
                    let _ = peering.found.send(added.to_sdp_string());
                }
            }
        }
        self.drained_all(due);
    }

    /// The peer `peer`'s state `rtc` kept, its description `sdp` given back with where its later candidates come.
    fn peering(&mut self, peer: PublicKey, rtc: Rtc, pending: Option<SdpPendingOffer>, sdp: String) -> Described {
        let (found, candidates) = mpsc::unbounded_channel();
        let peering = Peering {
            rtc,
            pending,
            channel: None,
            found,
        };
        self.peers.insert(peer, peering);
        Described { sdp, candidates }
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
                let _ = reply.send(Ok(self.peering(peer, rtc, Some(pending), offer.to_sdp_string())));
            }
            Order::Answer { peer, offer, reply } => {
                let mut rtc = self.rtc();
                let answered = SdpOffer::from_sdp_string(&offer)
                    .map_err(|error| error.to_string())
                    .and_then(|offer| rtc.sdp_api().accept_offer(offer).map_err(|error| error.to_string()));
                let _ = reply.send(answered.map(|answer| self.peering(peer, rtc, None, answer.to_sdp_string())));
            }
            Order::Accept { peer, answer } => {
                let Some(peering) = self.peers.get_mut(&peer) else { return };
                let (Some(pending), Ok(answer)) = (peering.pending.take(), SdpAnswer::from_sdp_string(&answer)) else {
                    return;
                };
                let _ = peering.rtc.sdp_api().accept_answer(pending, answer);
            }
            Order::Candidate { peer, candidate } => {
                let Some(peering) = self.peers.get_mut(&peer) else { return };
                if let Ok(candidate) = Candidate::from_sdp_string(&candidate) {
                    peering.rtc.add_remote_candidate(candidate);
                }
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

#[cfg(test)]
mod tests {
    use net::SecretKey;
    use tokio::sync::oneshot;

    use super::*;

    /// An agent of no sockets, asking the STUN server `server`, and where what it delivers goes.
    fn agent(server: SocketAddr) -> Agent {
        let (delivered, _) = mpsc::channel(1);
        Agent {
            early: std::collections::VecDeque::new(),
            reflexive: stun::Reflexive::new(vec![server]),
            told: watch::channel(Vec::new()).0,
            sockets: Vec::new(),
            peers: HashMap::new(),
            delivered,
            opened: watch::channel(HashSet::new()).0,
        }
    }

    #[test]
    fn a_candidate_found_after_an_offer_is_trickled_to_its_peer_and_one_it_sends_is_taken() {
        let server: SocketAddr = "198.51.100.1:3478".parse().expect("an address");
        let mut agent = agent(server);
        let mut due = HashMap::new();
        let peer = SecretKey::generate().public();
        let (reply, mut offered) = oneshot::channel();
        agent.ordered(Order::Offer { peer, reply }, &mut due);
        let mut described = offered.try_recv().expect("offered").expect("an offer");
        assert!(described.sdp.starts_with("v=0"), "a description");
        assert!(described.candidates.try_recv().is_err(), "nothing found yet");

        let local: SocketAddr = "192.168.1.2:5001".parse().expect("a LAN address");
        let (_, _, request) = agent.reflexive.requests(&[local])[0];
        let transaction: stun::Transaction = request[8..20].try_into().expect("an id");
        let seen: SocketAddr = "203.0.113.9:40001".parse().expect("an address");
        let answer = Arrival {
            datagram: stun::success(&transaction, seen),
            source: server,
            destination: local,
        };
        agent.received(answer, &mut due);
        let trickled = described.candidates.try_recv().expect("trickled");
        let candidate = Candidate::from_sdp_string(&trickled).expect("a candidate");
        assert_eq!((candidate.addr(), candidate.kind()), (seen, str0m::CandidateKind::ServerReflexive));
        assert!(described.candidates.try_recv().is_err(), "once");

        let theirs = Candidate::host("192.168.1.3:6001".parse().expect("an address"), "udp").expect("a candidate");
        agent.ordered(
            Order::Candidate {
                peer,
                candidate: theirs.to_sdp_string(),
            },
            &mut due,
        );
        assert!(agent.peers.contains_key(&peer), "still negotiating");
    }
}
