//! STUN's binding (RFC 5389), as ICE asks a server where a socket is seen from outside: a request of a transaction of
//! its own, and the address the server's success answer says it saw, masked by an exclusive or as the RFC has it.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

/// The magic cookie every STUN message carries after its type and length.
const COOKIE: u32 = 0x2112_A442;
const BINDING_REQUEST: u16 = 0x0001;
const BINDING_SUCCESS: u16 = 0x0101;
const XOR_MAPPED_ADDRESS: u16 = 0x0020;

/// A transaction's id.
pub type Transaction = [u8; 12];

/// A binding request of the transaction `transaction`.
#[must_use]
pub fn request(transaction: &Transaction) -> [u8; 20] {
    let mut out = [0; 20];
    out[0..2].copy_from_slice(&BINDING_REQUEST.to_be_bytes());
    out[4..8].copy_from_slice(&COOKIE.to_be_bytes());
    out[8..20].copy_from_slice(transaction);
    out
}

/// The transaction a binding success answers, where `datagram` is one.
#[must_use]
pub fn answered(datagram: &[u8]) -> Option<Transaction> {
    let head = datagram.get(..20)?;
    let kind = u16::from_be_bytes([head[0], head[1]]);
    let cookie = u32::from_be_bytes([head[4], head[5], head[6], head[7]]);
    (kind == BINDING_SUCCESS && cookie == COOKIE)
        .then(|| head[8..20].try_into().ok())
        .flatten()
}

/// The address the binding success `datagram` says the server saw.
#[must_use]
pub fn mapped(datagram: &[u8]) -> Option<SocketAddr> {
    let transaction = answered(datagram)?;
    let length = usize::from(u16::from_be_bytes([datagram[2], datagram[3]]));
    let mut attributes = datagram.get(20..20 + length)?;
    while attributes.len() >= 4 {
        let kind = u16::from_be_bytes([attributes[0], attributes[1]]);
        let size = usize::from(u16::from_be_bytes([attributes[2], attributes[3]]));
        let value = attributes.get(4..4 + size)?;
        if kind == XOR_MAPPED_ADDRESS {
            return xor_mapped(value, &transaction);
        }
        // Attributes are padded to four bytes.
        attributes = attributes.get(4 + size.div_ceil(4) * 4..).unwrap_or_default();
    }
    None
}

/// The address an XOR-MAPPED-ADDRESS attribute's `value` holds.
fn xor_mapped(value: &[u8], transaction: &Transaction) -> Option<SocketAddr> {
    let family = *value.get(1)?;
    let cookie = COOKIE.to_be_bytes();
    let port = u16::from_be_bytes([*value.get(2)?, *value.get(3)?]) ^ u16::from_be_bytes([cookie[0], cookie[1]]);
    let ip = match family {
        0x01 => {
            let raw: [u8; 4] = value.get(4..8)?.try_into().ok()?;
            IpAddr::V4(Ipv4Addr::from(u32::from_be_bytes(raw) ^ COOKIE))
        }
        0x02 => {
            let raw: [u8; 16] = value.get(4..20)?.try_into().ok()?;
            let mut key = [0; 16];
            key[..4].copy_from_slice(&cookie);
            key[4..].copy_from_slice(transaction);
            IpAddr::V6(Ipv6Addr::from(std::array::from_fn::<u8, 16, _>(|at| raw[at] ^ key[at])))
        }
        _ => return None,
    };
    Some(SocketAddr::new(ip, port))
}

/// How many times a request is sent before its server is given up on, till the next round.
const ATTEMPTS: u32 = 3;
/// How long after a request it is sent again, where no answer came.
const RETRY: std::time::Duration = std::time::Duration::from_millis(400);
/// How often the addresses seen from outside are asked again, as a NAT's mappings change.
const REFRESH: std::time::Duration = std::time::Duration::from_secs(300);

/// Where each local socket is seen from outside, as STUN servers answer: the requests waiting for an answer, each by
/// its transaction with the local address it went from; what was answered, by local address; and when to ask next.
#[derive(Debug)]
pub struct Reflexive {
    servers: Vec<SocketAddr>,
    waiting: std::collections::HashMap<Transaction, SocketAddr>,
    pub seen: std::collections::HashMap<SocketAddr, SocketAddr>,
    next: std::time::Instant,
    attempt: u32,
}

impl Reflexive {
    /// Asking `servers`, the first round at once.
    #[must_use]
    pub fn new(servers: Vec<SocketAddr>) -> Self {
        Self {
            servers,
            waiting: std::collections::HashMap::new(),
            seen: std::collections::HashMap::new(),
            next: std::time::Instant::now(),
            attempt: 0,
        }
    }

    /// When to ask next; none where there is no server to ask.
    #[must_use]
    pub fn due(&self) -> Option<std::time::Instant> {
        (!self.servers.is_empty()).then_some(self.next)
    }

    /// The requests to send now, each from the socket of a local address in `locals` to a server of its family: those
    /// of a new round, or the round's again where no answer came.
    pub fn requests(&mut self, locals: &[SocketAddr]) -> Vec<(SocketAddr, SocketAddr, [u8; 20])> {
        let answered = self.waiting.is_empty() && self.attempt > 0;
        if answered || self.attempt >= ATTEMPTS {
            self.attempt = 0;
            self.waiting.clear();
            self.next = std::time::Instant::now() + REFRESH;
            return Vec::new();
        }
        self.attempt += 1;
        self.next = std::time::Instant::now() + RETRY * self.attempt;
        let mut out = Vec::new();
        for local in locals.iter().filter(|local| !local.ip().is_loopback()) {
            for server in self.servers.iter().filter(|server| server.is_ipv4() == local.is_ipv4()) {
                let mut transaction = [0; 12];
                if getrandom::fill(&mut transaction).is_err() {
                    continue;
                }
                self.waiting.insert(transaction, *local);
                out.push((*local, *server, request(&transaction)));
            }
        }
        out
    }

    /// Takes `datagram` where it answers a request waiting: whether it did.
    pub fn take(&mut self, datagram: &[u8]) -> bool {
        let Some(transaction) = answered(datagram) else { return false };
        let Some(local) = self.waiting.remove(&transaction) else {
            return false;
        };
        if let Some(seen) = mapped(datagram) {
            self.seen.insert(local, seen);
        }
        // One answer for a local address is enough this round.
        self.waiting.retain(|_, waiting| *waiting != local);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A binding success of `transaction` saying `addr`, as a server writes one.
    fn success(transaction: &Transaction, addr: SocketAddr) -> Vec<u8> {
        let cookie = COOKIE.to_be_bytes();
        let mut value = vec![0, if addr.is_ipv4() { 1 } else { 2 }];
        value.extend((addr.port() ^ u16::from_be_bytes([cookie[0], cookie[1]])).to_be_bytes());
        match addr.ip() {
            IpAddr::V4(ip) => value.extend((u32::from(ip) ^ COOKIE).to_be_bytes()),
            IpAddr::V6(ip) => {
                let mut key = cookie.to_vec();
                key.extend(transaction);
                value.extend(ip.octets().iter().zip(key).map(|(byte, key)| byte ^ key));
            }
        }
        // An attribute the client does not read, before the one it does.
        let mut attributes = vec![0x80, 0x22, 0, 3, b'o', b'c', b't', 0];
        attributes.extend(XOR_MAPPED_ADDRESS.to_be_bytes());
        attributes.extend(u16::try_from(value.len()).expect("short").to_be_bytes());
        attributes.extend(value);
        let mut out = BINDING_SUCCESS.to_be_bytes().to_vec();
        out.extend(u16::try_from(attributes.len()).expect("short").to_be_bytes());
        out.extend(COOKIE.to_be_bytes());
        out.extend(transaction);
        out.extend(attributes);
        out
    }

    #[test]
    fn a_binding_success_tells_the_address_the_server_saw() {
        let transaction = [7; 12];
        let request = request(&transaction);
        assert_eq!(&request[..2], &[0, 1]);
        assert_eq!(answered(&request), None, "a request answers nothing");
        for seen in ["203.0.113.9:40001", "[2001:db8::42]:443"] {
            let seen: SocketAddr = seen.parse().expect("an address");
            let answer = success(&transaction, seen);
            assert_eq!(answered(&answer), Some(transaction));
            assert_eq!(mapped(&answer), Some(seen));
        }
        assert_eq!(mapped(&[0; 10]), None);
    }

    #[test]
    fn a_round_asks_each_outward_socket_and_keeps_what_was_seen() {
        let server: SocketAddr = "198.51.100.1:3478".parse().expect("an address");
        let mut reflexive = Reflexive::new(vec![server]);
        let locals: Vec<SocketAddr> = vec![
            "127.0.0.1:5000".parse().expect("loopback"),
            "192.168.1.2:5001".parse().expect("a LAN address"),
        ];
        let asked = reflexive.requests(&locals);
        assert_eq!(asked.len(), 1, "loopback is seen from nowhere");
        let (local, to, request) = asked[0];
        assert_eq!((local, to), (locals[1], server));
        let transaction: Transaction = request[8..20].try_into().expect("an id");
        let seen: SocketAddr = "203.0.113.9:40001".parse().expect("an address");
        assert!(reflexive.take(&success(&transaction, seen)));
        assert!(!reflexive.take(&success(&transaction, seen)), "answered once");
        assert_eq!(reflexive.seen.get(&locals[1]), Some(&seen));
        assert!(reflexive.requests(&locals).is_empty(), "the round is done till its refresh");
    }
}
