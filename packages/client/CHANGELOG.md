# Changelog

## [Unreleased]

### Added

- `registerDevice()` and `removeDevice()`.
- `connectDevice()`, which returns a `Connector`: one connector connection with heartbeats it sends every interval, reconnects with exponential backoff and full jitter, and HTTP streams served through a handler under flow control.
- Visitor WebSockets: `connectDevice({ websocket })` accepts or refuses each one, and the service talks over a `TunnelSocket`; close codes pass both ways, and messages larger than a frame or than the credit are split and put back together.
- Secure mode: `connectDevice({ store })` with `offerPairing()`, `onSecureChannel()` and `forgetVisitor()`; `pairWith()` and `openSecureChannel()` for visitors; a Noise XX handshake (the specification's test vectors pass) with rekeying, a `ready` frame, messages, and fetches answered by the device's own handler. `PairingStore` with `MemoryPairingStore`.
