# Changelog

## [Unreleased]

### Added

- `createRelay()`: the router, with registration on the base domain and every device request handed to its session.
- `DeviceSession`: authenticates connectors, answers heartbeats, opens HTTP streams under flow control, and resumes from its sockets' attachments when its host wakes it.
- `/bun`: `serveRelay()` and `createBunRelay()`, one Bun process with device records in SQLite.
- Visitor WebSockets carried as streams: subprotocols, refusals, close codes both ways, per-chunk credit with the relay holding grants while a visitor falls behind, and streams that resume from their sockets when the host wakes the session.
- `/worker`: `defineRelay(hooks)`, the Worker and the Durable Object class for hosts with the Workers and Durable Object APIs: records in the object's storage, hibernating sockets whose attachments let the session resume, and heartbeats answered automatically.
