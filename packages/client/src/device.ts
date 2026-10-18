/** Registering a device with a relay, and removing it. */
import { decodeRegistration, devicePath, isCredential, isDeviceId, parseRelayOrigin, REGISTRATION_PATH, type Registration } from "@octoii/tunnel-protocol";

/** A registered device: its id, its credential and its address. Keep it secret, as the credential is only shown once. */
export type Device = Registration;

/** Registers a new device with the relay at `relay`, presenting its registration `token`. */
export async function registerDevice(options: { readonly relay: string; readonly token: string; readonly name?: string }): Promise<Device> {
	const relay = parseRelayOrigin(options.relay);
	const response = await fetch(relay.origin + REGISTRATION_PATH, {
		method: "POST",
		headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
		body: JSON.stringify(options.name === undefined ? {} : { name: options.name }),
		redirect: "error",
	});
	if (response.status !== 201) {
		await response.body?.cancel();
		throw new Error(`Registration failed with status ${response.status}`);
	}
	return decodeRegistration(await response.json(), relay);
}

/** Removes the device from the relay: its record goes, and its connector is disconnected for good. */
export async function removeDevice(options: { readonly relay: string; readonly device: Device }): Promise<void> {
	const { deviceId, credential } = options.device;
	if (!isDeviceId(deviceId) || !isCredential(credential)) throw new Error("Not a device");
	const response = await fetch(parseRelayOrigin(options.relay).origin + devicePath(deviceId), {
		method: "DELETE",
		headers: { authorization: `Bearer ${credential}` },
		redirect: "error",
	});
	await response.body?.cancel();
	if (response.status !== 204) throw new Error(`Removal failed with status ${response.status}`);
}
