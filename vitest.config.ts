/**
 * Runs the tests on Node, to hold the packages to running there as well as on Bun. The tests are written against
 * `bun:test`, which `vitest.bun-test.ts` gives them on Node. A test file that uses Bun itself (`Bun.*`, `bun:sqlite`), or
 * a helper of its test folder that does, runs on Bun only.
 *
 *   bun run test:node
 */
import { existsSync, globSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { defineConfig } from "vitest/config";

const NEEDS_BUN = /\bBun\.|from "bun(:sqlite)?"/;

/** Test files that reach Bun through a `/bun` entry, which no import of theirs shows. */
const THROUGH_BUN_ENTRIES: readonly string[] = [];

/** Whether a test file, or a helper of its folder it imports, needs Bun, following helpers that import helpers. */
function needsBun(file: string, seen = new Set<string>()): boolean {
	if (seen.has(file)) return false;
	seen.add(file);
	const text = readFileSync(file, "utf8");
	if (NEEDS_BUN.test(text)) return true;
	const helpers = [...text.matchAll(/from "\.\/([\w.-]+\.ts)"/g)].map((match) => join(dirname(file), match[1] ?? ""));
	// A path that is no file, as in a fixture's source text, is no helper.
	return helpers.some((helper) => basename(helper) !== basename(file) && existsSync(helper) && needsBun(helper, seen));
}

/** The packages of the workspace, as the root `package.json` lists them. */
const PACKAGES: string[] = JSON.parse(readFileSync(join(import.meta.dirname, "package.json"), "utf8")).workspaces.packages.filter((path: string) =>
	path.startsWith("packages/"),
);

export default defineConfig({
	resolve: { alias: { "bun:test": join(import.meta.dirname, "vitest.bun-test.ts") } },
	test: {
		include: PACKAGES.flatMap((path) => globSync(`${path}/test/**/*.test.{ts,tsx}`)).filter((file) => !THROUGH_BUN_ENTRIES.includes(file) && !needsBun(file)),
		// As in each package's `bun test --timeout`: a timeout only caps a hang, since a busy machine slows the tests down.
		testTimeout: 60_000,
		hookTimeout: 60_000,
	},
});
