/** The relay's router: registration on the base domain, and every other request handed to its device's session. */
import {
	decodeJsonObject,
	deviceAddress,
	hashCredential,
	isDeviceId,
	isStringUpTo,
	type JsonObject,
	matchDevicePath,
	MAX_DEVICE_NAME_LENGTH,
	MAX_REGISTRATION_BYTES,
	newCredential,
	newDeviceId,
	parseRelayOrigin,
	type RelayOrigin,
	REGISTRATION_PATH,
	type Registration,
	sameSecret,
} from "@octoii-works/tunnel/protocol";
import { authorize, errorResponse, refusal } from "./hooks.ts";
import type { RelayHost, RelayOptions } from "./host.ts";

/** How many fresh ids registration tries before it gives up on a collision. */
const REGISTRATION_ATTEMPTS = 3;

/** A relay's router. */
export type Relay = {
	/** The relay's checked configuration. */
	readonly options: RelayOptions;
	/** Answers `request`, handing device requests to `host`; `undefined` when the host upgraded it. */
	handle(request: Request, host: RelayHost): Promise<Response | undefined>;
};

/** A relay's router, with its configuration checked. */
export function createRelay(options: RelayOptions): Relay {
	const origin = parseRelayOrigin(options.origin);
	if (options.registrationToken === "") throw new Error("A relay needs a registration token");
	return { options, handle: (request, host) => route(request, host, origin, options) };
}

async function route(request: Request, host: RelayHost, origin: RelayOrigin, options: RelayOptions): Promise<Response | undefined> {
	const url = new URL(request.url);
	if (url.host === origin.host) {
		if (url.pathname === REGISTRATION_PATH && request.method === "POST") return register(request, host, origin, options);
		const match = matchDevicePath(url.pathname);
		if (match !== undefined) return host.forward(match.deviceId, request);
		return errorResponse("not_found", "Unknown route");
	}
	const deviceId = deviceIdOf(url.host, origin);
	return deviceId === undefined ? errorResponse("not_found", "Unknown route") : host.forward(deviceId, request);
}

/** The device a visitor's host names: `<device id>.<relay host>`. */
function deviceIdOf(host: string, origin: RelayOrigin): string | undefined {
	const suffix = `.${origin.host}`;
	if (!host.endsWith(suffix)) return undefined;
	const deviceId = host.slice(0, -suffix.length);
	return isDeviceId(deviceId) ? deviceId : undefined;
}

async function register(request: Request, host: RelayHost, origin: RelayOrigin, options: RelayOptions): Promise<Response> {
	if (!sameSecret(request.headers.get("authorization") ?? "", `Bearer ${options.registrationToken}`)) {
		return errorResponse("unauthorized", "Invalid registration token");
	}
	const decision = await authorize(options, { kind: "register", request });
	if (!decision.allowed) return refusal(decision, "Registration refused");
	const name = await registrationName(request);
	if (name === undefined) return errorResponse("invalid", "A registration body is at most 4096 bytes of { name? }");
	for (let attempt = 0; attempt < REGISTRATION_ATTEMPTS; attempt++) {
		const deviceId = newDeviceId((length) => host.randomBytes(length));
		const credential = newCredential((length) => host.randomBytes(length));
		if (!(await host.createDevice({ id: deviceId, name, credentialHash: hashCredential(credential) }))) continue;
		const registration: Registration = { deviceId, credential, address: deviceAddress(origin, deviceId) };
		return Response.json(registration, { status: 201 });
	}
	return errorResponse("internal", "Registration unavailable");
}

/** The name in a registration body (empty when there is none), or `undefined` when the body is invalid. */
async function registrationName(request: Request): Promise<string | undefined> {
	const bytes = await readBytes(request, MAX_REGISTRATION_BYTES);
	if (bytes === undefined) return undefined;
	if (bytes.length === 0) return "";
	let body: JsonObject;
	try {
		body = decodeJsonObject(bytes);
	} catch {
		return undefined;
	}
	const name = body["name"];
	if (name === undefined) return "";
	return isStringUpTo(name, MAX_DEVICE_NAME_LENGTH) ? name : undefined;
}

/** The request's body, or `undefined` when it is longer than `limit` bytes. */
async function readBytes(request: Request, limit: number): Promise<Uint8Array | undefined> {
	const reader = request.body?.getReader();
	if (reader === undefined) return new Uint8Array(0);
	const bytes = new Uint8Array(limit);
	let size = 0;
	try {
		for (let read = await reader.read(); !read.done; read = await reader.read()) {
			if (size + read.value.length > limit) return undefined;
			bytes.set(read.value, size);
			size += read.value.length;
		}
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
	return bytes.subarray(0, size);
}
