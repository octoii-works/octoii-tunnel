import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filePairingStore, MalformedPairingStore } from "../src/bun/index.ts";

const root = mkdtempSync(join(tmpdir(), "tunnel-pairings-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the file pairing store", () => {
	it("keeps values in one file, 0600, through changes made at once, and lists them by prefix", async () => {
		const path = join(root, "pairings.json");
		const store = filePairingStore(path);
		expect(await store.get("missing")).toBeUndefined();
		await Promise.all([store.set("a:1", "one"), store.set("a:2", "two"), store.set("b:1", "three")]);
		expect((await store.names("a:")).sort()).toEqual(["a:1", "a:2"]);
		await store.delete("a:1");
		expect(await filePairingStore(path).get("a:2")).toBe("two");
		expect(await store.names("a:")).toEqual(["a:2"]);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("refuses a file that is no JSON object of strings, and overwrites nothing", async () => {
		const path = join(root, "malformed.json");
		writeFileSync(path, "[1]");
		await expect(filePairingStore(path).get("a")).rejects.toThrow(MalformedPairingStore);
		await expect(filePairingStore(path).set("a", "b")).rejects.toThrow(MalformedPairingStore);
		writeFileSync(path, "{ not json");
		await expect(filePairingStore(path).get("a")).rejects.toThrow(MalformedPairingStore);
	});
});
