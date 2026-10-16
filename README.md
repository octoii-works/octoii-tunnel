# takotunnel

Reach a service on a machine behind NAT through a relay that the machine connects out to. The client and relay
cores use web-standard APIs; hosts supply networking, device storage and scheduling.

The working implementation supports registration, agent authentication and reconnection, and streamed HTTP
requests and responses. Visitor WebSocket forwarding, pairing, encrypted channels and the local-port CLI remain
implementation targets described in the specs. **Current HTTP traffic is plain mode: the relay can read it.**

## Packages

| Package | Entries |
| --- | --- |
| `@klein-works/takotunnel` | Root: `registerDevice`, `removeDevice`, `connectAgent`. `/protocol`: frame codecs, validation and flow control |
| `@klein-works/takotunnel-relay` | Root: routing, device sessions, host interfaces and an in-memory device store. `/bun`: network adapter and standalone server |

Both packages are MIT. Root entries contain no server-runtime imports. There is no bundled database or cloud
provider SDK. The relay depends only on the client's shared protocol; the client never depends on the relay.
Packages remain private until publication is explicitly enabled.

## Client

```ts
import { connectAgent, registerDevice } from "@klein-works/takotunnel";

const relay = "https://relay.example.com";
const device = await registerDevice({ relay, token });
const agent = connectAgent({
  relay,
  device,
  handler: (request) => app.fetch(request),
});
await agent.ready;
// Visitors can now reach device.address.
// Save device securely to reconnect without registering again.
```

The handler receives a standard `Request` and returns a `Response`. Bodies stream under per-stream flow control.
An agent reconnects after a connection failure. Replaced agents and agents with invalid credentials stop.

## Relay

The included network adapter runs in one Bun process. The host explicitly supplies its device store:

```ts
import { createMemoryDeviceStore } from "@klein-works/takotunnel-relay";
import { serveRelay } from "@klein-works/takotunnel-relay/bun";

const relay = serveRelay({
  origin: "http://localhost:8787",
  registrationToken: token,
  store: createMemoryDeviceStore(),
  port: 8787,
});
// await relay.close();
```

The memory store is for development and tests: registrations disappear when the process ends. An application
implements `DeviceStore` to keep device records in its own storage. It owns that storage's lifecycle. No traffic
bodies, header values or query strings belong in device records.

For public deployment, supply a wildcard domain and TLS, persistent device storage, and a registration token.
Every request for one device must reach the process holding its agent connection. Sharing a store alone does not
make a multi-process relay. Other runtimes can implement the same host interfaces; their network adapters are not
included yet.

## Development

```sh
bun install
bun run check
bun run build
bun run pack
bun run verify:packages
```

`bun run relay` starts the development relay using in-memory storage. It reads `REGISTRATION_TOKEN` (required),
`RELAY_ORIGIN`, `HOST` and `PORT` from the environment. See [Development](docs/development.md) for packaging and checks.

## Specs

- [Design](docs/design.md): architecture, host boundaries and implementation targets.
- [Protocol](docs/protocol.md): HTTP routes, agent frames and flow control.
- [Security](docs/security.md): the pairing and encrypted-channel design to implement.

## License

The repository and both packages are [MIT](LICENSE).
