# The relay

`@octoii-works/tunnel-relay` is octoiitunnel's relay: the router and one device session per device, which a host runs
behind two small interfaces, with an adapter for hosts with the Workers and Durable Object APIs and one for a single
Bun process.

This document is the baseline for the package's names, data and behaviour: code and tests follow it, and where they
differ, the code is wrong. The wire format it speaks is the client's [protocol.md](../../tunnel/docs/protocol.md), and
its terms are [the client's](../../tunnel/docs/spec.md#glossary).

## Principles

- **A dumb relay.** The relay routes and forwards. It knows nothing of secure mode, keeps no body, header value or
  query string, and logs none. Counters (bytes, streams, durations) go to the metering hook.
- **Idle costs nothing.** A device whose connector is connected but which no visitor uses must cost no compute: the
  relay sends nothing on its own, and a host that can suspend a session while keeping its sockets does so.
- **No buffering without bound.** Bodies and messages stream through under per-stream flow control, and every send
  respects the socket's own buffer, so a slow reader cannot fill the relay's or the connector's memory.
- **Survives restarts and moves.** A host that restarts or moves a session closes the connector connection with 1012,
  and the connector reconnects; a visitor whose stream was cut gets a clear error, never a hang.

## The package

| Entry | What it is |
| --- | --- |
| `@octoii-works/tunnel-relay` | `createRelay()`, the router and the device session, and two adapters: `/worker` for hosts with the Workers and Durable Object APIs, and `/bun` for a single Bun process with SQLite |

## The core

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

## What the core asks of a host

A host gives each device session three capabilities, and routes every request for a device to that device's session:

| Capability | What it is |
| --- | --- |
| `DeviceRecords` | Read, create and delete this device's record: its id, name and credential hash |
| `SessionSockets` | Accept a WebSocket, keep a small attachment on each one, list the live ones after the session resumes, and tell when each last sent a heartbeat |
| `Clock` | The time, and timers that only need to fire while the session is awake (the hello deadline and stream idle deadlines), in the shape of the client's |

The router, which registers devices, asks the host that serves its requests to create a device, to forward a
request to a device's session, and for secure randomness, from which it makes each device's id and credential.

These are plain interfaces, not a plugin system.

## Sleeping and waking

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

## Adapters

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

- The relay does not authenticate visitors: the service behind the device decides who may use it. In secure mode the
  connector authenticates visitors by their paired keys; see [security.md](../../tunnel/docs/security.md).
- `createRelay({ origin, registrationToken, authorize, meter, limits })`:
  - `authorize` may refuse registration, a connector connection or a visitor stream, such as for a device over its
    quota. It cannot accept what the core refuses: the registration token, credentials, frames and limits are always
    checked.
  - `meter` receives counters as streams and connections end.
  A hosted service wraps the core with its own hooks; it never forks the core.

## Errors visitors see

| Situation | Response |
| --- | --- |
| Unknown device | 404 |
| No connector connected, or its heartbeats stopped | 502, saying the device is offline |
| The connector connection dropped mid-stream | the stream is cut: the HTTP body ends with an error, or the WebSocket closes with 1011 |
| Too many open streams | 503 with `retry-after` |
| Refused by `authorize` | 403, or 429 for a quota |

## Testing

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
