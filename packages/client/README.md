# @klein-works/takotunnel

The takotunnel client. On a device: register it with a relay, and run its connector, which keeps one connection to
the relay, reconnects with backoff, and serves every visitor's request through your handler.

```ts
import { connectDevice, registerDevice } from "@klein-works/takotunnel";

const device = await registerDevice({ relay: "https://takotunnel.dev", token }); // keep it: the credential is shown once
const connector = connectDevice({ relay: "https://takotunnel.dev", device, handler: (request) => app.fetch(request) });
await connector.ready; // visitors reach device.address
```

The handler gets a standard `Request` and returns a `Response`; bodies stream both ways under flow control. The
connector stops for good when it is closed, replaced by a newer connector for the same device, or refused.

The root entry runs wherever web standards do. The wire format lives in `@klein-works/takotunnel-protocol`.
