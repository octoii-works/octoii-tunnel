/**
 * Runs one of the plugin's rules through the real oxlint binary: each case is a fixture file, one generated config turns
 * on that rule alone, and one oxlint run lints every fixture the tester holds. Each case is a `bun:test` test.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

/** What a rejected case reports: one message, the messages in source order, or how many diagnostics. */
export type Expected = string | readonly string[] | number;

/** The cases of one rule under one set of options, each registered as a test. */
export type RuleTester = {
	/** A case the rule accepts: oxlint reports nothing for `code`, kept at `path` when the rule reads where its file is. */
	readonly valid: (name: string, code: string, path?: string) => void;
	/** A case the rule rejects: oxlint reports exactly what `expected` says for `code`, all of it from the rule. */
	readonly invalid: (name: string, code: string, expected: Expected, path?: string) => void;
};

/** What a tester takes besides the rule's name: the options oxlint hands the rule, and a label for its tests. */
export type RuleTesterOptions = { readonly options?: readonly unknown[]; readonly label?: string };

/** One diagnostic of oxlint's JSON format, as the tester reads it. */
type Diagnostic = {
	readonly message: string;
	readonly code: string;
	readonly filename: string;
	readonly labels: readonly { readonly span: { readonly offset: number } }[];
};

/** oxlint's JSON report. */
type Report = { readonly diagnostics: readonly Diagnostic[]; readonly number_of_files: number; readonly number_of_rules: number };

/** One case's source and where its file is kept, relative to the run's directory. */
type Fixture = { readonly code: string; readonly file: string };

const PLUGIN = fileURLToPath(new URL("../index.ts", import.meta.url));
const OXLINT = join(dirname(fileURLToPath(import.meta.resolve("oxlint/package.json"))), "bin", "oxlint");

/** How long one oxlint run may take before it is killed: it caps a hang, since a busy machine slows the run down. */
const OXLINT_TIMEOUT_MS = 60_000;

/** A tester for the plugin's rule `rule`: its cases run together, in one oxlint run, when the first of them runs. */
export function ruleTester(rule: string, { options = [], label = rule }: RuleTesterOptions = {}): RuleTester {
	const fixtures: Fixture[] = [];
	let report: ReadonlyMap<string, readonly Diagnostic[]> | undefined;
	const diagnosticsOf = (file: string): readonly Diagnostic[] => {
		report ??= lint(rule, options, fixtures);
		return report.get(file) ?? [];
	};
	const add = (code: string, path: string | undefined): string => {
		const file = fixtureName(fixtures.length, path);
		fixtures.push({ code, file });
		return file;
	};
	return {
		valid(name, code, path) {
			const file = add(code, path);
			test(`${label} accepts ${name}`, () => {
				expect(diagnosticsOf(file).map((diagnostic) => diagnostic.message)).toEqual([]);
			});
		},
		invalid(name, code, expected, path) {
			const file = add(code, path);
			test(`${label} rejects ${name}`, () => {
				const diagnostics = diagnosticsOf(file);
				expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(diagnostics.map(() => `tunnel(${rule})`));
				if (typeof expected === "number") expect(diagnostics.length).toBe(expected);
				else expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual(typeof expected === "string" ? [expected] : [...expected]);
			});
		},
	};
}

/** A case's file: `case-NNN.ts`, or `path` in the case's own directory `case-NNN/`. */
function fixtureName(index: number, path: string | undefined): string {
	const name = `case-${String(index).padStart(3, "0")}`;
	return path === undefined ? `${name}.ts` : `${name}/${path}`;
}

/** Lints each fixture with the rule alone turned on, and returns each fixture's diagnostics in source order. */
function lint(rule: string, options: readonly unknown[], fixtures: readonly Fixture[]): ReadonlyMap<string, readonly Diagnostic[]> {
	const directory = mkdtempSync(join(tmpdir(), "tunnel-oxlint-plugin-"));
	try {
		const config = { plugins: [], categories: { correctness: "off" }, jsPlugins: [PLUGIN], rules: { [`tunnel/${rule}`]: ["error", ...options] } };
		writeFileSync(join(directory, "oxlintrc.json"), JSON.stringify(config));
		for (const { code, file } of fixtures) {
			mkdirSync(dirname(join(directory, file)), { recursive: true });
			writeFileSync(join(directory, file), code);
		}
		const run = spawnSync(process.execPath, [OXLINT, "-c", "oxlintrc.json", "--disable-nested-config", "--format", "json", "."], {
			cwd: directory,
			encoding: "utf8",
			timeout: OXLINT_TIMEOUT_MS,
			killSignal: "SIGKILL",
		});
		if (run.error !== undefined) throw new Error(`oxlint did not run: ${run.error.message}`, { cause: run.error });
		if (run.status !== 0 && run.status !== 1) throw new Error(`oxlint failed (${String(run.status ?? run.signal)}): ${run.stderr}`);
		// SAFETY: oxlint's `--format json` writes this shape.
		const report = JSON.parse(run.stdout) as Report;
		// A run that linted fewer files, or ran other rules, would pass a valid case without testing it.
		if (report.number_of_files !== fixtures.length || report.number_of_rules !== 1) {
			throw new Error(`oxlint linted ${report.number_of_files} files with ${report.number_of_rules} rules, not ${fixtures.length} files with one rule`);
		}
		return diagnosticsByFile(report);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

function diagnosticsByFile(report: Report): ReadonlyMap<string, readonly Diagnostic[]> {
	const byFile = new Map<string, Diagnostic[]>();
	for (const diagnostic of report.diagnostics) {
		const diagnostics = byFile.get(diagnostic.filename) ?? [];
		diagnostics.push(diagnostic);
		byFile.set(diagnostic.filename, diagnostics);
	}
	for (const diagnostics of byFile.values()) diagnostics.sort((a, b) => offsetOf(a) - offsetOf(b));
	return byFile;
}

function offsetOf(diagnostic: Diagnostic): number {
	return diagnostic.labels[0]?.span.offset ?? 0;
}
