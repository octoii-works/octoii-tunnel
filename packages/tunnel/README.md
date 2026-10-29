# @octoii-works/tunnel

The octoiitunnel client and its wire format. On a device: register it with a relay, and run its connector, which keeps
one connection to the relay, reconnects with backoff, and serves every visitor's request through your handler.

```ts
import { connectDevice, registerDevice } from "@octoii-works/tunnel";

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

## Entries

- `@octoii-works/tunnel`: the client. It runs wherever JavaScript and the web's `fetch`, `Request`, `Response` and
  `WebSocket` do, Hermes included.
- `@octoii-works/tunnel/protocol`: the wire format, shared with the relay: frames and their payloads, the rules of the
  connector connection, limits, flow control, WebSocket message chunking, the relay's HTTP API, and the formats of
  device ids, credentials and addresses. It does no I/O, imports nothing of the client, and writes out UTF-8 and
  base64url, so it needs no `TextDecoder` or `btoa`. The format is specified in
  [docs/protocol.md](../../docs/protocol.md).
