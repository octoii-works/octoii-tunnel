/** The relay's responses and how it calls its hooks, isolated so a failing hook cannot change the traffic. */
import { ERROR_STATUS, type ErrorBody, type ErrorCode } from "@klein-works/takotunnel-protocol";
import type { Authorization, Decision, MeterEvent, RelayOptions } from "./host.ts";

/** An error response in the relay's format. */
export function errorResponse(code: ErrorCode, message: string, headers?: HeadersInit): Response {
	const body: ErrorBody = { error: { code, message } };
	return Response.json(body, { status: ERROR_STATUS[code], ...(headers === undefined ? {} : { headers }) });
}

/** The response to a refusal by `authorize`. */
export function refusal(decision: Decision & { readonly allowed: false }, message: string): Response {
	return errorResponse(decision.status === 429 ? "quota" : "forbidden", message);
}

/** What `authorize` decides; allowed when there is no hook, refused (403) when the hook throws. */
export async function authorize(options: RelayOptions, event: Authorization): Promise<Decision> {
	try {
		return (await options.authorize?.(event)) ?? { allowed: true };
	} catch {
		return { allowed: false, status: 403 };
	}
}

/** Hands `event` to `meter`, ignoring whatever it throws or rejects with. */
export function meter(options: RelayOptions, event: MeterEvent): void {
	try {
		void Promise.resolve(options.meter?.(event)).catch(() => undefined);
	} catch {
		// A metering failure must not change the traffic.
	}
}
