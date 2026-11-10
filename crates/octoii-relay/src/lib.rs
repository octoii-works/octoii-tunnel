//! Octoii's relay: a machine's home, which carries datagrams between the machine and the devices that reach it, each
//! known by the key it proved it holds, blind to what they carry — the relay protocol of the tunnel's endpoints, as a
//! home on Cloudflare keeps it, a Durable Object per machine.

pub mod protocol;
#[cfg(target_arch = "wasm32")]
pub mod worker;
