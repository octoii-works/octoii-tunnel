# @octoii-works/tunnel-relay

The octoiitunnel relay: the router, the device session, and hosts that run them. It speaks the wire format of
`@octoii-works/tunnel/protocol`, and is released with `@octoii-works/tunnel` at the same version.

- `@octoii-works/tunnel-relay`: `createRelay()` and `DeviceSession`, with the interfaces a host implements
  (`RelayHost`, `SessionHost`).
- `@octoii-works/tunnel-relay/worker`: hosts with the Workers and Durable Object APIs.
- `@octoii-works/tunnel-relay/bun`: one Bun process, device records in SQLite.
- `@octoii-works/tunnel-relay/testing`: the relay's behavioral suite, which a host runs against itself under `bun test`.

```ts
import { serveRelay } from "@octoii-works/tunnel-relay/bun";

const relay = serveRelay({ origin: "https://relay.example.com", registrationToken, database: "relay.sqlite", port: 8787 });
```

A public relay needs a wildcard domain (`*.relay.example.com`) and the bare domain, with TLS, in front of it.

On a host with the Workers and Durable Object APIs, the entry exports the Worker and the object class, with any hooks:

```ts
import { defineRelay } from "@octoii-works/tunnel-relay/worker";

const relay = defineRelay({ authorize, meter });
export default relay.worker;
export const DeviceObject = relay.DeviceObject;
```

It needs a Durable Object binding `DEVICES` to `DeviceObject` (a SQLite-backed class), the variables `RELAY_ORIGIN`
and `REGISTRATION_TOKEN`, and routes for the bare domain and `*.<domain>`. With the `enable_request_signal`
compatibility flag the relay notices a visitor that went away at once; without it, when it next writes to the visitor.

A deployment checks its own host with the suite this repository's hosts pass:

```ts
import { relaySuite } from "@octoii-works/tunnel-relay/testing";

relaySuite("my host", async () => startMyRelay()); // resolves { origin, port, close() }
```
