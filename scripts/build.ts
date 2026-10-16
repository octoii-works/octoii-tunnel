import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { packages, ROOT, run } from "./workspace.ts";

const cache = join(ROOT, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const buildConfig = await mkdtemp(join(cache, "takotunnel-build-"));
try {
	for (const name of packages) {
		const directory = join(ROOT, "packages", name);
		await rm(join(directory, "dist"), { recursive: true, force: true });
		const path = join(buildConfig, `${name}.json`);
		await Bun.write(
			path,
			JSON.stringify({
				extends: join(ROOT, "tsconfig.base.json"),
				compilerOptions: {
					noEmit: false,
					declaration: true,
					rootDir: join(directory, "src"),
					outDir: join(directory, "dist"),
					types: name === "relay" ? ["bun"] : [],
					lib: ["ES2022", "DOM", "DOM.Iterable"],
					paths: {
						"@klein-works/takotunnel-protocol": [join(ROOT, "packages/protocol/dist/index.d.ts")],
						"@klein-works/takotunnel": [join(ROOT, "packages/client/dist/index.d.ts")],
						"@klein-works/takotunnel/protocol": [join(ROOT, "packages/client/dist/protocol/index.d.ts")],
					},
				},
				include: [join(directory, "src/**/*.ts")],
			}),
		);
		await run([join(ROOT, "node_modules/.bin/tsc"), "-p", path]);
		for await (const path of new Bun.Glob("**/*.d.ts").scan(join(directory, "dist"))) {
			const file = Bun.file(join(directory, "dist", path));
			await Bun.write(file, (await file.text()).replace(/((?:from|import)\s*\(?\s*)(["'])(\.{1,2}\/[^"']*)\.ts\2/g, "$1$2$3.js$2"));
		}
		console.log(`Built ${name}`);
	}
} finally {
	await rm(buildConfig, { recursive: true, force: true });
}
