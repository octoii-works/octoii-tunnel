/**
 * The octoiitunnel client. On a device: register it with a relay, and run its connector, which serves visitors' requests
 * through a handler, offer pairings and accept secure channels. On a visitor: pair with a device, and open secure
 * channels to it. It runs wherever JavaScript and the web's `fetch`, `Request`, `Response` and `WebSocket` do, on the
 * clock, timers and randomness its caller passes as a `Platform`; `/web` has the web standards' own.
 */
export { reconnectDelay } from "./backoff.ts";
export { Connector, type ConnectorOptions, connectDevice } from "./connector.ts";
export { type Device, registerDevice, removeDevice } from "./device.ts";
export type { Handler } from "./http-stream.ts";
export type { Clock, Platform, RandomBytes } from "./platform.ts";
export type { TunnelSocket, WebSocketHandler } from "./websocket-stream.ts";
export type { SecureChannel, VisitorChannel, VisitorIdentity } from "./secure/channel.ts";
export type { PairingOffer } from "./secure/offers.ts";
export { MemoryPairingStore, type PairedVisitor, type Pairing, pairingOf, type PairingStore } from "./secure/store.ts";
export { openSecureChannel, type PairingOptions, pairWith, type SecureChannelOptions } from "./secure/visitor.ts";
