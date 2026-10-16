/**
 * The takotunnel relay's core: the router and the device session, and the interfaces a host implements to run them.
 * Hosts live in subpaths: `/worker` for the Workers and Durable Object APIs, `/bun` for one Bun process.
 */
export { errorResponse } from "./hooks.ts";
export type {
	Authorization,
	Clock,
	Decision,
	DeviceRecord,
	DeviceRecords,
	MeterEvent,
	RelayHost,
	RelayOptions,
	RequestContext,
	SessionHost,
	SessionSocket,
	SessionSockets,
	SocketAttachment,
} from "./host.ts";
export { createRelay, type Relay } from "./router.ts";
export { DeviceSession } from "./session.ts";
