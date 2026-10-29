# octoiitunnel

Reach a service on your own machine from anywhere, without opening a port, and without the relay in between being
able to read what you send.

Your machine runs a connector that connects out to a relay and keeps that connection open. Visitors reach the machine
at its own address on the relay, `https://<device>.<relay domain>`, and the relay forwards their requests over the
connection. Paired visitors can talk to the machine end to end encrypted: the relay then forwards only ciphertext.

Octoii uses octoiitunnel so you can talk to the agent on your PC from your phone. Anything else that serves HTTP or
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
| [`@octoii-works/tunnel`](packages/tunnel) | The client. On the device: register it, run its connector, offer pairings, accept secure channels. On the visitor: pair, and open a secure channel. The wire format as `/protocol`, the web standards' clock and randomness as `/web`, and an `octoiitunnel` command that exposes a local port |
| [`@octoii-works/tunnel-relay`](packages/relay) | The relay: its core, and adapters for hosts with the Workers and Durable Object APIs (`/worker`) and for a single Bun process with SQLite (`/bun`) |

Both are released together at one version; the relay depends on the same version of `@octoii-works/tunnel` and takes
only its `/protocol`.

## Use it

Expose a local port:

```sh
octoiitunnel register --relay https://octoiitunnel.com   # once: prints the device's address
octoiitunnel http 3000                                  # forwards visitors to localhost:3000
```

From code, on the device:

```ts
import { connectDevice, registerDevice } from "@octoii-works/tunnel";
import { webPlatform } from "@octoii-works/tunnel/web";

const device = await registerDevice({ relay: "https://octoiitunnel.com", token });
const connector = connectDevice({ relay: "https://octoiitunnel.com", device, handler: (request) => app.fetch(request), platform: webPlatform });
const offer = await connector.offerPairing(); // show offer.url as a QR code to the visitor
connector.onSecureChannel((channel) => serve(channel));
```

On the visitor:

```ts
import { openSecureChannel, pairWith } from "@octoii-works/tunnel";

const pairing = await pairWith(offerUrl, { store, platform }); // once, from the QR code
const channel = await openSecureChannel(pairing, { store, platform });
channel.send(message);
```

The client reads no clock, timer or randomness of its own: `platform` gives them. `webPlatform` uses `Date.now`,
`setTimeout` and `crypto.getRandomValues`; on an engine without `crypto.getRandomValues`, such as Hermes, pass the
app's own secure random bytes as `randomBytes`.

## Run your own relay

- **On a host with the Workers and Durable Object APIs:** deploy `@octoii-works/tunnel-relay/worker` with a
  Durable Object binding for device sessions. Idle devices hibernate and cost nothing.
- **On one machine:** run `@octoii-works/tunnel-relay/bun`, which keeps device records in a SQLite file.

Either way you need a wildcard domain (`*.<your domain>`) and the bare domain pointing at the relay, TLS for both, and
`REGISTRATION_TOKEN`, the secret a device presents to register. Point the client at your relay with `--relay` or the
`relay` option.

## Docs

- [Design](docs/design.md): the packages, the relay and its hosts, the connector.
- [Protocol](docs/protocol.md): the relay's HTTP API and the connector connection.
- [Security](docs/security.md): pairing, the secure channel, and what each party can and cannot see.
- [Development](docs/development.md): checks, building and packing.

## Status

Under construction. Built: the protocol; registration; the connector with heartbeats and reconnects; plain
HTTP streams and visitor WebSockets under flow control; sessions that resume from their sockets; and the Bun host with
SQLite and the Durable Object host with hibernation, both passing one behavioral suite; pairing and secure channels;
a client that runs on the platform it is given, held to it by a portability scan.
Being built: reopening a dropped secure channel on its own, a file-backed pairing store, and the `octoiitunnel`
command.

## License

[MIT](LICENSE).
