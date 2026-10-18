# @octoii/tunnel

The octoiitunnel client. On a device: register it with a relay, and run its connector, which keeps one connection to
the relay, reconnects with backoff, and serves every visitor's request through your handler.

```ts
import { connectDevice, registerDevice } from "@octoii/tunnel";

const device = await registerDevice({ relay: "https://octoiitunnel.com", token }); // keep it: the credential is shown once
const connector = connectDevice({ relay: "https://octoiitunnel.com", device, handler: (request) => app.fetch(request) });
await connector.ready; // visitors reach device.address
```

The handler gets a standard `Request` and returns a `Response`; bodies stream both ways under flow control. Pass a
`websocket` handler to accept visitors' WebSockets. The connector stops for good when it is closed, replaced by a newer
connector for the same device, or refused.

## Secure mode

Give the connector a `PairingStore` and show a visitor an offer; the visitor pairs once, then opens end-to-end
encrypted channels, on which the relay sees only ciphertext:

```ts
const connector = connectDevice({ relay, device, store, handler });
const offer = await connector.offerPairing(); // show offer.url as a QR code
connector.onSecureChannel((channel) => (channel.onmessage = (message) => channel.send(message)));

// On the visitor:
const pairing = await pairWith(offer.url, { store: visitorStore });
const channel = await openSecureChannel(pairing, { store: visitorStore });
const notes = await channel.fetch("/notes"); // answered by the device's own handler
```

The root entry runs wherever web standards do. The wire format lives in `@octoii/tunnel-protocol`.
