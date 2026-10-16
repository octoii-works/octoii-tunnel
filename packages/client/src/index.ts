/**
 * The takotunnel client. On a device: register it with a relay, and run its connector, which serves visitors' requests
 * through a handler, offer pairings and accept secure channels. On a visitor: pair with a device, and open secure
 * channels to it. It runs wherever web standards do.
 */
export { reconnectDelay } from "./backoff.ts";
export { Connector, type ConnectorOptions, connectDevice } from "./connector.ts";
export { type Device, registerDevice, removeDevice } from "./device.ts";
export type { Handler } from "./http-stream.ts";
export type { TunnelSocket, WebSocketHandler } from "./websocket-stream.ts";
export type { SecureChannel, VisitorChannel, VisitorIdentity } from "./secure/channel.ts";
export type { PairingOffer } from "./secure/offers.ts";
export { MemoryPairingStore, type PairedVisitor, type Pairing, type PairingStore } from "./secure/store.ts";
export { openSecureChannel, pairWith } from "./secure/visitor.ts";
