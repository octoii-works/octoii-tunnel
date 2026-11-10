//! How long each step of reaching a machine takes, through a test relay.
use std::time::Instant;

use bytes::Bytes;
use http::Request;
use octoii_tunnel::{CaTlsConfig, EndpointAddr, SecretKey, Tunnel};

#[tokio::main]
async fn main() {
    let (_map, relay, _server) = iroh::test_utils::run_relay_server().await.expect("a relay");
    let at = Instant::now();
    let bind = |relay: iroh::RelayUrl| async move {
        Tunnel::builder(SecretKey::generate())
            .relays(vec![relay.into()])
            .trust(CaTlsConfig::insecure_skip_verify())
            .bind()
            .await
            .expect("bound")
    };
    let machine = bind(relay.clone()).await;
    println!("bound {:?}", at.elapsed());
    machine.online().await;
    println!("machine online {:?}", at.elapsed());
    let fresh = Instant::now();
    let device = bind(relay.clone()).await;
    println!("device bound {:?}", fresh.elapsed());
    let serving = machine.clone();
    tokio::spawn(async move {
        serving
            .serve(tower::service_fn(|_r: Request<octoii_tunnel::Body>| async {
                Ok::<_, std::convert::Infallible>(http::Response::new(http_body_util::Full::new(Bytes::from_static(b"x"))))
            }))
            .await;
    });
    let start = Instant::now();
    let peer = device
        .connect(EndpointAddr::new(machine.key()).with_relay_url(relay))
        .await
        .expect("reached");
    println!("connected {:?}, from the device's bind {:?}", start.elapsed(), fresh.elapsed());
    let asked = Instant::now();
    peer.request(Request::get("/").body(Bytes::new()).expect("r"))
        .await
        .expect("answered");
    println!("first request {:?}", asked.elapsed());
    let again = Instant::now();
    peer.request(Request::get("/").body(Bytes::new()).expect("r"))
        .await
        .expect("answered");
    println!("next request {:?}", again.elapsed());
    let closing = Instant::now();
    device.close().await;
    machine.close().await;
    println!("closed {:?}", closing.elapsed());
}
