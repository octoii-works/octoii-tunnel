/** The relay's HTTP API: its paths, the registration it answers, and its errors. */
import { ProtocolError } from "./errors.ts";
import { deviceAddress, isCredential, isDeviceId, type RelayOrigin } from "./formats.ts";
import { isJsonObject } from "./json.ts";

/** Where devices register: `POST` on the base domain. */
export const REGISTRATION_PATH = "/v1/devices";
/** The path on a device's address that a secure channel opens on; the connector keeps it from the service. */
export const SECURE_PATH = "/.takotunnel/secure";
/** The largest registration body the relay reads. */
export const MAX_REGISTRATION_BYTES = 4096;
/** The longest name a device may register with. */
export const MAX_DEVICE_NAME_LENGTH = 128;

const DEVICE_PATH = /^\/v1\/(devices|connect)\/([a-z2-7]{26})$/;

/** Where a device is removed: `DELETE` with its credential. */
export function devicePath(deviceId: string): string {
	return `${REGISTRATION_PATH}/${deviceId}`;
}

/** Where a device's connector connects: a WebSocket upgrade. */
export function connectPath(deviceId: string): string {
	return `/v1/connect/${deviceId}`;
}

/** What a base-domain path names for one device: its record (`devices`) or its connector connection (`connect`). */
export type DevicePathMatch = { readonly target: "devices" | "connect"; readonly deviceId: string };

/** The device and target a base-domain path names, or `undefined` for any other path. */
export function matchDevicePath(path: string): DevicePathMatch | undefined {
	const match = DEVICE_PATH.exec(path);
	const target = match?.[1];
	const deviceId = match?.[2];
	if ((target !== "devices" && target !== "connect") || deviceId === undefined) return undefined;
	return { target, deviceId };
}

/** What a device gets when it registers. The credential is shown only here. */
export type Registration = { readonly deviceId: string; readonly credential: string; readonly address: string };

/** The registration in a relay's answer, checked, including that the address is the one `relay` gives that device. */
export function decodeRegistration(value: unknown, relay: RelayOrigin): Registration {
	if (!isJsonObject(value)) throw new ProtocolError("Invalid registration");
	const { deviceId, credential, address } = value;
	if (!isDeviceId(deviceId) || !isCredential(credential) || address !== deviceAddress(relay, deviceId)) {
		throw new ProtocolError("Invalid registration");
	}
	return { deviceId, credential, address };
}

/** The error codes the relay answers with, each with its HTTP status. */
export const ERROR_STATUS = {
	invalid: 400,
	unauthorized: 401,
	forbidden: 403,
	not_found: 404,
	upgrade_required: 426,
	quota: 429,
	internal: 500,
	not_implemented: 501,
	offline: 502,
	busy: 503,
	timeout: 504,
} as const;

/** An error code of the relay. */
export type ErrorCode = keyof typeof ERROR_STATUS;

/** The body of a relay's error response. */
export type ErrorBody = { readonly error: { readonly code: ErrorCode; readonly message: string } };
