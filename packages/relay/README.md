# @klein-works/takotunnel-relay

The takotunnel relay: the router, the device session, and hosts that run them.

- `@klein-works/takotunnel-relay`: `createRelay()` and `DeviceSession`, with the interfaces a host implements
  (`RelayHost`, `SessionHost`).
- `@klein-works/takotunnel-relay/bun`: one Bun process, device records in SQLite.

```ts
import { serveRelay } from "@klein-works/takotunnel-relay/bun";

const relay = serveRelay({ origin: "https://relay.example.com", registrationToken, database: "relay.sqlite", port: 8787 });
```

A public relay needs a wildcard domain (`*.relay.example.com`) and the bare domain, with TLS, in front of it.
