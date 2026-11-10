//! The relay's Worker, run where `OCTOII_RELAY` names it — `wrangler dev` here, or a deployed one — as the tunnel's
//! endpoints reach each other through it: `OCTOII_RELAY=http://127.0.0.1:8791 cargo test -p octoii-relay --test worker
//! -- --ignored`.

use std::time::Duration;

use bytes::Bytes;
use http::Request;
use octoii_tunnel::{EndpointAddr, RelayConfig, RelayUrl, SecretKey, Tunnel};

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs a relay's Worker running, named by OCTOII_RELAY"]
async fn a_machine_and_a_device_reach_each_other_through_the_worker() {
    let url: RelayUrl = std::env::var("OCTOII_RELAY")
        .expect("OCTOII_RELAY names a relay")
        .parse()
        .expect("a URL");
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
    tokio::time::timeout(Duration::from_secs(20), machine.online())
        .await
        .expect("at home in time");
    let serving = machine.clone();
    tokio::spawn(async move {
        serving
            .serve(tower::service_fn(|request: Request<octoii_tunnel::Body>| async move {
                let body = http_body_util::BodyExt::collect(request.into_body())
                    .await
                    .map(http_body_util::Collected::to_bytes)
                    .unwrap_or_default();
                Ok::<_, std::convert::Infallible>(http::Response::new(http_body_util::Full::new(body)))
            }))
            .await;
    });
    let addr = EndpointAddr::new(machine.key()).with_relay_url(url);
    let peer = tokio::time::timeout(Duration::from_secs(20), device.connect(addr))
        .await
        .expect("in time")
        .expect("reached");
    let sent = Bytes::from(vec![3; 256 * 1024]);
    let answered = peer
        .request(Request::post("/").body(sent.clone()).expect("a request"))
        .await
        .expect("answered");
    assert_eq!(answered.into_body(), sent);
    device.close().await;
    machine.close().await;
}
