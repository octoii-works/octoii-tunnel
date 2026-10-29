/**
 * Compiles each package's JavaScript and declarations into its `dist/`, each after the packages it depends on. The
 * relay's `/worker` host compiles in a pass of its own, against the Workers types instead of the DOM and Bun ones.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { packages, ROOT, run } from "./workspace.ts";

/** One compilation of a package: the types and libraries it sees, and the sources it covers. */
type Pass = { readonly types: readonly string[]; readonly lib: readonly string[]; readonly include: string; readonly exclude: readonly string[] };

const DOM = ["ES2022", "DOM", "DOM.Iterable"];

function passesOf(name: (typeof packages)[number]): readonly Pass[] {
	if (name !== "relay") return [{ types: [], lib: DOM, include: "src/**/*.ts", exclude: [] }];
	return [
		{ types: ["bun"], lib: DOM, include: "src/**/*.ts", exclude: ["src/worker/**"] },
		{ types: [join(ROOT, "packages/relay/node_modules/@cloudflare/workers-types")], lib: ["ES2022"], include: "src/worker/**/*.ts", exclude: [] },
	];
}

const cache = join(ROOT, "node_modules/.cache");
await mkdir(cache, { recursive: true });
const buildConfig = await mkdtemp(join(cache, "octoiitunnel-build-"));
try {
	for (const name of packages) {
		const directory = join(ROOT, "packages", name);
		await rm(join(directory, "dist"), { recursive: true, force: true });
		for (const [index, pass] of passesOf(name).entries()) {
			const path = join(buildConfig, `${name}-${index}.json`);
			await Bun.write(
				path,
				JSON.stringify({
					extends: join(ROOT, "tsconfig.base.json"),
					compilerOptions: {
						noEmit: false,
						declaration: true,
						rootDir: join(directory, "src"),
						outDir: join(directory, "dist"),
						types: pass.types,
						lib: pass.lib,
						paths: { "@octoii-works/tunnel/protocol": [join(ROOT, "packages/tunnel/dist/protocol/index.d.ts")] },
					},
					include: [join(directory, pass.include)],
					exclude: pass.exclude.map((pattern) => join(directory, pattern)),
				}),
			);
			await run([join(ROOT, "node_modules/.bin/tsc"), "-p", path]);
		}
		for await (const path of new Bun.Glob("**/*.d.ts").scan(join(directory, "dist"))) {
			const file = Bun.file(join(directory, "dist", path));
			await Bun.write(file, (await file.text()).replace(/((?:from|import)\s*\(?\s*)(["'])(\.{1,2}\/[^"']*)\.ts\2/g, "$1$2$3.js$2"));
		}
		console.log(`Built ${name}`);
	}
} finally {
	await rm(buildConfig, { recursive: true, force: true });
}
