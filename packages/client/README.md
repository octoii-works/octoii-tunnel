# @klein-works/takotunnel

A portable tunnel client. The root exports `registerDevice`, `removeDevice` and `connectAgent`; `/protocol` exports
the shared frame codecs, validators, limits and flow-control helpers.

```ts
import { connectAgent, registerDevice } from "@klein-works/takotunnel";

const device = await registerDevice({ relay, token });
const agent = connectAgent({ relay, device, handler: (request) => app.fetch(request) });
await agent.ready;
// Save device securely; later connections reuse it.
// agent.close();
```

The runtime must provide `fetch`, `WebSocket`, web streams and `crypto.getRandomValues`. There are no server-runtime
imports or cloud SDKs. Body streams and cancellation propagate between the handler and visitor.

This release implements plain HTTP tunneling. Visitor WebSockets, pairing, encrypted channels and a CLI are not
implemented. The relay can read plain HTTP traffic. The secure-channel path is reserved and returns 501.

MIT. This package is private pending publication.
