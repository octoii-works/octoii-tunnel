# @klein-works/takotunnel-relay

A portable HTTP tunnel relay. The root exports `createRelay`, `DeviceSession`, `createMemoryDeviceStore` and the
host and policy interfaces. It has no database driver, cloud SDK or server-runtime imports.

The `/bun` entry supplies `createBunRelay` for an existing server and `serveRelay` to start a server:

```ts
import { createMemoryDeviceStore } from "@klein-works/takotunnel-relay";
import { serveRelay } from "@klein-works/takotunnel-relay/bun";

const relay = serveRelay({
  origin: "http://localhost:8787",
  registrationToken: token,
  store: createMemoryDeviceStore(),
  port: 8787,
});
// await relay.close();
```

Storage is always injected. The memory implementation is volatile; production hosts implement `DeviceStore` with
atomic create, read and remove operations in their own storage. Store only device ids, credential hashes and names.
The adapter does not close a caller-owned store. One process owns all live sessions in the included adapter.

Use `authorize` to reject registration, agent connections or visitor requests, and `meter` for counters. Credential
and protocol checks remain core responsibilities. Visitor WebSockets and encrypted channels are not implemented.

For another runtime, implement `RelayDirectory`, `SessionHost` and `RequestContext`, and deliver socket callbacks
to `AgentConnection`. Root imports need only web-standard APIs. Only `/bun` requires Bun and its types.

MIT. This package is private pending publication.
