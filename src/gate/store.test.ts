import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GitRunner } from "../sources.js";
import {
	emptyStore,
	gateStorePath,
	loadStore,
	saveStore,
	storeKey,
} from "./store.js";

const gitReturning =
	(refs: string): GitRunner =>
	(args) => {
		expect(args).toContain("for-each-ref");
		return refs;
	};

describe("storeKey", () => {
	it("uses the single branch pointing at HEAD", () => {
		const key = storeKey(gitReturning("feat/x\n"), "o", "r", "abc123");
		expect(key.endsWith(`__${encodeURIComponent("feat/x")}`)).toBe(true);
		expect(key).toMatch(/^[0-9a-f]{16}__/);
	});

	it("falls back to the merge base when two branches point at HEAD", () => {
		const key = storeKey(gitReturning("a\nb\n"), "o", "r", "abc123");
		expect(key.endsWith("__abc123")).toBe(true);
	});

	it("falls back to the merge base when no branch points at HEAD", () => {
		const key = storeKey(gitReturning(""), "o", "r", "abc123");
		expect(key.endsWith("__abc123")).toBe(true);
	});

	it("never puts a slash from a branch name in the file name", () => {
		const key = storeKey(gitReturning("feat/a/b\n"), "o", "r", "abc123");
		expect(key).not.toContain("/");
	});
});

describe("gateStorePath", () => {
	it("joins the key onto the given dir", () => {
		expect(gateStorePath("k", "/d")).toBe("/d/k.json");
	});
});

describe("loadStore", () => {
	it("returns an empty store when the file is missing", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gate-"));
		const res = await loadStore(join(dir, "missing.json"));
		expect(res.store).toEqual(emptyStore());
		expect(res.warning).toBeNull();
	});

	it("moves a corrupt file aside and warns", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gate-"));
		const path = join(dir, "s.json");
		await writeFile(path, "{not json");
		const res = await loadStore(path);
		expect(res.store).toEqual(emptyStore());
		expect(res.warning).toMatch(/reset/);
		const files = await readdir(dir);
		expect(files.some((f) => f.startsWith("s.json.corrupt-"))).toBe(true);
		expect(files).not.toContain("s.json");
	});

	it("treats invalid entries as corrupt", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gate-"));
		const path = join(dir, "s.json");
		await writeFile(
			path,
			JSON.stringify({ ...emptyStore(), entries: [{ id: 1 }] }),
		);
		const res = await loadStore(path);
		expect(res.store).toEqual(emptyStore());
		expect(res.warning).not.toBeNull();
	});
});

describe("saveStore", () => {
	it("round-trips", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gate-"));
		const path = join(dir, "nested", "s.json");
		const store = { ...emptyStore(), lastHead: "deadbeef" };
		await saveStore(path, store);
		const res = await loadStore(path);
		expect(res.store).toEqual(store);
		expect(res.warning).toBeNull();
	});

	it("two saves in one process do not collide on the temp name", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gate-"));
		const path = join(dir, "s.json");
		const a = { ...emptyStore(), lastHead: "a" };
		const b = { ...emptyStore(), lastHead: "b" };
		await Promise.all([saveStore(path, a), saveStore(path, b)]);
		const parsed = JSON.parse(await readFile(path, "utf8"));
		expect(["a", "b"]).toContain(parsed.lastHead);
		expect(await readdir(dir)).toEqual(["s.json"]);
	});
});
