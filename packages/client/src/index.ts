/**
 * The takotunnel client. On a device: register it with a relay, and run its connector, which serves visitors' requests
 * through a handler. It runs wherever web standards do.
 */
export { reconnectDelay } from "./backoff.ts";
export { Connector, type ConnectorOptions, connectDevice } from "./connector.ts";
export { type Device, registerDevice, removeDevice } from "./device.ts";
export type { Handler } from "./http-stream.ts";
