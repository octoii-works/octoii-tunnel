# takotunnel

Reach a service on your own machine from anywhere, without opening a port, and without the relay in between being
able to read what you send.

Your machine connects out to a relay and keeps that connection open. Visitors reach the machine at its own address on
the relay, `https://<device>.<relay domain>`, and the relay forwards their requests over the connection. Paired
visitors can talk to the machine end to end encrypted: the relay then forwards only ciphertext.

Tako uses takotunnel so you can talk to the agent on your PC from your phone. Anything else that serves HTTP or
WebSockets can use it too.

## Two modes

| Mode | What the relay sees | Who can use it |
| --- | --- | --- |
| **Plain** | The HTTP requests and WebSocket messages it forwards, as any reverse proxy does | Any HTTP or WebSocket client, such as a browser opening the device's address |
| **Secure** | Only ciphertext: a Noise channel runs between the visitor and the machine | A visitor paired with the machine, using takotunnel's visitor library |

In both modes the relay keeps nothing of the traffic: no bodies, no header values, no query strings.

## Pieces

| Package | What it is |
| --- | --- |
| [`@klein-works/takotunnel`](packages/client) | The client. On the machine: register it, keep its connection to the relay, serve what visitors ask through a handler, offer pairings, and accept secure channels. On the visitor: pair, and open a secure channel. A `takotunnel` command exposes a local port |
| [`@klein-works/takotunnel-relay`](packages/relay) | The relay, built on the standard Workers and Durable Object APIs: a Worker that routes, and one Durable Object per device |

## Use it

Expose a local port:

```sh
takotunnel register --relay https://takotunnel.dev   # once: prints the device's address
takotunnel http 3000                                  # forwards visitors to localhost:3000
```

From code, on the machine:

```ts
import { connectAgent, registerDevice } from "@klein-works/takotunnel";

const device = await registerDevice({ relay: "https://takotunnel.dev", token });
const agent = connectAgent({ relay: "https://takotunnel.dev", device, handler: (request) => app.fetch(request) });
const offer = await agent.offerPairing(); // show offer.url as a QR code to the visitor
agent.onSecureChannel((channel) => serve(channel));
```

On the visitor:

```ts
import { pairWith, openSecureChannel } from "@klein-works/takotunnel";

const pairing = await pairWith(offerUrl, { store }); // once, from the QR code
const channel = await openSecureChannel(pairing, { store });
channel.send(message);
```

## Run your own relay

The relay needs the standard Workers and Durable Object APIs: `fetch` handlers, Durable Object SQLite storage, alarms
and hibernating WebSockets. Deploy `packages/relay` wherever those run, with:

- a wildcard domain, `*.<your domain>`, pointing at it, and the bare domain for registration;
- `REGISTRATION_TOKEN`, the secret a machine presents to register.

Point the client at your relay with `--relay` or the `relay` option.

## Docs

- [Design](docs/design.md): the parts, how they fit, and what the core leaves to a hosted service.
- [Protocol](docs/protocol.md): the relay's HTTP API and the frames on a machine's connection.
- [Security](docs/security.md): pairing, the secure channel, and what each party can and cannot see.

## Status

Under construction. The license is being decided.
