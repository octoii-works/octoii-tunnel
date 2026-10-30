# octoiitunnel design

octoiitunnel lets a phone, a browser or any HTTP client reach a service on a machine behind NAT, such as the Octoii server
on a user's PC, without opening a port. The machine connects out to a relay and keeps the connection open; visitors
reach the machine at its own address on the relay, and the relay forwards their requests over that connection.
Visitors the machine has paired with can open a secure channel to it: end to end encrypted, so the relay forwards only
ciphertext.

This repository is the open core: the protocol, the relay and the client. A hosted service adds accounts, billing and
the rest around it through two hooks; none of it is here, and the core does not depend on it.

## Terms

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

## Requirements

- **A dumb relay.** The relay routes and forwards. It knows nothing of secure mode, keeps no body, header value or
  query string, and logs none. Counters (bytes, streams, durations) go to the metering hook.
- **Idle costs nothing.** A device whose connector is connected but which no visitor uses must cost no compute: the
  relay sends nothing on its own, and a host that can suspend a session while keeping its sockets does so.
- **No buffering without bound.** Bodies and messages stream through under per-stream flow control, and every send
  respects the socket's own buffer, so a slow reader cannot fill the relay's or the connector's memory.
- **Survives restarts and moves.** The connector reconnects on its own, with backoff and jitter, after a network
  change, a sleep, a relay deploy, or the relay closing its connection to restart or move the session (code 1012). A
  visitor whose stream was cut gets a clear error, never a hang. A dropped secure channel is reopened by the visitor
  library.
- **Portable.** The protocol and the client run on any JavaScript runtime with web standards, Hermes and workerd
  included. The client reads no clock, timer or randomness of its own: its caller passes them as a `Platform`. The
  relay core runs on any host that gives it the capabilities below; the repository ships adapters for two.
- **Small and checkable.** The core stays small enough to read in an afternoon: that is how users verify that the
  relay only forwards and that secure mode is what it says.

## Packages

```text
@octoii-works/tunnel/protocol   the wire format: frames, payloads, limits, flow control, formats
        ▲                    ▲
@octoii-works/tunnel     @octoii-works/tunnel-relay
 (the client)             (the core; /worker and /bun adapters)
```

| Entry | What it is |
| --- | --- |
| `@octoii-works/tunnel/protocol` | Frame encoding and decoding, payload codecs that validate, limits, close and reset codes, flow control (`SendCredit`, `IncomingBody`), the device id and credential formats, and UTF-8 and base64url written out so they run where `TextDecoder` and `btoa` do not. No I/O, and nothing of the client |
| `@octoii-works/tunnel` | The client. On the device: `registerDevice()`, `removeDevice()`, and `connectDevice()`, which returns a `Connector` that keeps the connector connection and serves streams through a handler, offers pairings and accepts secure channels. On the visitor: `pairWith()`, `openSecureChannel()` and `pairingOf()`. The `Platform` type it runs on |
| `@octoii-works/tunnel/web` | `webPlatform`: the clock, timers and secure randomness of web standards (`Date.now`, `setTimeout`, `crypto.getRandomValues`) |
| `@octoii-works/tunnel/bun` | A handler that forwards to a local port, a file-backed `PairingStore`, and the `octoiitunnel` command |
| `@octoii-works/tunnel-relay` | `createRelay()`, the router and the device session, and two adapters: `/worker` for hosts with the Workers and Durable Object APIs, and `/bun` for a single Bun process with SQLite |

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

## Relay

### The core

- **Router.** Classifies a request by host and path, and checks registration:
  - `<device id>.<base domain>`, any path: a visitor stream for that device.
  - `<base domain>/v1/devices`: registration; the router makes the id and credential and asks the host to create the
    device.
  - `<base domain>/v1/devices/<device id>` and `<base domain>/v1/connect/<device id>`: removal and the connector
    connection, for that device.
  - Anything else: 404.
- **Device session.** One per device, the only owner of its state. It authenticates the connector, keeps the connector
  connection, opens streams, forwards frames under flow control, enforces limits, and ends streams. A newer connector
  connection replaces the older one only after it authenticates.

### What the core asks of a host

A host gives each device session three capabilities, and routes every request for a device to that device's session:

| Capability | What it is |
| --- | --- |
| `DeviceRecords` | Read, create and delete this device's record: its id, name and credential hash |
| `SessionSockets` | Accept a WebSocket, keep a small attachment on each one, list the live ones after the session resumes, and tell when each last sent a heartbeat |
| `Clock` | The time, and timers that only need to fire while the session is awake (the hello deadline and stream idle deadlines), in the shape of the client's |

The router, which registers devices, asks the host that serves its requests to create a device, to forward a
request to a device's session, and for secure randomness, from which it makes each device's id and credential.

These are plain interfaces, not a plugin system.

### Sleeping and waking

A host may suspend an idle session and wake it for the next message or request, keeping its sockets open. The session
is built so nothing is lost:

- **Heartbeats wake nothing.** The connector sends a text `ping`; a host that can answer it without waking the session
  does so, and remembers when. The relay never pings. A visitor request reaching a session whose connector has not
  sent a heartbeat for three intervals gets 502, and that connection is closed.
- **What lives on the sockets.** Each WebSocket carries an attachment with what the session needs to continue: on the
  connector connection, that it authenticated, as which connection, and the next stream id; on a visitor WebSocket, its
  stream id and the flow-control credit each way. When the session wakes, it rebuilds itself from the live sockets and
  their attachments.
- **What does not.** An HTTP stream keeps the session awake until it ends, so it is never suspended. Traffic is never
  written anywhere.

A host that cannot keep sockets across a suspension closes the connector connection with 1012, and the connector
reconnects.

### Adapters

- **`/worker`.** For hosts with the Workers and Durable Object APIs. The Worker runs the router and sends each device's
  requests to the Durable Object named by its device id, which holds the device session. The record lives in that
  object's storage. Sockets are hibernating WebSockets with attachments; heartbeats are answered by automatic
  response, without waking the object. A deployment exports the Worker and the object class that `defineRelay(hooks)`
  makes. A visitor that goes away is noticed when the relay next writes to it, or at once where the host signals it
  on the request.
- **`/bun`.** One Bun process: sessions in memory, records in SQLite (`bun:sqlite`), sockets from `Bun.serve`. For
  development, tests, and a single-machine relay.

A host with several processes must send each device's traffic to the process that owns its session; the repository
does not include one.

## Registration and hooks

- A device registers with `POST /v1/devices` and gets its id, its credential (shown once; the relay keeps only its
  hash) and its address. Its connector presents the credential in the first frame of every connection. See
  [protocol.md](protocol.md).
- The relay does not authenticate visitors: the service behind the device decides who may use it. In secure mode the
  connector authenticates visitors by their paired keys; see [security.md](security.md).
- `createRelay({ origin, registrationToken, authorize, meter, limits })`:
  - `authorize` may refuse registration, a connector connection or a visitor stream, such as for a device over its
    quota. It cannot accept what the core refuses: the registration token, credentials, frames and limits are always
    checked.
  - `meter` receives counters as streams and connections end.
  A hosted service wraps the core with its own hooks; it never forks the core.

## Connector

`connectDevice({ relay, device, handler, platform })` returns a `Connector`. Inside:

- **Reconnecting.** A loop that opens connector connections, with exponential backoff and full jitter between
  attempts, and stops on the close codes that say to stop.
- **One connection.** Sends `hello`, waits for `welcome`, sends `ping` every interval and gives up on a connection that
  answers nothing for three, and hands each frame to the stream it belongs to.
- **HTTP streams.** Turn `open` into a `Request` for the handler, and the `Response` back into `head`, `data` and `end`.
- **WebSocket streams.** Hand the handler a WebSocket pair to accept or refuse, and carry messages both ways.
- **Secure channels.** A WebSocket stream to `/.octoiitunnel/secure` never reaches the handler: the connector runs the
  handshake and gives the service a `SecureChannel`.

## Secure mode in brief

The connector has a static key pair. It offers a pairing as a URL whose fragment holds a one-time code and the
connector's public key; a browser never sends a fragment, so the relay never sees either. The visitor scans it, opens
a WebSocket stream to `/.octoiitunnel/secure`, and runs a Noise XX handshake with the connector that proves the code,
pins the connector's key, and teaches the connector the visitor's key. Later channels run the same handshake, and the
connector accepts only keys it has paired with. Inside the channel, messages and fetch-style requests flow encrypted.
The full design, with what a relay operator can and cannot do, is in [security.md](security.md).

## Errors visitors see

| Situation | Response |
| --- | --- |
| Unknown device | 404 |
| No connector connected, or its heartbeats stopped | 502, saying the device is offline |
| The connector connection dropped mid-stream | the stream is cut: the HTTP body ends with an error, or the WebSocket closes with 1011 |
| Too many open streams | 503 with `retry-after` |
| Refused by `authorize` | 403, or 429 for a quota |

## Testing

- Unit tests: frame and payload codecs (and refusing malformed input), flow control, UTF-8 and base64url, the
  reconnect policy, the Noise handshake against the specification's test vectors, pairing codes (single use, expiry)
  on a clock the test moves, and channel framing.
- A portability scan of the client's and the protocol's sources, `/web` aside: no platform module, no package but the
  `@noble` libraries, nothing Hermes refuses or lacks, no host clock, timer, randomness or `URL`, and a protocol that
  imports nothing of the client.
- One behavioral suite, run against both adapters (`/bun` directly, `/worker` on a local workerd):
  - register a device, connect a connector, do an HTTP round trip, and stream a body larger than the flow-control
    window both ways;
  - open a visitor WebSocket and echo messages, including ones larger than a frame;
  - cut the connector connection: the visitor's stream ends, the connector reconnects;
  - stop the connector's heartbeats: a visitor gets 502;
  - suspend and wake an idle session (where the host can), then use the device again;
  - ask for an offline device and get 502; be refused with a wrong credential;
  - pair a visitor, open a secure channel, exchange messages and a fetch, reopen it after the connector reconnects;
    run the connector and the visitor on platforms of their own;
    refuse an unpaired key, a reused pairing code and an expired one; check that nothing the relay forwarded contains
    the plaintext.

## Out of scope for the core

Accounts, sign-in, named or custom subdomains, billing, quotas beyond what `authorize` decides, a dashboard, push
notifications, direct connections between visitor and device, analytics, and anything else of a hosted service.
