/** A pairing store in one file: a JSON object of names to values, 0600, written whole through a file beside it. */
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import type { PairingStore } from "../secure/store.ts";

/** The file holds no JSON object of strings: nothing overwrites it, so the keys it held are not lost. */
export class MalformedPairingStore extends Error {
	constructor(path: string) {
		super(`The pairing store ${path} is not a JSON object of strings`);
		this.name = "MalformedPairingStore";
	}
}

/** The pairing store at `path`: a missing file holds nothing; each change is written whole, one at a time. */
export function filePairingStore(path: string): PairingStore {
	let queue: Promise<unknown> = Promise.resolve();
	const read = async (): Promise<Record<string, string>> => {
		const text = await readFile(path, "utf8").catch((error: unknown) => (isMissing(error) ? undefined : Promise.reject(error)));
		if (text === undefined) return {};
		const value = parsedOrUndefined(text);
		if (!isStringRecord(value)) throw new MalformedPairingStore(path);
		return value;
	};
	/** Runs a change after the ones before it, so two never write over each other. */
	const change = (apply: (values: Record<string, string>) => void): Promise<void> => {
		const run = queue.then(async () => {
			const values = await read();
			apply(values);
			const temporary = `${path}.${randomUUID()}`;
			await writeFile(temporary, JSON.stringify(values), { mode: 0o600 });
			await rename(temporary, path);
		});
		queue = run.catch(() => undefined);
		return run;
	};
	return {
		get: async (name) => (await read())[name],
		set: (name, value) => change((values) => void (values[name] = value)),
		delete: (name) => change((values) => void delete values[name]),
		names: async (prefix) => Object.keys(await read()).filter((name) => name.startsWith(prefix)),
	};
}

/** The JSON a text holds; undefined where it holds none. */
function parsedOrUndefined(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.values(value).every((each) => typeof each === "string");
}

function isMissing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
