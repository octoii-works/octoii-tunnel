# Changelog

## [Unreleased]

### Added

- `createRelay()`: the router, with registration on the base domain and every device request handed to its session.
- `DeviceSession`: authenticates connectors, answers heartbeats, opens HTTP streams under flow control, and resumes from its sockets' attachments when its host wakes it.
- `/bun`: `serveRelay()` and `createBunRelay()`, one Bun process with device records in SQLite.
