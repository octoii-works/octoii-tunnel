# @octoii-works/tunnel

The octoiitunnel client and its wire format. On a device: register it with a relay, and run its connector, which keeps
one connection to the relay, reconnects with backoff, and serves every visitor's request through your handler.

```ts
import { connectDevice, registerDevice } from "@octoii-works/tunnel";
import { webPlatform } from "@octoii-works/tunnel/web";

const device = await registerDevice({ relay: "https://octoiitunnel.com", token }); // keep it: the credential is shown once
const connector = connectDevice({ relay: "https://octoiitunnel.com", device, handler: (request) => app.fetch(request), platform: webPlatform });
await connector.ready; // visitors reach device.address
```

The handler gets a standard `Request` and returns a `Response`; bodies stream both ways under flow control. Pass a
`websocket` handler to accept visitors' WebSockets. The connector stops for good when it is closed, replaced by a newer
connector for the same device, or refused.

## Secure mode

Give the connector a `PairingStore` and show a visitor an offer; the visitor pairs once, then opens end-to-end
encrypted channels, on which the relay sees only ciphertext:

```ts
const connector = connectDevice({ relay, device, store, handler, platform });
const offer = await connector.offerPairing(); // show offer.url as a QR code
connector.onSecureChannel((channel) => (channel.onmessage = (message) => channel.send(message)));

// On the visitor:
const pairing = await pairWith(offer.url, { store: visitorStore, platform });
const channel = await openSecureChannel(pairing, { store: visitorStore, platform });
const notes = await channel.fetch("/notes"); // answered by the device's own handler
const kept = await pairingOf(visitorStore, pairing.address); // the pairing, read back later
```

## The platform

The client reads no clock, timer or randomness of its own; every entry that needs them takes a `Platform`:

```ts
type Platform = {
	readonly clock: { now(): number; setTimer(callback: () => void, delayMs: number): () => void };
	readonly randomBytes: (length: number) => Uint8Array; // a cryptographically secure source
};
```

`webPlatform` from `/web` is the web standards' own: `Date.now`, `setTimeout` and `crypto.getRandomValues`, as Bun,
Node, browsers and workerd have them. On Hermes, which has no `crypto.getRandomValues`, pass the app's own secure
random bytes as `randomBytes`. A test passes a clock it moves.

## Entries

- `@octoii-works/tunnel`: the client. It runs wherever JavaScript and the web's `fetch`, `Request`, `Response` and
  `WebSocket` do, Hermes included.
- `@octoii-works/tunnel/protocol`: the wire format, shared with the relay: frames and their payloads, the rules of the
  connector connection, limits, flow control, WebSocket message chunking, the relay's HTTP API, and the formats of
  device ids, credentials and addresses. It does no I/O, imports nothing of the client, and writes out UTF-8 and
  base64url, so it needs no `TextDecoder` or `btoa`. The format is specified in
  [docs/protocol.md](docs/protocol.md).
- `@octoii-works/tunnel/web`: `webPlatform`.
