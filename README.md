# takotunnel

Reach a service on your own machine from anywhere, without opening a port, and without the relay in between being
able to read what you send.

Your machine runs a connector that connects out to a relay and keeps that connection open. Visitors reach the machine
at its own address on the relay, `https://<device>.<relay domain>`, and the relay forwards their requests over the
connection. Paired visitors can talk to the machine end to end encrypted: the relay then forwards only ciphertext.

Tako uses takotunnel so you can talk to the agent on your PC from your phone. Anything else that serves HTTP or
WebSockets can use it too.

## Two modes

| Mode | What the relay sees | Who can use it |
| --- | --- | --- |
| **Plain** | The HTTP requests and WebSocket messages it forwards, as any reverse proxy does | Any HTTP or WebSocket client, such as a browser opening the device's address |
| **Secure** | Only ciphertext: a Noise channel runs between the visitor and the connector | A visitor paired with the device, using the visitor library |

In both modes the relay keeps nothing of the traffic: no bodies, no header values, no query strings.

## Packages

| Package | What it is |
| --- | --- |
| [`@klein-works/takotunnel-protocol`](packages/protocol) | The wire format: frames, payloads, limits, flow control, device id and credential formats |
| [`@klein-works/takotunnel`](packages/client) | The client. On the device: register it, run its connector, offer pairings, accept secure channels. On the visitor: pair, and open a secure channel. A `takotunnel` command exposes a local port |
| [`@klein-works/takotunnel-relay`](packages/relay) | The relay: its core, and adapters for hosts with the Workers and Durable Object APIs (`/worker`) and for a single Bun process with SQLite (`/bun`) |

## Use it

Expose a local port:

```sh
takotunnel register --relay https://takotunnel.dev   # once: prints the device's address
takotunnel http 3000                                  # forwards visitors to localhost:3000
```

From code, on the device:

```ts
import { connectDevice, registerDevice } from "@klein-works/takotunnel";

const device = await registerDevice({ relay: "https://takotunnel.dev", token });
const connector = connectDevice({ relay: "https://takotunnel.dev", device, handler: (request) => app.fetch(request) });
const offer = await connector.offerPairing(); // show offer.url as a QR code to the visitor
connector.onSecureChannel((channel) => serve(channel));
```

On the visitor:

```ts
import { openSecureChannel, pairWith } from "@klein-works/takotunnel";

const pairing = await pairWith(offerUrl, { store }); // once, from the QR code
const channel = await openSecureChannel(pairing, { store });
channel.send(message);
```

## Run your own relay

- **On a host with the Workers and Durable Object APIs:** deploy `@klein-works/takotunnel-relay/worker` with a
  Durable Object binding for device sessions. Idle devices hibernate and cost nothing.
- **On one machine:** run `@klein-works/takotunnel-relay/bun`, which keeps device records in a SQLite file.

Either way you need a wildcard domain (`*.<your domain>`) and the bare domain pointing at the relay, TLS for both, and
`REGISTRATION_TOKEN`, the secret a device presents to register. Point the client at your relay with `--relay` or the
`relay` option.

## Docs

- [Design](docs/design.md): the packages, the relay and its hosts, the connector.
- [Protocol](docs/protocol.md): the relay's HTTP API and the connector connection.
- [Security](docs/security.md): pairing, the secure channel, and what each party can and cannot see.
- [Development](docs/development.md): checks, building and packing.

## Status

Under construction. Built: the protocol package; registration; the connector with heartbeats and reconnects; plain
HTTP streams and visitor WebSockets under flow control; sessions that resume from their sockets; and the Bun host with
SQLite. Being built, in order: the Durable Object host with hibernation, then pairing and secure channels, then the
`takotunnel` command.

## License

[MIT](LICENSE).
