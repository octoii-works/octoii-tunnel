//! A machine and a device on the tunnel: the device reaches the machine by its key, through a relay, and they speak
//! HTTP/3 — requests whose bodies stream both ways, each knowing the device's key, and a WebSocket's stream by
//! extended CONNECT.

use std::convert::Infallible;
use std::time::Duration;

use bytes::Bytes;
use futures_util::{SinkExt as _, StreamExt as _};
use http::{Method, Request, Response, StatusCode};
use http_body_util::{BodyExt as _, Full};
use net::test_utils::run_relay_server;
use octoii_tunnel::{Body, CaTlsConfig, EndpointAddr, Message, OnConnect, Remote, SecretKey, Tunnel, socket};
use tower::service_fn;

/// Answers `/who` with the key of who asked; echoes a POST's body; and, for a CONNECT, echoes its stream.
async fn handle(mut request: Request<Body>) -> Result<Response<Full<Bytes>>, Infallible> {
    let remote = request.extensions().get::<Remote>().copied().expect("the peer's key");
    if request.method() == Method::CONNECT {
        let connect = request.extensions_mut().remove::<OnConnect>().expect("a stream to come");
        tokio::spawn(async move {
            let mut socket = socket::server(connect.stream().await.expect("the stream")).await;
            while let Some(Ok(message)) = socket.next().await {
                if message.is_close() || socket.send(message).await.is_err() {
                    break;
                }
            }
        });
        return Ok(Response::new(Full::default()));
    }
    let body = match request.uri().path() {
        "/who" => Bytes::from(remote.0.to_string()),
        _ => request
            .into_body()
            .collect()
            .await
            .map(http_body_util::Collected::to_bytes)
            .unwrap_or_default(),
    };
    Ok(Response::new(Full::new(body)))
}

async fn place(relay: &net::RelayUrl) -> Tunnel {
    Tunnel::builder(SecretKey::generate())
        .relays(vec![relay.clone().into()])
        .trust(CaTlsConfig::insecure_skip_verify())
        .bind()
        .await
        .expect("bound")
}

#[tokio::test(flavor = "multi_thread")]
async fn a_device_reaches_a_machine_by_its_key_and_relay_and_they_speak_http_3() {
    let (_map, relay, _server) = run_relay_server().await.expect("a relay");
    let machine = place(&relay).await;
    let device = place(&relay).await;
    tokio::time::timeout(Duration::from_secs(10), machine.online())
        .await
        .expect("online in time");
    let serving = machine.clone();
    tokio::spawn(async move { serving.serve(service_fn(handle)).await });

    // The device knows the machine's key and relay alone, as a pairing gives them.
    let addr = EndpointAddr::new(machine.key()).with_relay_url(relay.clone());
    let peer = tokio::time::timeout(Duration::from_secs(10), device.connect(addr))
        .await
        .expect("in time")
        .expect("reached");
    assert_eq!(peer.key(), machine.key());

    let who = peer
        .request(Request::get("/who").body(Bytes::new()).expect("a request"))
        .await
        .expect("answered");
    assert_eq!(who.status(), StatusCode::OK);
    assert_eq!(who.into_body(), Bytes::from(device.key().to_string()));

    let big = Bytes::from(vec![7; 1 << 20]);
    let echoed = peer
        .request(Request::post("/echo").body(big.clone()).expect("a request"))
        .await
        .expect("answered");
    assert_eq!(echoed.into_body(), big, "a megabyte both ways");

    let head = Request::builder().body(()).expect("a head");
    let mut socket = socket::client(peer.websocket("/ws", head).await.expect("connected")).await;
    socket.send(Message::text("ping")).await.expect("sent");
    let big = Message::binary(vec![1; 300 * 1024]);
    socket.send(big.clone()).await.expect("sent");
    assert_eq!(socket.next().await.expect("a message").expect("read"), Message::text("ping"));
    assert_eq!(
        socket.next().await.expect("a message").expect("read"),
        big,
        "a message past the pipe's bound, whole"
    );

    device.close().await;
    machine.close().await;
}

#[test]
fn a_key_file_is_made_once_and_read_back_alike() {
    let folder = tempfile::tempdir().expect("a folder");
    let path = folder.path().join("var/key");
    let made = octoii_tunnel::key::load_or_make(&path).expect("made");
    let read = octoii_tunnel::key::load_or_make(&path).expect("read");
    assert_eq!(made.public(), read.public());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(std::fs::metadata(&path).expect("there").permissions().mode() & 0o777, 0o600);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn two_places_that_cannot_reach_each_other_s_addresses_move_their_session_onto_ice() {
    let (_map, relay, _server) = run_relay_server().await.expect("a relay");
    let bound = || async {
        Tunnel::builder(SecretKey::generate())
            .relays(vec![relay.clone().into()])
            .trust(CaTlsConfig::insecure_skip_verify())
            .without_direct_paths()
            .bind()
            .await
            .expect("bound")
    };
    let machine = bound().await;
    let device = bound().await;
    tokio::time::timeout(Duration::from_secs(10), machine.online())
        .await
        .expect("online in time");
    let serving = machine.clone();
    tokio::spawn(async move { serving.serve(service_fn(handle)).await });
    let addr = EndpointAddr::new(machine.key()).with_relay_url(relay.clone());
    let peer = device.connect(addr).await.expect("reached");
    let started = std::time::Instant::now();
    let moved = async {
        while peer.path().map(|path| path.via) != Some(octoii_tunnel::Via::Ice) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(10), moved).await.expect("on ICE in time");
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "on ICE within a second, not after a retransmission: {:?}",
        started.elapsed()
    );
    let big = Bytes::from(vec![9; 1 << 20]);
    let echoed = peer
        .request(Request::post("/echo").body(big.clone()).expect("a request"))
        .await
        .expect("answered");
    assert_eq!(echoed.into_body(), big, "a megabyte both ways over ICE");
    assert_eq!(peer.path().map(|path| path.via), Some(octoii_tunnel::Via::Ice));
    device.close().await;
    machine.close().await;
}
