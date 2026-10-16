import { credentialHash, equalSecrets, parseObject, randomCredential, randomDeviceId, validDeviceId } from "@klein-works/takotunnel/protocol";
import { authorize, errorResponse, type RelayDirectory, type RelayOptions } from "./host.ts";

export function createRelay(options: RelayOptions) {
	const origin = new URL(options.origin);
	if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)
		throw new Error("Expected a relay origin");
	if (!options.registrationToken) throw new Error("A registration token is required");
	return {
		async fetch(request: Request, directory: RelayDirectory): Promise<Response | undefined> {
			const url = new URL(request.url);
			if (url.host === origin.host) {
				if (url.pathname === "/v1/devices" && request.method === "POST") return register(request, options, directory);
				const match = /^\/v1\/(agent|devices)\/([a-z2-7]{26})$/.exec(url.pathname);
				if (match?.[2]) return directory.dispatch(match[2], request);
			} else {
				const suffix = `.${origin.hostname}`;
				if (url.port === origin.port && url.hostname.endsWith(suffix)) {
					const id = url.hostname.slice(0, -suffix.length);
					if (validDeviceId(id)) return directory.dispatch(id, request);
				}
			}
			return errorResponse(404, "not_found", "Unknown route");
		},
	};
}

async function register(request: Request, options: RelayOptions, directory: RelayDirectory): Promise<Response> {
	const token = request.headers.get("authorization") ?? "";
	if (!equalSecrets(token, `Bearer ${options.registrationToken}`)) return errorResponse(401, "unauthorized", "Invalid registration token");
	const decision = await authorize(options, { kind: "register", request });
	if (!decision.allowed) return errorResponse(decision.status, decision.status === 429 ? "quota" : "forbidden", "Registration refused");
	let name = "";
	try {
		const bytes = await readSmallBody(request);
		const payload = bytes.length ? parseObject(bytes) : {};
		if (payload.name !== undefined && (typeof payload.name !== "string" || payload.name.length > 128)) {
			return errorResponse(400, "invalid", "Invalid device name");
		}
		name = typeof payload.name === "string" ? payload.name : "";
	} catch {
		return errorResponse(400, "invalid", "Invalid registration body");
	}
	for (let attempt = 0; attempt < 3; attempt++) {
		const id = randomDeviceId();
		const credential = randomCredential();
		if (!(await directory.create({ id, name, credentialHash: credentialHash(credential) }))) continue;
		const address = new URL(options.origin);
		address.hostname = `${id}.${address.hostname}`;
		return Response.json({ deviceId: id, credential, address: address.origin }, { status: 201 });
	}
	return errorResponse(503, "internal", "Registration unavailable");
}

async function readSmallBody(request: Request): Promise<Uint8Array> {
	const reader = request.body?.getReader();
	if (!reader) return new Uint8Array();
	const buffer = new Uint8Array(4096);
	let length = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) return buffer.subarray(0, length);
			if (length + value.length > buffer.length) throw new Error("Registration too large");
			buffer.set(value, length);
			length += value.length;
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
