# Changelog

## [Unreleased]

### Added

- `registerDevice()` and `removeDevice()`.
- `connectDevice()`, which returns a `Connector`: one connector connection with heartbeats it sends every interval, reconnects with exponential backoff and full jitter, and HTTP streams served through a handler under flow control.
- Visitor WebSockets: `connectDevice({ websocket })` accepts or refuses each one, and the service talks over a `TunnelSocket`; close codes pass both ways, and messages larger than a frame or than the credit are split and put back together.
