# takotunnel design

The implemented scope is plain HTTP tunneling. WebSocket forwarding and secure mode below are implementation
targets; see the implementation section for available APIs.

takotunnel lets a phone, a browser or any HTTP client reach a service on a machine behind NAT, without opening a port.
The machine connects out to a relay and keeps the connection open; visitors
reach the machine at its own address on the relay, and the relay forwards their requests over that connection.
Visitors the machine has paired with can open a secure channel to it: end to end encrypted, so the relay forwards only
ciphertext.

This repository is the open core: the protocol, the relay and the client. A hosted service adds accounts, billing and
the rest around it through two hooks; none of it is here, and the core does not depend on it.

## Terms

| Term | Meaning |
| --- | --- |
| Relay | The server every party connects to: a portable forwarding core hosted by a runtime adapter |
| Device | A machine registered with the relay, with an id and a secret credential |
| Device session | The relay core's state for one device: its current agent connection, open streams and flow-control credit |
| Runtime adapter | The host implementation of network serving, device storage, scheduling and routing to device sessions |
| Agent | The process on the device that connects out to the relay and serves what visitors ask for |
| Agent connection | The one WebSocket from the agent to the relay that carries every stream |
| Visitor | Whoever reaches the device through the relay: a browser, a phone app, a script |
| Device address | Where visitors reach a device: `https://<device id>.<base domain>` |
| Stream | One visitor exchange carried on the agent connection: an HTTP request and its response, or a WebSocket |
| Base domain | The relay's domain, chosen by whoever deploys it |
| Plain mode | A visitor uses a stream directly; the relay sees what it forwards, as a reverse proxy does |
| Secure mode | A paired visitor and the agent run a Noise channel inside a WebSocket stream; the relay sees only ciphertext |
| Pairing | The one-time exchange, started from a QR code the agent shows, after which the agent knows the visitor's key and the visitor knows the agent's |
| Pairing store | Where each side keeps its keys and the keys it has paired with; the service using takotunnel provides it |

## Requirements

- **Portable cores.** The client and relay cores use TypeScript and web-standard values and APIs. Server APIs,
  databases, timers that survive suspension, and device routing belong to runtime adapters. A relay host must
  support long-lived connections and streaming; a client host needs only the client-side capabilities. Self-hosting
  docs describe these requirements without prescribing a hosting provider.
- **A dumb relay.** The relay routes and forwards. It knows nothing of secure mode, keeps no body, header value or
  query string, and logs none. Counters (bytes, streams, durations) go to the metering hook.
- **No buffering without bound.** Bodies and messages stream through under per-stream flow control, so a slow reader
  cannot fill the relay's or the agent's memory.
- **Survives restarts and moves.** The agent reconnects on its own, with backoff and jitter, after a network change, a
  sleep, a relay deploy, or the relay closing its connection to restart or move the device session (code 1012). A
  visitor whose stream was cut gets a clear error, never a hang. A secure channel that drops is opened again by the
  visitor; the library does it on its own.
- **Small and checkable.** The core stays small enough to read in an afternoon: that is how users verify that the
  relay only forwards and that secure mode is what it says.

## Architecture

```text
visitor ──HTTPS / WSS──► host adapter ──► device session ◄──WSS── agent ──► handler
                         (routes)         (relay core)            │
                                                                 └──► secure channels (Noise)
```

- **Relay routing.** The core classifies the host and path; the adapter delivers the request to the owning session:
  - `<device id>.<base domain>`, any path: a visitor stream.
  - `<base domain>/v1/devices`: registration and removal of devices.
  - `<base domain>/v1/agent/<device id>`: the agent connection, a WebSocket upgrade.
  - Anything else: 404.
- **Device session.** One authoritative session per device, keyed by its id. It validates agent credentials, manages
  the agent connection, opens and closes streams, and enforces flow control and resource limits. A newer connection
  replaces the older one only after authentication and authorization succeed. Cleanup from an older connection must
  not remove the replacement.
- **Agent.** Connects out, authenticates, and serves each stream. A WebSocket stream to the reserved path
  `/.takotunnel/secure` is a secure channel, which the client library handles itself; every other stream goes to the
  service's handler (`Request` in, `Response` out, or a WebSocket), so a service plugs its own `fetch` handler in or
  forwards to a local port.
- **Visitor.** In plain mode, any HTTP client. In secure mode, the client library: it pairs from a QR code, then opens
  secure channels to the device's address.

## Runtime boundary

The relay core does not bind a port, read environment variables, open a database or import host-specific modules.
The host supplies configuration and a small set of explicit capabilities:

| Capability | Adapter responsibility | Core responsibility |
| --- | --- | --- |
| Network serving | Accept HTTP and WebSocket connections; translate server callbacks, stream cancellation and send capacity | Validate requests and frames, select routes, multiplex streams and bound queues |
| Device records | Atomically create, read and delete durable device records | Generate device ids and credentials; store only credential hashes and validate credentials |
| Scheduling | Deliver scheduled callbacks using the host's timers or alarms | Decide heartbeat, handshake and stream deadlines and the action when they expire |
| Device ownership | Route registration, removal, agent connections and visitor requests to the authoritative session for a device | Maintain the device's connection and stream state |
| Lifecycle | Notify the core of connection loss and shutdown; restore supported suspended sessions | Release streams and resources, reject interrupted work and apply the protocol's close behavior |

These are host interfaces, not a plugin registry or a general database abstraction. A new adapter implements the
capabilities and passes the same behavioral tests. Business policy uses the hooks below.

The concrete boundaries are `RelayDirectory` for device routing, `DeviceStore` for device records, `Scheduler` for
deadlines, and `RequestContext` with `RelaySocket` for network integration. `DeviceSession` receives these capabilities
from the host. Bun is one adapter implementation; replacing it does not change the client, wire protocol or session
logic. The core never constructs a host adapter or selects a storage implementation.

### Device state and suspension

A persistent host keeps device registration records across relay restarts; the development memory store does not.
Traffic bodies, messages, header values and query strings are
never persisted. An active session keeps only bounded working buffers and routing and flow-control state.

A host that suspends a session while retaining its sockets must restore enough control state to continue the same
connection safely, including its authenticated identity, allocated stream ids and deadlines. It must not persist
traffic to achieve this. If the host cannot preserve a live session, it ends the affected streams and closes the
agent connection with 1012 when possible; the agent reconnects. A crash may drop the connection without a close
frame. Neither reconnection nor session recovery replays interrupted visitor requests.

### Included host

The `/bun` adapter hosts one process and owns an in-memory map of device sessions. It supplies network serving and
process timers; the application supplies `DeviceStore` explicitly. The built-in memory store is volatile and intended
for development and tests. Persistent storage, migrations and storage cleanup belong to the embedding application.
The repository contains no database implementation or provider-specific deployment adapter.

`createBunRelay` composes with an application's server; `serveRelay` supplies a standalone server. The application
owns TLS and storage lifetime. Runtime code depends on the core, and the core never depends on an adapter.

Sharing storage between relay processes does not share live connections. A multi-process host must coordinate device
ownership and route traffic to its owner. That mode and additional runtime adapters are outside the initial
implementation. Other hosts may implement the same network, storage, scheduling and routing interfaces.

## Registration and hooks

- A device registers with `POST /v1/devices` and gets its id, its credential (shown once; the relay keeps only its
  hash) and its address. It presents the credential in the first frame of every agent connection. See
  [protocol.md](protocol.md).
- The relay does not authenticate visitors: the service behind the device decides who may use it. In secure mode the
  agent authenticates visitors by their paired keys; see [security.md](security.md).
- `createRelay` composes the core with host capabilities and the `authorize` and `meter` hooks:
  - `authorize` supplies the registration policy and may refuse agent connections or visitor streams (a hosted
    service refuses, say, a device over its quota). The default registration policy requires `REGISTRATION_TOKEN`,
    read by the host and passed as configuration; visitor streams need no additional authorization by default.
    The core always validates device credentials for agent connections and device removal, regardless of the hook.
  - `meter` receives counters as streams and connections end. By default it does nothing.
  A hosted service wraps the core with its own hooks; it never forks the core. Hooks cannot bypass credential or
  protocol validation or the core's resource limits.

## Secure mode in brief

The agent has a static key pair. It offers a pairing as a URL whose fragment holds a one-time code and the agent's
public key; a browser never sends a fragment, so the relay never sees either. The visitor scans it, opens a WebSocket
stream to `/.takotunnel/secure`, and runs a Noise XX handshake with the agent that proves the code, pins the agent's
key, and teaches the agent the visitor's key. Later channels run the same handshake, and the agent accepts only keys
it has paired with. Inside the channel, messages and fetch-style requests flow encrypted. The full design, with what a
relay operator can and cannot do, is in [security.md](security.md).

## Errors visitors see

| Situation | Response |
| --- | --- |
| Unknown device | 404 |
| No agent connected | 502, saying the device is offline |
| The agent connection dropped mid-stream | the stream is cut: the HTTP body ends with an error, or the WebSocket closes with 1011 |
| Too many open streams | 503 with `retry-after` |
| Refused by `authorize` | 403, or 429 for a quota |

## Packages

| Package | What it is |
| --- | --- |
| `@klein-works/takotunnel` | The client. Root entry (web standards only): `registerDevice()`, `removeDevice()`, `connectAgent()` (the agent connection, reconnect, streams through a handler, `offerPairing()`, `onSecureChannel()`), and for visitors `pairWith()` and `openSecureChannel()`; a `PairingStore` interface with an in-memory implementation. `/protocol`: shared frame codecs, validation and flow-control rules. `/bun`: a handler that forwards to a local port, a file-backed `PairingStore`, and the `takotunnel` command (`register`, `http <port>`, `pair`) |
| `@klein-works/takotunnel-relay` | The relay. Platform-neutral root: `createRelay`, device sessions and host and hook interfaces. `/bun`: the single-process network adapter and server with an injected device store |

The shared protocol module has no dependency on client connection or encryption code. Both the client and relay
depend on it. The repository, both packages and all adapters are MIT. The client never imports relay code. These are
two packages; adapters and shared protocol code use subpath entries.

## Implementation and testing

The executable scope is registration and removal, authenticated agent connections, reconnect handling and streamed
HTTP requests and responses. The client exports `registerDevice`, `removeDevice` and `connectAgent`; it also exports
shared protocol helpers at `/protocol`. Visitor WebSockets, pairing, secure channels and the client CLI described
above are implementation targets, not available APIs. Visitor upgrades and the reserved secure path return 501.

Tests cover malformed frames, bounded receive buffers, blocked send cancellation, authenticated connection
replacement, device removal, HTTP round trips and bodies exceeding a flow-control window. Lifecycle tests exercise
host hooks, deadlines and interrupted operations without a platform-specific runtime. Network tests use the included
server adapter. Packed artifacts are also installed outside the workspace to verify runtime imports and types.

## Out of scope for the core

Accounts, sign-in, named or custom subdomains, billing, quotas beyond what `authorize` decides, a dashboard, push
notifications, analytics, and anything else of a hosted service.
