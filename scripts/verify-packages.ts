import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pack, ROOT, run } from "./workspace.ts";

await run(["bun", "run", "build"]);
const consumer = await mkdtemp(join(tmpdir(), "takotunnel-consumer-"));
try {
	const tarballs = await pack(consumer);
	for (const path of Object.values(tarballs)) {
		const files = (await run(["tar", "-tzf", path])).trim().split("\n");
		if (files.some((file) => !/^package\/(dist\/.*\.(js|d\.ts)$|package\.json$|LICENSE$|README\.md$|CHANGELOG\.md$)/.test(file)))
			throw new Error("Unexpected file in package");
		if (!files.includes("package/LICENSE")) throw new Error("License missing");
	}
	const dependencies = Object.fromEntries(Object.entries(tarballs).map(([name, path]) => [name, `file:${path}`]));
	await Bun.write(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module", dependencies, overrides: dependencies }));
	await run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund"], consumer);
	const portable = ["@klein-works/takotunnel-protocol", "@klein-works/takotunnel", "@klein-works/takotunnel-relay"];
	const script = portable.map((name) => `await import(${JSON.stringify(name)});`).join("\n");
	await Bun.write(join(consumer, "portable.mjs"), script);
	await run(["node", "portable.mjs"], consumer);
	await run(["bun", "portable.mjs"], consumer);
	await Bun.write(join(consumer, "bun.mjs"), 'await import("@klein-works/takotunnel-relay/bun");');
	await run(["bun", "bun.mjs"], consumer);
	for (const target of ["portable", "bun"]) {
		if (target === "bun") await run(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", "@types/bun@1.4.3"], consumer);
		const entries = target === "portable" ? portable : ["@klein-works/takotunnel-relay/bun"];
		await Bun.write(join(consumer, "types.ts"), entries.map((name, i) => `import * as entry${i} from ${JSON.stringify(name)}; void entry${i};`).join("\n"));
		await Bun.write(
			join(consumer, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					module: "NodeNext",
					moduleResolution: "NodeNext",
					target: "ES2022",
					strict: true,
					noEmit: true,
					skipLibCheck: false,
					lib: ["ES2022", "DOM", "DOM.Iterable"],
					types: target === "bun" ? ["bun"] : [],
				},
				files: ["types.ts"],
			}),
		);
		await run([join(ROOT, "node_modules/.bin/tsc"), "-p", "tsconfig.json"], consumer);
	}
	console.log("Package contents, licenses, isolated imports and declarations verified");
} finally {
	await rm(consumer, { recursive: true, force: true });
}
