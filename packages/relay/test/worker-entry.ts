/** The relay as a Worker with its Durable Object class, as a deployment's entry exports them; bundled by the tests. */
import { defineRelay } from "../src/worker/index.ts";

const relay = defineRelay();

/** The relay's Worker, which routes each request. */
export default relay.worker;
/** The Durable Object class that holds each device's session. */
export const DeviceObject = relay.DeviceObject;
