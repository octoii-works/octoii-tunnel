#!/usr/bin/env bun
/** Sets one version on every package, which are released together: `bun scripts/version.ts 0.1.0-preview.1`. */
import { join } from "node:path";
import { packages, ROOT } from "./workspace.ts";

const version = process.argv[2] ?? "";
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
	console.error("Usage: bun scripts/version.ts x.y.z|x.y.z-preview.n");
	process.exit(1);
}
for (const name of packages) {
	const path = join(ROOT, "packages", name, "package.json");
	const text = await Bun.file(path).text();
	await Bun.write(path, text.replace(/"version": "[^"]+"/, `"version": "${version}"`));
}
console.log(version);
