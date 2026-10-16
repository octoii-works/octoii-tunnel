import { join } from "node:path";
import { pack, ROOT, run } from "./workspace.ts";

await run(["bun", "run", "build"]);
const tarballs = await pack(join(ROOT, "dist/packages"));
for (const path of Object.values(tarballs)) console.log(path);
