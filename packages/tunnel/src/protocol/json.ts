/** JSON payloads as the protocol carries them: UTF-8 bytes of an object. */
import { ProtocolError } from "./errors.ts";
import { decodeUtf8, encodeUtf8 } from "./utf8.ts";

/** A JSON object whose fields are still to be checked. */
export type JsonObject = { readonly [field: string]: unknown };

/** The UTF-8 bytes of `value` in JSON. */
export function encodeJson(value: unknown): Uint8Array {
	return encodeUtf8(JSON.stringify(value));
}

/** The object that the JSON in `bytes` holds; throws a `ProtocolError` for bytes that are not a JSON object. */
export function decodeJsonObject(bytes: Uint8Array): JsonObject {
	let value: unknown;
	try {
		value = JSON.parse(decodeUtf8(bytes));
	} catch {
		throw new ProtocolError("Invalid JSON");
	}
	if (!isJsonObject(value)) throw new ProtocolError("Expected a JSON object");
	return value;
}

/** Whether `value` is a plain object, as JSON objects parse to. */
export function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether `value` is an integer from `min` to `max`, both included. */
export function isIntegerBetween(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** Whether `value` is a string of at most `max` UTF-16 code units. */
export function isStringUpTo(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length <= max;
}
