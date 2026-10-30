# Changelog

## [Unreleased]

### Breaking Changes

- The client is published as `@octoii-works/tunnel`, and the wire format, which was `@octoii/tunnel-protocol`, is its
  `/protocol` subpath, released with it; the protocol imports nothing of the client.
- The client reads no clock, timer or randomness of its own: `connectDevice()`, `pairWith()` and `openSecureChannel()`
  take a `platform`, a `Clock` (`now`, `setTimer`) and `randomBytes`. `reconnectDelay()` takes its `random` function,
  and the protocol's `newDeviceId()` and `newCredential()` their `randomBytes`.
- Secure mode is the `SecureEndpoint` that `createSecureEndpoint({ address, store, handler, platform })` makes: it
  offers pairings, accepts channels, lists and forgets visitors. `connectDevice()` takes it as `secure`, in place of
  `store`, and hands it the secure streams; the connector no longer offers pairings or lists visitors itself.

### Added

- `openSecureChannel(pairing, { via })` opens a channel directly at an address the device gave, rather than through
  its relay.
- `/bun`: `serveDirect()`, a listener on the device's own network that serves only the secure path, and
  `filePairingStore()`, a pairing store in one file.
- `/web`: `webPlatform`, the web standards' clock, timers and secure randomness.
- `pairingOf()`: a visitor reads back its pairing with a device.
- `isSecurePath()` in the protocol, which the connector checks without a `URL`.
- A portability scan of the client's and the protocol's sources against what Hermes refuses or lacks.
- `registerDevice()` and `removeDevice()`.
- `connectDevice()`, which returns a `Connector`: one connector connection with heartbeats it sends every interval, reconnects with exponential backoff and full jitter, and HTTP streams served through a handler under flow control.
- Visitor WebSockets: `connectDevice({ websocket })` accepts or refuses each one, and the service talks over a `TunnelSocket`; close codes pass both ways, and messages larger than a frame or than the credit are split and put back together.
- Secure mode: `createSecureEndpoint({ address, store, handler, platform })` with `offerPairing()`, `accept()`, `onSecureChannel()`, `visitors()` and `forgetVisitor()`, which closes the visitor's open channels, and `connectDevice({ secure })`, which hands it the secure streams; `pairWith()` and `openSecureChannel()` for visitors; a Noise XX handshake (the specification's test vectors pass) with rekeying, a `ready` frame, messages, and fetches answered by the device's own handler. `PairingStore` (`get`, `set`, `delete`, `names`) with `MemoryPairingStore`. A channel's `done` settles once it closed.
- The wire format of octoiitunnel: frames and their payloads, limits, close and reset codes, flow control, the device id and credential formats, and UTF-8 and base64url that run where `TextDecoder` and `btoa` do not.
- `MessageCredit`, `MessageSender` and `toClosing` for WebSocket streams.
