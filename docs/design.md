# takotunnel design

takotunnel lets a phone, a browser or any HTTP client reach a service on a machine behind NAT, such as the Tako server
on a user's PC, without opening a port. The machine connects out to a relay and keeps the connection open; visitors
reach the machine at its own address on the relay, and the relay forwards their requests over that connection.
Visitors the machine has paired with can open a secure channel to it: end to end encrypted, so the relay forwards only
ciphertext.

This repository is the open core: the protocol, the relay and the client. A hosted service adds accounts, billing and
the rest around it through two hooks; none of it is here, and the core does not depend on it.

## Terms

| Term | Meaning |
| --- | --- |
| Relay | The server every party connects to: a Worker that routes, and one Durable Object per device that holds its connection |
| Device | A machine registered with the relay, with an id and a secret credential |
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

- **Standard platform APIs only.** The relay uses `fetch` handlers, Durable Object SQLite storage, alarms and
  hibernating WebSockets, and nothing tied to one vendor, so it runs wherever those APIs do. Self-hosting docs do not
  prescribe a platform.
- **A dumb relay.** The relay routes and forwards. It knows nothing of secure mode, keeps no body, header value or
  query string, and logs none. Counters (bytes, streams, durations) go to the metering hook.
- **No buffering without bound.** Bodies and messages stream through under per-stream flow control, so a slow reader
  cannot fill the relay's or the agent's memory.
- **Survives restarts and moves.** The agent reconnects on its own, with backoff and jitter, after a network change, a
  sleep, a relay deploy, or the relay closing its connection to restart or move the device's object (code 1012). A
  visitor whose stream was cut gets a clear error, never a hang. A secure channel that drops is opened again by the
  visitor; the library does it on its own.
- **Small and checkable.** The core stays small enough to read in an afternoon: that is how users verify that the
  relay only forwards and that secure mode is what it says.

## Architecture

```text
visitor ──HTTPS / WSS──► Worker ──► Device object ◄──agent connection (WSS)── agent ──► handler (the service)
                        (routes)    (one per device)                           │
                                                                               └──► secure channels (Noise)
```

- **Worker.** Routes by host and path:
  - `<device id>.<base domain>`, any path: a visitor stream, handed to the device's Durable Object.
  - `<base domain>/v1/devices`: registration and removal of devices.
  - `<base domain>/v1/agent/<device id>`: the agent connection, a WebSocket upgrade.
  - Anything else: 404.
- **Device object.** One per device, keyed by its id. It accepts the agent connection as a hibernating WebSocket, so
  an idle device costs nothing while no stream is open, and keeps only what routing needs: whether an agent is
  connected, the open streams and their flow-control credit. A newer agent connection replaces the older one.
- **Agent.** Connects out, authenticates, and serves each stream. A WebSocket stream to the reserved path
  `/.takotunnel/secure` is a secure channel, which the client library handles itself; every other stream goes to the
  service's handler (`Request` in, `Response` out, or a WebSocket), so a service plugs its own `fetch` handler in or
  forwards to a local port.
- **Visitor.** In plain mode, any HTTP client. In secure mode, the client library: it pairs from a QR code, then opens
  secure channels to the device's address.

## Registration and hooks

- A device registers with `POST /v1/devices` and gets its id, its credential (shown once; the relay keeps only its
  hash) and its address. It presents the credential in the first frame of every agent connection. See
  [protocol.md](protocol.md).
- The relay does not authenticate visitors: the service behind the device decides who may use it. In secure mode the
  agent authenticates visitors by their paired keys; see [security.md](security.md).
- The relay is built with `createRelay({ authorize, meter })`:
  - `authorize` decides registration, agent connections and visitor streams (a hosted service refuses, say, a device
    over its quota). By default registration needs `REGISTRATION_TOKEN` from the environment, agent connections a valid
    credential, and visitor streams nothing.
  - `meter` receives counters as streams and connections end. By default it does nothing.
  A hosted service wraps the core with its own hooks; it never forks the core.

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
| `@klein-works/takotunnel` | The client. Root entry (web standards only): `registerDevice()`, `removeDevice()`, `connectAgent()` (the agent connection, reconnect, streams through a handler, `offerPairing()`, `onSecureChannel()`), and for visitors `pairWith()` and `openSecureChannel()`; a `PairingStore` interface with an in-memory implementation. `/bun`: a handler that forwards to a local port, a file-backed `PairingStore`, and the `takotunnel` command (`register`, `http <port>`, `pair`) |
| `@klein-works/takotunnel-relay` | The relay: `createRelay({ authorize, meter })`, the Worker and the Durable Object class, and a default entry to deploy as it is |

## Testing

- Unit tests: frame encoding and decoding (and refusing malformed frames), flow control, the reconnect policy, the
  Noise handshake against the specification's test vectors, pairing codes (single use, expiry), and channel framing.
- End-to-end tests against the relay running locally:
  - register a device, connect an agent, and from a visitor do an HTTP round trip;
  - stream a body larger than the flow-control window both ways;
  - open a WebSocket and echo messages;
  - cut the agent connection: the visitor's stream ends, the agent reconnects;
  - ask for an offline device and get 502; be refused with a wrong credential;
  - pair a visitor, open a secure channel, exchange messages and a fetch; reopen it after the agent reconnects; refuse
    an unpaired key, a reused pairing code and an expired one; check that nothing the relay forwarded contains the
    plaintext.

## Out of scope for the core

Accounts, sign-in, named or custom subdomains, billing, quotas beyond what `authorize` decides, a dashboard, push
notifications, analytics, and anything else of a hosted service.
