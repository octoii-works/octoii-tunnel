/** The relay as a Worker with its Durable Object class, as a deployment's entry exports them; bundled by the tests. */
import { defineRelay } from "../src/worker/index.ts";

const relay = defineRelay();

export default relay.worker;
export const DeviceObject = relay.DeviceObject;
