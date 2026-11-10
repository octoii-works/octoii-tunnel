//! How long a machine takes to be at home on the relay `RELAY` names, and what its network report found.
use std::time::Instant;

use octoii_tunnel::{RelayConfig, RelayUrl, SecretKey, Tunnel};

#[tokio::main]
async fn main() {
    let relay: RelayUrl = std::env::var("RELAY").expect("RELAY names a relay").parse().expect("a URL");
    let at = Instant::now();
    let machine = Tunnel::builder(SecretKey::generate())
        .relays(vec![RelayConfig::new(relay.clone(), None)])
        .bind()
        .await
        .expect("bound");
    println!("bound {:?}", at.elapsed());
    machine.online().await;
    println!("online {:?}", at.elapsed());
    println!("addr {:?}", machine.addr());
}
