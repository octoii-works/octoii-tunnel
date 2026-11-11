//! The relay protocol as a home speaks it, served here natively over a WebSocket: the tunnel's own endpoints prove
//! their keys to it and reach each other through it, as they would through any relay.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::routing::get;
use bytes::Bytes;
use futures_util::{SinkExt as _, StreamExt as _};
use http::Request;
use octoii_relay::protocol::{self, Challenge, Route};
use octoii_tunnel::{EndpointAddr, RelayConfig, RelayUrl, SecretKey, Tunnel, Via};
use tokio::sync::mpsc;

/// A home in memory: each proved key's sender, and how many frames it forwarded.
#[derive(Clone, Default)]
struct Home {
    clients: Arc<Mutex<HashMap<net_base::PublicKey, mpsc::UnboundedSender<Bytes>>>>,
    forwarded: Arc<AtomicUsize>,
}

async fn relay(upgrade: WebSocketUpgrade, State(home): State<Home>) -> axum::response::Response {
    upgrade
        .protocols(protocol::PROTOCOLS)
        .on_upgrade(move |socket| client(socket, home))
}

async fn client(socket: WebSocket, home: Home) {
    let (mut sink, mut stream) = socket.split();
    let challenge = Challenge::new();
    if sink.send(Message::Binary(challenge.frame())).await.is_err() {
        return;
    }
    let Some(Ok(Message::Binary(answer))) = stream.next().await else {
        return;
    };
    let Ok(key) = challenge.verify(&answer) else {
        let _ = sink.send(Message::Binary(protocol::denied("signature invalid"))).await;
        return;
    };
    let _ = sink.send(Message::Binary(protocol::confirmed())).await;
    let (sender, mut outgoing) = mpsc::unbounded_channel();
    home.clients.lock().expect("held").insert(key, sender.clone());
    tokio::spawn(async move {
        while let Some(frame) = outgoing.recv().await {
            if sink.send(Message::Binary(frame)).await.is_err() {
                return;
            }
        }
    });
    while let Some(Ok(message)) = stream.next().await {
        let Message::Binary(frame) = message else { continue };
        match protocol::route(&key, &frame) {
            Ok(Route::Forward { to, frame }) => {
                let target = home.clients.lock().expect("held").get(&to).cloned();
                match target {
                    Some(target) => {
                        home.forwarded.fetch_add(1, Ordering::Relaxed);
                        let _ = target.send(frame);
                    }
                    None => {
                        let _ = sender.send(protocol::gone(&to));
                    }
                }
            }
            Ok(Route::Answer(frame)) => {
                let _ = sender.send(frame);
            }
            Err(_) => {}
        }
    }
    home.clients.lock().expect("held").remove(&key);
}

async fn home() -> (RelayUrl, Home) {
    let home = Home::default();
    let router = axum::Router::new()
        .route(protocol::RELAY_PATH, get(relay))
        .route(protocol::PROBE_PATH, get(|| async { "" }))
        .route(protocol::PORTAL_PATH, get(|| async { http::StatusCode::NO_CONTENT }))
        .with_state(home.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bound");
    let port = listener.local_addr().expect("an address").port();
    tokio::spawn(async move { axum::serve(listener, router).await });
    (format!("http://127.0.0.1:{port}").parse().expect("a URL"), home)
}

#[tokio::test(flavor = "multi_thread")]
async fn the_tunnel_s_endpoints_prove_their_keys_to_a_home_and_reach_each_other_through_it() {
    let (url, home) = home().await;
    let machine = Tunnel::builder(SecretKey::generate())
        .relays(vec![RelayConfig::new(url.clone(), None)])
        .bind()
        .await
        .expect("bound");
    let device = Tunnel::builder(SecretKey::generate())
        .relays(vec![RelayConfig::new(url.clone(), None)])
        .bind()
        .await
        .expect("bound");
    tokio::time::timeout(Duration::from_secs(10), machine.online())
        .await
        .expect("online in time");
    let serving = machine.clone();
    tokio::spawn(async move {
        serving
            .serve(tower::service_fn(|_request: Request<octoii_tunnel::Body>| async {
                Ok::<_, std::convert::Infallible>(http::Response::new(http_body_util::Full::new(Bytes::from_static(b"here"))))
            }))
            .await;
    });
    let addr = EndpointAddr::new(machine.key()).with_relay_url(url);
    let peer = tokio::time::timeout(Duration::from_secs(10), device.connect(addr))
        .await
        .expect("in time")
        .expect("reached");
    let answered = peer
        .request(Request::get("/").body(Bytes::new()).expect("a request"))
        .await
        .expect("answered");
    assert_eq!(answered.into_body(), Bytes::from_static(b"here"));
    assert!(home.forwarded.load(Ordering::Relaxed) > 0, "the home carried their first packets");
    assert_eq!(home.clients.lock().expect("held").len(), 2, "both proved their keys");
    // Two places that can reach each other move their session off the relay, which told each where the other is.
    let direct = async {
        while peer.path().map(|path| path.via) != Some(Via::Direct) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(10), direct)
        .await
        .expect("a direct path in time");
    device.close().await;
    machine.close().await;
}

#[test]
fn a_datagram_is_forwarded_with_the_sender_s_key_in_place_of_the_addressee_s_and_a_ping_answered() {
    let from = SecretKey::generate().public();
    let to = SecretKey::generate().public();
    let mut frame = vec![4];
    frame.extend_from_slice(to.as_bytes());
    frame.extend_from_slice(&[0, 1, 2, 3]);
    let Ok(Route::Forward { to: addressee, frame: out }) = protocol::route(&from, &frame) else {
        panic!("forwarded")
    };
    assert_eq!(addressee, to);
    assert_eq!(out[0], 6);
    assert_eq!(&out[1..33], from.as_bytes());
    assert_eq!(&out[33..], &[0, 1, 2, 3]);
    let ping = [9, 1, 2, 3, 4, 5, 6, 7, 8];
    assert_eq!(
        protocol::route(&from, &ping),
        Ok(Route::Answer(Bytes::from_static(&[10, 1, 2, 3, 4, 5, 6, 7, 8])))
    );
    assert_eq!(protocol::route(&from, &[9, 1]), Err(protocol::Refused::Malformed));
    assert_eq!(Challenge::new().verify(&[1, 0]), Err(protocol::Refused::Malformed));
}
