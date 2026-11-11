//! Where this machine's sockets are seen from outside, as the STUN server the tunnel asks by default says.
use std::time::{Duration, Instant};

use octoii_tunnel::{SecretKey, Tunnel};

#[tokio::main]
async fn main() {
    let at = Instant::now();
    let place = Tunnel::builder(SecretKey::generate()).bind().await.expect("bound");
    while place.seen_from_outside().is_empty() && at.elapsed() < Duration::from_secs(5) {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    println!("seen from outside as {:?} after {:?}", place.seen_from_outside(), at.elapsed());
}
