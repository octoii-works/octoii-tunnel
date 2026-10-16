# Changelog

## [Unreleased]

### Added

- `registerDevice()` and `removeDevice()`.
- `connectDevice()`, which returns a `Connector`: one connector connection with heartbeats it sends every interval, reconnects with exponential backoff and full jitter, and HTTP streams served through a handler under flow control.
