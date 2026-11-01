# The tunnel client

`@octoii-works/tunnel` is octoiitunnel's client and its wire format: on a device, the connector that keeps the device
reachable through a relay and the secure endpoint that offers pairings and accepts secure channels; on a visitor,
pairing and secure channels; and, at `/protocol`, the wire format the relay speaks too.

This document is the baseline for the package's names, data and behaviour: code and tests follow it, and where they
differ, the code is wrong. The wire format is in [protocol.md](protocol.md) and secure mode in
[security.md](security.md), with the same standing; the relay is [its own package](../../relay/docs/spec.md).

octoiitunnel lets a phone, a browser or any HTTP client reach a service on a machine behind NAT, such as the Octoii server
on a user's PC, without opening a port. The machine connects out to a relay and keeps the connection open; visitors
reach the machine at its own address on the relay, and the relay forwards their requests over that connection.
Visitors the machine has paired with can open a secure channel to it: end to end encrypted, so the relay forwards only
ciphertext.

This repository is the open core: the protocol, the relay and the client. A hosted service adds accounts, billing and
the rest around it through two hooks; none of it is here, and the core does not depend on it.

## Principles

- **Survives restarts and moves.** The connector reconnects on its own, with backoff and jitter, after a network
  change, a sleep, a relay deploy, or the relay closing its connection to restart or move the session (code 1012). A
  visitor whose stream was cut gets a clear error, never a hang. A dropped secure channel is reopened by the visitor
  library.
- **Portable.** The protocol and the client run on any JavaScript runtime with web standards, Hermes and workerd
  included. The client reads no clock, timer or randomness of its own: its caller passes them as a `Platform`. The
  relay core runs on any host that gives it what [its spec](../../relay/docs/spec.md#what-the-core-asks-of-a-host)
  asks; the repository ships adapters for two.
- **Small and checkable.** The core stays small enough to read in an afternoon: that is how users verify that the
  relay only forwards and that secure mode is what it says.

## Glossary

| Term | Meaning |
| --- | --- |
| Relay | The server every party connects to: a router, and one device session per device |
| Device | A machine registered with the relay, with an id and a secret credential |
| Connector | The process on the device that connects out to the relay and serves what visitors ask for |
| Connector connection | The one WebSocket from the connector to the relay that carries every stream |
| Device session | The relay's state for one device: its record, its connector connection, its open streams |
| Visitor | Whoever reaches the device through the relay: a browser, a phone app, a script |
| Device address | Where visitors reach a device: `https://<device id>.<base domain>` |
| Stream | One visitor exchange carried on the connector connection: an HTTP request and its response, or a WebSocket |
| Base domain | The relay's domain, chosen by whoever deploys it |
| Host | What runs the relay: a runtime and its storage, behind an adapter |
| Plain mode | A visitor uses a stream directly; the relay sees what it forwards, as a reverse proxy does |
| Secure mode | A paired visitor and the connector run a Noise channel inside a WebSocket stream; the relay sees only ciphertext |
| Pairing | The one-time exchange, started from a QR code the connector shows, after which each side knows the other's key |
| Pairing store | Where each side keeps its keys and the keys it has paired with; the service using octoiitunnel provides it |
| Secure endpoint | The device's side of secure mode: its key, its paired visitors and offers, and the handshake on each socket it is given |
| Direct listener | A WebSocket listener on the device's own network that serves only the secure path |
| Direct channel | A secure channel a paired visitor opens at the direct listener, without the relay |

## The package

```text
@octoii-works/tunnel/protocol   the wire format: frames, payloads, limits, flow control, formats
        ▲                    ▲
@octoii-works/tunnel     @octoii-works/tunnel-relay
 (the client)             (the core; /worker and /bun adapters)
```

| Entry | What it is |
| --- | --- |
| `@octoii-works/tunnel/protocol` | Frame encoding and decoding, payload codecs that validate, limits, close and reset codes, flow control (`SendCredit`, `IncomingBody`), the device id and credential formats, and UTF-8 and base64url written out so they run where `TextDecoder` and `btoa` do not. No I/O, and nothing of the client |
| `@octoii-works/tunnel` | The client. On the device: `registerDevice()`, `removeDevice()`, `connectDevice()`, which returns a `Connector` that keeps the connector connection and serves streams through a handler, and `createSecureEndpoint()`, the device's side of secure mode, which offers pairings and accepts secure channels however they arrive. On the visitor: `pairWith()`, `openSecureChannel()`, through the relay or directly, and `pairingOf()`. The `Platform` type it runs on |
| `@octoii-works/tunnel/web` | `webPlatform`: the clock, timers and secure randomness of web standards (`Date.now`, `setTimeout`, `crypto.getRandomValues`) |
| `@octoii-works/tunnel/bun` | A file-backed `PairingStore`; `serveDirect()`, a listener on the device's own network that serves only the secure path; a handler that forwards to a local port; and the `octoiitunnel` command |

The protocol is a subpath of the client's package, so the client and its wire format are one release, and the relay
takes the subpath alone. Each root entry uses web standards only, and platform code lives in subpaths. Both packages
are MIT, share one version and are released together, the client first.

### The client's platform

The client's root entry and the protocol read no host clock, timer or random number. Every entry that needs them takes
a `Platform`: a `Clock` (`now()`, and `setTimer(callback, delayMs)`, which returns what cancels it) and `randomBytes`, a
secure source of random bytes. The connector's heartbeats, reconnect backoff and stream idle checks, the handshake's
deadline, pairing offers and their codes, and every static and ephemeral key come from it. `/web` gives the web
standards' own; an engine without `crypto.getRandomValues`, such as Hermes, passes randomness of its own, and a test
passes a clock it moves.

## Registration

- A device registers with `POST /v1/devices` and gets its id, its credential (shown once; the relay keeps only its
  hash) and its address. Its connector presents the credential in the first frame of every connection. See
  [protocol.md](protocol.md).

## Connector

`connectDevice({ relay, device, handler, secure, platform })` returns a `Connector`. Inside:

- **Reconnecting.** A loop that opens connector connections, with exponential backoff and full jitter between
  attempts, and stops on the close codes that say to stop.
- **One connection.** Sends `hello`, waits for `welcome`, sends `ping` every interval and gives up on a connection that
  answers nothing for three, and hands each frame to the stream it belongs to.
- **HTTP streams.** Turn `open` into a `Request` for the handler, and the `Response` back into `head`, `data` and `end`.
- **WebSocket streams.** Hand the handler a WebSocket pair to accept or refuse, and carry messages both ways.
- **Secure channels.** A WebSocket stream to `/.octoiitunnel/secure` never reaches the handler: the connector hands it
  to its `secure` endpoint, which runs the handshake and gives the service a `SecureChannel`. Without one, the path is
  refused.

## Secure endpoint

`createSecureEndpoint({ address, store, handler, platform })` is the device's side of secure mode, apart from any
connection: it keeps the static key and the paired visitors in `store`, offers pairings for `address`, runs the
handshake on each socket it is given, answers the fetch-style requests of its channels with `handler`, and tells the
service of each channel it accepts. `offerPairing(at)` offers a pairing at another address the endpoint answers at,
such as its direct listener's on the device's own network: the visitor pairs there, without the relay, and opens its
channels there unless given another address. The connector gives it the secure streams that come through the relay; a direct
listener gives it the sockets that come over the device's own network. One endpoint serves both, so a visitor paired
through one path is known on the other, and forgetting it closes its channels on both.

## Direct channels

A paired visitor on the device's own network need not go through the relay. The device runs `serveDirect({ endpoint,
hostname, port })`: a WebSocket listener that serves `/.octoiitunnel/secure` alone, handing each socket to the endpoint,
and refuses every other path. The visitor opens a channel with `openSecureChannel(pairing, { via })`, `via` an address
the device's service gave it over an earlier channel; the handshake pins the connector's key, so the direct path is
trusted no more than the relay is. The service tries a direct address first and falls back to the relay where it does
not answer. The relay never learns of the listener or its traffic.

## Secure mode in brief

The connector has a static key pair. It offers a pairing as a URL whose fragment holds a one-time code and the
connector's public key; a browser never sends a fragment, so the relay never sees either. The visitor scans it, opens
a WebSocket stream to `/.octoiitunnel/secure`, and runs a Noise XX handshake with the connector that proves the code,
pins the connector's key, and teaches the connector the visitor's key. Later channels run the same handshake, and the
connector accepts only keys it has paired with. Inside the channel, messages and fetch-style requests flow encrypted.
The full design, with what a relay operator can and cannot do, is in [security.md](security.md).

## Non-goals

Accounts, sign-in, named or custom subdomains, billing, quotas beyond what `authorize` decides, a dashboard, push
notifications, connections from visitor to device across networks without the relay, analytics, and anything else of a
hosted service. A direct channel on the device's own network is the core's.

## Testing

- Unit tests: frame and payload codecs (and refusing malformed input), flow control, UTF-8 and base64url, the
  reconnect policy, the Noise handshake against the specification's test vectors, pairing codes (single use, expiry)
  on a clock the test moves, and channel framing.
- A portability scan of the client's and the protocol's sources, `/web` aside: no platform module, no package but the
  `@noble` libraries, nothing Hermes refuses or lacks, no host clock, timer, randomness or `URL`, and a protocol that
  imports nothing of the client.
- The behavioral suite of [the relay](../../relay/docs/spec.md#testing) runs this client against both hosts.
