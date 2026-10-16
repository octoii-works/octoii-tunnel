# takotunnel design

takotunnel lets a phone, a browser or any HTTP client reach a service that runs on a machine behind NAT, such as the
Tako server on a user's PC, without opening a port. The machine connects out to a relay and keeps the connection
open; visitors reach the machine at its own address on the relay, and the relay forwards their requests over that
connection.

The relay is a dumb pipe. It forwards bytes, holds no state about what flows through it, and never reads, logs or
keeps bodies. A service that needs privacy from the relay encrypts end to end above the tunnel, as Tako does: the
relay then forwards only ciphertext.

This repository is the open core: the tunnel protocol, the relay, and the client that runs on the machine. A hosted
service adds accounts, billing and the rest around it; none of that is here, and the core does not depend on it.

## Terms

| Term | Meaning |
| --- | --- |
| Relay | The server every party connects to: a Worker that routes, and one Durable Object per device that holds its connection |
| Device | A machine registered with the relay, with an id and a secret credential |
| Agent | The process on the device that connects out to the relay and serves what visitors ask for |
| Agent connection | The one WebSocket from the agent to the relay that carries every stream |
| Visitor | Whoever reaches the device through the relay: a browser, a phone, a script |
| Device address | Where visitors reach a device: `https://<device id>.<base domain>` |
| Stream | One visitor exchange carried on the agent connection: an HTTP request and its response, or a WebSocket |
| Base domain | The relay's domain, configured by whoever deploys it |

## Requirements

- **Standard platform APIs only.** The relay uses the standard Workers and Durable Object APIs: `fetch` handlers,
  Durable Object storage (SQLite), alarms and hibernating WebSockets. It uses no feature tied to one vendor, so it runs
  wherever those APIs do. The docs do not tell self-hosters which platform to use.
- **No buffering without bound.** A body streams through; flow control keeps a slow reader from filling the relay's
  memory.
- **Nothing kept of the traffic.** No body, header value or query string is logged or stored. Counters (bytes, streams,
  durations) may be reported through the metering hook.
- **Survives restarts and moves.** The agent reconnects on its own, with backoff and jitter, after a network change, a
  sleep, a relay deploy, or the relay closing its WebSocket with code 1012 because it moved the device's object to
  another node. A visitor whose stream was cut gets a clear error, never a hang.
- **Small and checkable.** The core stays small enough to read in an afternoon: that is how users verify that the
  relay only forwards.

## Architecture

```text
visitor ──HTTPS / WSS──► Worker ──► Device object ◄──agent connection (WSS)── agent ──► local service
                        (routes)    (one per device)                           (on the device)
```

- **Worker.** Routes by host and path:
  - `<device id>.<base domain>`, any path: a visitor request for that device, handed to its Durable Object.
  - `<base domain>/v1/devices`: device registration.
  - `<base domain>/v1/agent`: the agent connection, a WebSocket upgrade authenticated with the device credential.
  - Anything else: 404.
- **Device object.** One per device, keyed by device id. It accepts the agent connection as a hibernating WebSocket,
  so an idle device costs nothing while no stream is open. It keeps only what routing needs: whether an agent is
  connected, the open streams, and their flow-control windows. A newer agent connection for the same device replaces
  the older one.
- **Agent.** Connects out, authenticates, and serves each stream by handing it to a local handler (`Request` in,
  `Response` out, or a WebSocket pair), so a service can plug its own `fetch` handler in directly or forward to a local
  port.

## Registration and authentication

- `POST /v1/devices` registers a device and returns `{ deviceId, credential, address }`. The credential is a random
  secret shown once; the relay keeps only its hash.
- The agent connection presents the credential (as a bearer token on the upgrade). A wrong or revoked credential is
  refused before the upgrade.
- A visitor is not authenticated by the relay: the service behind the device decides who may use it. Tako, for
  instance, pairs a phone and checks its token on every request.
- **Hooks.** The relay is built with `createRelay({ authorize, meter })`:
  - `authorize` decides registration and agent connections (and may refuse visitor requests, such as for a device
    over its quota). The default allows registration only with a deployment secret from the environment, and agent
    connections with a valid credential.
  - `meter` receives counters as streams end (bytes each way, duration, kind). The default does nothing.
  A hosted service wraps the core with its own hooks; it never forks the core.

## Tunnel protocol

The agent connection carries binary WebSocket messages, each one frame. Write the exact format down in
`docs/protocol.md` as you settle it; the shape to start from:

- **Frame header:** a version, a frame type, a stream id, and a payload length. Stream ids are chosen by the relay,
  which opens every stream.
- **Frame types:**
  - `hello` and `welcome`: the agent's version and the relay's limits, once per connection.
  - `open`: a new stream, with its kind (`http` or `websocket`), method, path and query, and headers.
  - `head`: the response status and headers of an HTTP stream, or the agent's acceptance of a WebSocket.
  - `data`: body bytes of an HTTP stream, either way.
  - `message`: one WebSocket message, text or binary, either way.
  - `end`: one side finished sending.
  - `reset`: the stream failed or was cancelled, with a reason code.
  - `window`: flow-control credit, per stream.
  - `ping` and `pong`: liveness, on a timer from both sides.
- **Flow control:** each side may send `data` and `message` frames only within the credit the other side granted, so
  neither the relay nor the agent buffers without bound.
- **Limits:** the most open streams per device, the largest frame, idle timeouts for streams and for the agent
  connection. The relay announces them in `welcome`.
- **Versioning:** a version in every header; the relay refuses an agent whose version it does not speak, with a reason
  the agent shows.
- **Hop-by-hop headers** (`connection`, `upgrade`, `transfer-encoding`, `keep-alive` and the like) are not forwarded.
  The relay adds `x-forwarded-for` and `x-forwarded-proto`.

## Errors visitors see

| Situation | Response |
| --- | --- |
| Unknown device | 404 |
| No agent connected | 502, saying the device is offline |
| The agent connection dropped mid-stream | the stream is cut: a reset HTTP body, or the WebSocket closed with 1011 |
| Too many open streams | 503 with `retry-after` |
| Refused by `authorize` | 403, or 429 for a quota |

## Packages

| Package | What it is |
| --- | --- |
| `@klein-works/takotunnel` | The client: `registerDevice()` and `connectAgent({ relay, deviceId, credential, handler })`, which keeps the agent connection, reconnects, and serves streams through the handler. Its root entry uses web standards only (`fetch`, `WebSocket`, streams), so it runs in Bun, Node, browsers and workers. A `/bun` subpath adds a handler that forwards to a local port, and a small `takotunnel` command that exposes a local port |
| `@klein-works/takotunnel-relay` | The relay: `createRelay({ authorize, meter })`, the Worker and the Durable Object class, and a default entry for deploying it as it is |

## Testing

- Unit tests for the frame encoding and decoding, flow control, and the reconnect policy.
- End-to-end tests against the relay running locally: register a device, connect an agent, and from a visitor do an
  HTTP round trip, stream a body larger than the flow-control window both ways, open a WebSocket and echo messages,
  cut the agent connection and see the visitor's stream end and the agent reconnect, ask for an offline device and get
  502, and be refused with a wrong credential.
- A conformance-style test that the relay keeps nothing of the bodies it forwards.

## Out of scope for the core

Accounts, sign-in, named or custom subdomains, billing, quotas beyond what `authorize` decides, a dashboard, push
notifications, analytics, and anything else of a hosted service. The core keeps the hooks such a service needs and
nothing more.
