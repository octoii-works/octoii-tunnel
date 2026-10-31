#!/usr/bin/env bun
/**
 * Sets one version on every package, which are released together. Every release is a `patch`, breaking or not; a
 * complete rewrite takes a version of its own, given as the version itself, as does a preview (`0.0.2-preview.0`).
 *
 *   bun scripts/version.ts patch|x.y.z|x.y.z-preview.n
 */
import { join } from "node:path";
import { packages, ROOT } from "./workspace.ts";

/** The release after `version`: its patch, one higher. */
function nextPatch(version: string): string {
	if (version.includes("-")) throw new Error(`${version} is a preview: give the next version itself`);
	const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
	return `${major}.${minor}.${patch + 1}`;
}

/** The version every package has now, which they share. */
async function currentVersion(): Promise<string> {
	const versions = new Set<string>();
	for (const name of packages) versions.add((await Bun.file(join(ROOT, "packages", name, "package.json")).json()).version);
	const [version] = versions;
	if (versions.size !== 1 || version === undefined) throw new Error(`The packages are not at one version: ${[...versions].join(", ")}`);
	return version;
}

const target = process.argv[2] ?? "";
if (target !== "patch" && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(target)) {
	console.error("Usage: bun scripts/version.ts patch|x.y.z|x.y.z-preview.n");
	process.exit(1);
}
const version = target === "patch" ? nextPatch(await currentVersion()) : target;
for (const name of packages) {
	const path = join(ROOT, "packages", name, "package.json");
	const text = await Bun.file(path).text();
	await Bun.write(path, text.replace(/"version": "[^"]+"/, `"version": "${version}"`));
}
console.log(version);
