import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

/** The repository's root. */
export const ROOT = resolve(import.meta.dir, "..");

/**
 * The TypeScript compiler, as the repository resolves it: its own install, or, where it is a submodule of another
 * repository, that one's.
 */
export const TSC = join(dirname(Bun.resolveSync("typescript/package.json", ROOT)), "bin", "tsc");
/** The packages, each after the ones it depends on. */
export const packages = ["tunnel", "relay"] as const;

/** Runs a command and answers its output; throws with its output where it fails. */
export async function run(command: string[], cwd = ROOT): Promise<string> {
	const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (code) throw new Error(`${command.join(" ")} failed:\n${stdout}${stderr}`);
	return stdout;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function strings(value: unknown): Record<string, string> {
	if (!record(value)) throw new Error("Expected a string map");
	const entries: [string, string][] = [];
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== "string") throw new Error(`Expected string for ${key}`);
		entries.push([key, item]);
	}
	return Object.fromEntries(entries);
}

/** A package's manifest: its name, version, exports and dependencies, checked. */
export async function manifest(name: string) {
	const raw: unknown = await Bun.file(join(ROOT, "packages", name, "package.json")).json();
	if (!record(raw) || typeof raw["name"] !== "string" || typeof raw["version"] !== "string" || raw["license"] !== "MIT")
		throw new Error("Invalid package manifest");
	return { raw, name: raw["name"], version: raw["version"], exports: strings(raw["exports"]), dependencies: strings(raw["dependencies"] ?? {}) };
}

/** Packs every package into `destination` as npm publishes it, and answers each package's tarball by name. */
export async function pack(destination: string): Promise<Record<string, string>> {
	await mkdir(destination, { recursive: true });
	const staging = await mkdtemp(join(tmpdir(), "octoiitunnel-pack-"));
	const result: Record<string, string> = {};
	try {
		const versions = new Map<string, string>();
		for (const name of packages) {
			const pkg = await manifest(name);
			versions.set(pkg.name, pkg.version);
		}
		if (new Set(versions.values()).size !== 1) throw new Error("Packages must share one version");
		for (const name of packages) {
			const pkg = await manifest(name);
			const folder = join(staging, name);
			await mkdir(folder);
			await cp(join(ROOT, "packages", name, "dist"), join(folder, "dist"), { recursive: true });
			for (const file of ["LICENSE", "README.md", "CHANGELOG.md"]) await cp(join(ROOT, "packages", name, file), join(folder, file));
			const exports = Object.fromEntries(
				Object.entries(pkg.exports).map(([key, entry]) => {
					const base = entry.replace("./src/", "./dist/").replace(/\.ts$/, "");
					return [key, { types: `${base}.d.ts`, import: `${base}.js` }];
				}),
			);
			const dependencies = Object.fromEntries(
				Object.entries(pkg.dependencies).map(([key, value]) => [key, value.startsWith("workspace:") ? versions.get(key) : value]),
			);
			if (Object.values(dependencies).includes(undefined)) throw new Error("Unresolved workspace dependency");
			await Bun.write(
				join(folder, "package.json"),
				JSON.stringify(
					{
						name: pkg.name,
						version: pkg.version,
						type: "module",
						license: "MIT",
						description: pkg.raw["description"],
						author: pkg.raw["author"],
						homepage: pkg.raw["homepage"],
						repository: pkg.raw["repository"],
						exports,
						dependencies,
						files: ["dist", "LICENSE", "README.md", "CHANGELOG.md"],
					},
					null,
					2,
				),
			);
			await run(["bun", "pm", "pack", "--quiet", "--destination", destination], folder);
			result[pkg.name] = join(destination, `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`);
		}
		return result;
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}
