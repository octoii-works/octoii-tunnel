//! ICE in a page: the browser's own — a peer connection per peer, its data channel the path, its candidates gathered
//! by the browser and trickled as it finds them. A page only dials, so it only offers.

use std::collections::HashMap;
use std::net::SocketAddr;

use bytes::Bytes;
use js_sys::{Array, Reflect, Uint8Array};
use net::PublicKey;
use tokio::sync::mpsc;
use wasm_bindgen::JsCast as _;
use wasm_bindgen::prelude::{Closure, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    MessageEvent, RtcConfiguration, RtcDataChannel, RtcDataChannelInit, RtcDataChannelState, RtcDataChannelType, RtcIceCandidateInit,
    RtcIceServer, RtcPeerConnection, RtcPeerConnectionIceEvent, RtcSdpType, RtcSessionDescriptionInit,
};

use super::{Agency, CHANNEL, Described, Order};

/// How much a channel may hold unsent before a packet is let go of, as a full socket buffer drops one.
const BUFFERED_MAX: u32 = 1 << 20;

/// Starts the task that holds a page's ICE, handed `agency`, the browser asking the STUN servers `stun` — by their
/// names — where the page is seen from outside.
pub(super) fn start(agency: Agency, stun: &[String]) {
    let servers: Vec<String> = stun.iter().map(|name| format!("stun:{name}")).collect();
    wasm_bindgen_futures::spawn_local(run(agency, servers));
}

/// A peer's connection, its channel, and the handlers the browser calls, kept as long as it is.
struct Peering {
    connection: RtcPeerConnection,
    channel: RtcDataChannel,
    _handlers: Vec<Closure<dyn FnMut(JsValue)>>,
}

impl Drop for Peering {
    fn drop(&mut self) {
        self.connection.close();
    }
}

/// Takes the orders of the page's ICE, one at a time, as their one owner.
async fn run(mut agency: Agency, servers: Vec<String>) {
    let mut peers = HashMap::new();
    while let Some(order) = agency.orders.recv().await {
        match order {
            Order::Offer { peer, reply } => {
                let offered = offer(peer, &servers, &agency).await;
                let _ = reply.send(offered.map(|(peering, described)| {
                    peers.insert(peer, peering);
                    described
                }));
            }
            Order::Accept { peer, answer } => {
                if let Some(peering) = peers.get(&peer) {
                    let init = RtcSessionDescriptionInit::new(RtcSdpType::Answer);
                    init.set_sdp(&answer);
                    let _ = JsFuture::from(peering.connection.set_remote_description(&init)).await;
                }
            }
            Order::Candidate { peer, candidate } => {
                if let Some(peering) = peers.get(&peer) {
                    let _ = add_candidate(&peering.connection, &candidate).await;
                }
            }
            Order::Send { peer, packet } => {
                if let Some(peering) = peers.get(&peer) {
                    send(&peering.channel, &packet);
                }
            }
        }
    }
}

/// Sends `packet` over `channel` where it is open and not full; lets it go otherwise, as QUIC resends what is lost.
fn send(channel: &RtcDataChannel, packet: &[u8]) {
    if channel.ready_state() == RtcDataChannelState::Open && channel.buffered_amount() < BUFFERED_MAX {
        let _ = channel.send_with_u8_array(packet);
    }
}

/// A connection to the peer `peer`, its channel made and its offer set: the peering, and the offer with where the
/// candidates the browser finds go.
async fn offer(peer: PublicKey, servers: &[String], agency: &Agency) -> Result<(Peering, Described), String> {
    let connection = RtcPeerConnection::new_with_configuration(&configuration(servers)).map_err(|error| why(&error))?;
    let init = RtcDataChannelInit::new();
    init.set_ordered(false);
    init.set_max_retransmits(0);
    let channel = connection.create_data_channel_with_data_channel_dict(CHANNEL, &init);
    channel.set_binary_type(RtcDataChannelType::Arraybuffer);
    let (found, candidates) = mpsc::unbounded_channel();
    let handlers = handled(peer, &connection, &channel, agency, found);
    let offer = JsFuture::from(connection.create_offer()).await.map_err(|error| why(&error))?;
    let sdp = Reflect::get(&offer, &"sdp".into())
        .ok()
        .and_then(|sdp| sdp.as_string())
        .ok_or("an offer of no description")?;
    let init = RtcSessionDescriptionInit::new(RtcSdpType::Offer);
    init.set_sdp(&sdp);
    JsFuture::from(connection.set_local_description(&init))
        .await
        .map_err(|error| why(&error))?;
    let peering = Peering {
        connection,
        channel,
        _handlers: handlers,
    };
    Ok((peering, Described { sdp, candidates }))
}

/// A connection's configuration: the STUN servers `servers`, by their URLs.
fn configuration(servers: &[String]) -> RtcConfiguration {
    let configuration = RtcConfiguration::new();
    let list = Array::new();
    for url in servers {
        let server = RtcIceServer::new();
        server.set_urls(&JsValue::from_str(url));
        list.push(&server);
    }
    configuration.set_ice_servers(&list);
    configuration
}

/// The handlers of `connection` and `channel`: each candidate the browser finds sent to `found` — those seen from
/// outside told — the channel's opening and closing told, and what comes over it delivered as the peer `peer`'s.
fn handled(
    peer: PublicKey,
    connection: &RtcPeerConnection,
    channel: &RtcDataChannel,
    agency: &Agency,
    found: mpsc::UnboundedSender<String>,
) -> Vec<Closure<dyn FnMut(JsValue)>> {
    let told = agency.told.clone();
    let on_candidate = Closure::<dyn FnMut(JsValue)>::new(move |event: JsValue| {
        let event: RtcPeerConnectionIceEvent = event.unchecked_into();
        let Some(candidate) = event.candidate().map(|candidate| candidate.candidate()) else {
            return;
        };
        if candidate.is_empty() {
            return;
        }
        if let Some(seen) = seen_from_outside(&candidate) {
            told.send_if_modified(|told| {
                let new = !told.contains(&seen);
                if new {
                    told.push(seen);
                }
                new
            });
        }
        let _ = found.send(candidate);
    });
    connection.set_onicecandidate(Some(on_candidate.as_ref().unchecked_ref()));
    let opened = agency.opened.clone();
    let on_open = Closure::<dyn FnMut(JsValue)>::new(move |_: JsValue| {
        opened.send_modify(|open| {
            open.insert(peer);
        });
    });
    channel.set_onopen(Some(on_open.as_ref().unchecked_ref()));
    let closed = agency.opened.clone();
    let on_close = Closure::<dyn FnMut(JsValue)>::new(move |_: JsValue| {
        closed.send_modify(|open| {
            open.remove(&peer);
        });
    });
    channel.set_onclose(Some(on_close.as_ref().unchecked_ref()));
    let delivered = agency.delivered.clone();
    let on_message = Closure::<dyn FnMut(JsValue)>::new(move |event: JsValue| {
        let event: MessageEvent = event.unchecked_into();
        let packet = Bytes::from(Uint8Array::new(&event.data()).to_vec());
        let _ = delivered.try_send((peer, packet));
    });
    channel.set_onmessage(Some(on_message.as_ref().unchecked_ref()));
    vec![on_candidate, on_open, on_close, on_message]
}

/// The address a server-reflexive candidate `candidate` says the page is seen at.
fn seen_from_outside(candidate: &str) -> Option<SocketAddr> {
    let fields: Vec<&str> = candidate.split_whitespace().collect();
    let kind = fields.iter().position(|field| *field == "typ")?;
    if fields.get(kind + 1) != Some(&"srflx") {
        return None;
    }
    let ip = fields.get(4)?.parse().ok()?;
    let port = fields.get(5)?.parse().ok()?;
    Some(SocketAddr::new(ip, port))
}

/// Adds the peer's candidate `candidate` — an attribute's value, as `candidate:…` — to `connection`.
async fn add_candidate(connection: &RtcPeerConnection, candidate: &str) -> Result<(), String> {
    let init = RtcIceCandidateInit::new(candidate);
    init.set_sdp_m_line_index(Some(0));
    let added = connection.add_ice_candidate_with_opt_rtc_ice_candidate_init(Some(&init));
    JsFuture::from(added).await.map(|_| ()).map_err(|error| why(&error))
}

/// What a browser's error says.
fn why(error: &JsValue) -> String {
    error.as_string().unwrap_or_else(|| format!("{error:?}"))
}
