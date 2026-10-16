import { isObject, validDeviceId } from "./protocol/index.ts";

export interface Device {
	deviceId: string;
	credential: string;
	address: string;
}

export function relayOrigin(value: string): URL {
	const url = new URL(value);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
		throw new Error("Expected a relay origin");
	}
	return url;
}

export async function registerDevice(options: { relay: string; token: string; name?: string }): Promise<Device> {
	const response = await fetch(new URL("/v1/devices", relayOrigin(options.relay)), {
		method: "POST",
		headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
		body: JSON.stringify({ name: options.name }),
		redirect: "error",
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Registration failed (${response.status})`);
	}
	const value: unknown = await response.json();
	if (
		!isObject(value) ||
		typeof value.deviceId !== "string" ||
		!validDeviceId(value.deviceId) ||
		typeof value.credential !== "string" ||
		!/^[A-Za-z0-9_-]{43}$/.test(value.credential) ||
		typeof value.address !== "string"
	) {
		throw new Error("Invalid device response");
	}
	const expected = relayOrigin(options.relay);
	expected.hostname = `${value.deviceId}.${expected.hostname}`;
	if (value.address !== expected.origin) throw new Error("Unexpected device address");
	return { deviceId: value.deviceId, credential: value.credential, address: value.address };
}

export async function removeDevice(options: { relay: string; device: Device }): Promise<void> {
	if (!validDeviceId(options.device.deviceId)) throw new Error("Invalid device id");
	const response = await fetch(new URL(`/v1/devices/${options.device.deviceId}`, relayOrigin(options.relay)), {
		method: "DELETE",
		headers: { authorization: `Bearer ${options.device.credential}` },
		redirect: "error",
	});
	await response.body?.cancel();
	if (response.status !== 204) throw new Error(`Removal failed (${response.status})`);
}
