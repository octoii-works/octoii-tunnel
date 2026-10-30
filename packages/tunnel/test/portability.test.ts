import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import { portabilityProblems } from "./portability.ts";

const source = new URL("../src/", import.meta.url);

/** `/web`, which reads the web standards' clock, timers and randomness, and `/bun`; every other file runs on any engine. */
const PLATFORM_FILES = /^(?:web\.ts|bun\/)/;

/** The audited cryptography the client is built on. */
const NOBLE = /^@noble\/(?:ciphers|curves|hashes)\/[\w.-]+\.js$/;

/** The platform-neutral TypeScript files, with their text. */
function neutralFiles(): { readonly file: string; readonly text: string }[] {
	return readdirSync(source, { recursive: true, encoding: "utf8" })
		.map((file) => file.replaceAll("\\", "/"))
		.filter((file) => file.endsWith(".ts") && !PLATFORM_FILES.test(file))
		.map((file) => ({ file, text: readFileSync(new URL(file, source), "utf8") }));
}

/** The specifiers `text` imports or re-exports from. */
function specifiers(text: string): string[] {
	return [...text.matchAll(/^\s*(?:import|export)[^;]*?from "([^"]+)";/gms)].map(([, specifier = ""]) => specifier);
}

describe("portability", () => {
	it("imports no platform module and no package but the @noble libraries", () => {
		const offending = neutralFiles().flatMap(({ file, text }) =>
			specifiers(text).flatMap((specifier) => (specifier.startsWith(".") || NOBLE.test(specifier) ? [] : [`${file} imports ${specifier}`])),
		);
		expect(offending).toEqual([]);
	});

	it("uses nothing Hermes refuses or lacks, and reads no host clock, timer or random number", () => {
		const offending = neutralFiles().flatMap(({ file, text }) => portabilityProblems(file, text));
		expect(offending).toEqual([]);
	});

	it("keeps the protocol free of the client: its files import only each other and @noble/hashes", () => {
		const protocolFiles = neutralFiles().filter(({ file }) => file.startsWith("protocol/"));
		expect(protocolFiles.length).toBeGreaterThan(0);
		const offending = protocolFiles.flatMap(({ file, text }) =>
			specifiers(text).flatMap((specifier) =>
				/^\.\/[\w-]+\.ts$/.test(specifier) || specifier.startsWith("@noble/hashes/") ? [] : [`${file} imports ${specifier}`],
			),
		);
		expect(offending).toEqual([]);
	});

	it("finds what it forbids in code, and not in comments or strings", () => {
		expect(portabilityProblems("a.ts", "const now = Date.now();")).toEqual(["a.ts uses Date.now"]);
		expect(portabilityProblems("a.ts", "crypto.getRandomValues(bytes);")).toEqual(["a.ts uses crypto"]);
		expect(portabilityProblems("a.ts", "new URL(text).pathname;")).toEqual(["a.ts uses a URL"]);
		expect(portabilityProblems("a.ts", "setTimeout(run, 10);")).toEqual(["a.ts uses a timer"]);
		expect(portabilityProblems("a.ts", '// Date.now and crypto, in words\nconst text = "new URL(x) and setTimeout";')).toEqual([]);
	});
});
