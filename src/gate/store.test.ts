import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LedgerEntry } from "../ledger/types.js";
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
		expect(args).toEqual([
			"for-each-ref",
			"--points-at",
			"HEAD",
			"--format=%(refname:lstrip=2)",
			"refs/heads/",
		]);
		return refs;
	};

describe("storeKey", () => {
	it("uses the single branch pointing at HEAD", () => {
		const key = storeKey(gitReturning("feat/x\n"), "o", "r", "abc123");
		expect(key).toMatch(/^[0-9a-f]{16}__feat%2fx__[0-9a-f]{10}$/);
	});

	it("falls back to the merge base when two branches point at HEAD", () => {
		const key = storeKey(gitReturning("a\nb\n"), "o", "r", "abc123");
		expect(key).toMatch(/^[0-9a-f]{16}__abc123__[0-9a-f]{10}$/);
	});

	it("falls back to the merge base when no branch points at HEAD", () => {
		const key = storeKey(gitReturning(""), "o", "r", "abc123");
		expect(key).toMatch(/__abc123__/);
	});

	const keyFor = (branch: string) =>
		storeKey(gitReturning(`${branch}\n`), "o", "r", "abc123");

	it("keeps an existing branch store when a second branch starts pointing at HEAD", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gate-key-"));
		await writeFile(gateStorePath(keyFor("feat/x"), dir), "{}");

		const key = storeKey(
			gitReturning("backup\nfeat/x\n"),
			"o",
			"r",
			"abc123",
			dir,
		);

		expect(key).toBe(keyFor("feat/x"));
	});

	it("prefers the most recently modified store when several candidates exist", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gate-key-"));
		const older = gateStorePath(
			storeKey(gitReturning(""), "o", "r", "abc123"),
			dir,
		);
		const newer = gateStorePath(keyFor("a"), dir);
		await writeFile(older, "{}");
		await writeFile(newer, "{}");
		await utimes(older, new Date(1_000_000), new Date(1_000_000));

		const key = storeKey(gitReturning("a\nb\n"), "o", "r", "abc123", dir);

		expect(gateStorePath(key, dir)).toBe(newer);
	});

	it("a single branch ignores another branch's merge-base store", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gate-key-"));
		const baseKey = storeKey(gitReturning(""), "o", "r", "abc123");
		await writeFile(gateStorePath(baseKey, dir), "{}");

		expect(storeKey(gitReturning("feat/f\n"), "o", "r", "abc123", dir)).toBe(
			keyFor("feat/f"),
		);
	});

	it("several branches with no branch store use the merge-base key", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gate-key-"));
		expect(storeKey(gitReturning("a\nb\n"), "o", "r", "abc123", dir)).toBe(
			storeKey(gitReturning(""), "o", "r", "abc123"),
		);
	});

	it("a detached HEAD keeps using its merge-base store", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gate-key-"));
		const baseKey = storeKey(gitReturning(""), "o", "r", "abc123");
		await writeFile(gateStorePath(baseKey, dir), "{}");

		expect(storeKey(gitReturning(""), "o", "r", "abc123", dir)).toBe(baseKey);
	});

	it("uses the single-branch key when no candidate store exists", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gate-key-"));
		expect(storeKey(gitReturning("feat/x\n"), "o", "r", "abc123", dir)).toBe(
			keyFor("feat/x"),
		);
	});

	it("keeps Feat and feat apart", () => {
		expect(keyFor("Feat")).not.toBe(keyFor("feat"));
	});

	it("keeps a%2Fb and a/b apart", () => {
		expect(keyFor("a%2Fb")).not.toBe(keyFor("a/b"));
	});

	it("keeps a branch named like the merge base apart from the sha fallback", () => {
		const viaSha = storeKey(gitReturning(""), "o", "r", "abc123");
		expect(keyFor("abc123")).not.toBe(viaSha);
	});

	it("keeps a 300-char branch name under 200 bytes", () => {
		const key = keyFor("x".repeat(300));
		expect(Buffer.byteLength(`${key}.json`)).toBeLessThan(200);
	});

	it("produces safe names for . and ..", () => {
		for (const b of [".", ".."]) {
			const key = keyFor(b);
			expect(key).not.toBe(b);
			expect(key).not.toContain("/");
			expect(`${key}.json`.startsWith(".")).toBe(false);
		}
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

	it.each([
		["wrong version", { version: 2 }],
		["providers not an array", { providers: "x" }],
		["a null provider", { providers: ["anthropic", null] }],
		["an unknown provider", { providers: ["anthropic", "gemini"] }],
		["numeric lastHead", { lastHead: 5 }],
		["entries not an array", { entries: {} }],
	])("treats %s as corrupt", async (_name, patch) => {
		const dir = await mkdtemp(join(tmpdir(), "gate-"));
		const path = join(dir, "s.json");
		await writeFile(path, JSON.stringify({ ...emptyStore(), ...patch }));
		const res = await loadStore(path);
		expect(res.store).toEqual(emptyStore());
		expect(res.warning).toMatch(/reset/);
	});

	it("treats a directory in place of the file as corrupt", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gate-"));
		const path = join(dir, "s.json");
		await mkdir(path);
		const res = await loadStore(path);
		expect(res.store).toEqual(emptyStore());
		expect(res.warning).toMatch(/reset/);
	});

	it("does not throw when the corrupt file cannot be moved aside", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gate-"));
		const path = join(dir, "s.json");
		await writeFile(path, "{not json");
		await chmod(dir, 0o500);
		try {
			const res = await loadStore(path);
			expect(res.store).toEqual(emptyStore());
			expect(res.warning).toMatch(/could not be moved aside/);
		} finally {
			await chmod(dir, 0o700);
		}
	});

	it("does not overwrite earlier corrupt files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gate-"));
		const path = join(dir, "s.json");
		for (let i = 0; i < 3; i++) {
			await writeFile(path, "{bad");
			await loadStore(path);
		}
		const aside = (await readdir(dir)).filter((f) => f.includes(".corrupt-"));
		expect(aside).toHaveLength(3);
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
	it("removes the temp file when the rename fails", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gate-"));
		const path = join(dir, "s.json");
		await mkdir(path);
		await expect(saveStore(path, emptyStore(), 0)).rejects.toThrow();
		expect(await readdir(dir)).toEqual(["s.json"]);
	});

	it("round-trips", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gate-"));
		const path = join(dir, "nested", "s.json");
		const store = { ...emptyStore(), lastHead: "deadbeef" };
		await saveStore(path, store, 0);
		const res = await loadStore(path);
		expect(res.store).toEqual({ ...store, revision: 1 });
		expect(res.warning).toBeNull();
	});

	it("two saves in one process do not collide on the temp name", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gate-"));
		const path = join(dir, "s.json");
		const a = { ...emptyStore(), lastHead: "a" };
		const b = { ...emptyStore(), lastHead: "b" };
		await Promise.all([saveStore(path, a, 0), saveStore(path, b, 0)]);
		const parsed = JSON.parse(await readFile(path, "utf8"));
		expect(["a", "b", null]).toContain(parsed.lastHead);
		expect(await readdir(dir)).toEqual(["s.json"]);
	});
});

describe("saveStore revision check", () => {
	const entry = (id: string, round = 1): LedgerEntry => ({
		id,
		round,
		path: "src/a.ts",
		line: 1,
		severity: "P1",
		title: `finding ${id}`,
		body: "body",
		status: "open",
		decidedBy: null,
		reason: null,
		evidence: ["head:h1", "diff:d1"],
	});

	it("a legacy store without a revision loads as revision 0", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gate-"));
		const path = join(dir, "s.json");
		const { revision: _drop, ...legacy } = emptyStore();
		await writeFile(path, JSON.stringify({ ...legacy, lastHead: "h1" }));
		const res = await loadStore(path);
		expect(res.warning).toBeNull();
		expect(res.store.revision).toBe(0);
		expect(res.store.lastHead).toBe("h1");
	});

	it("sequential saves increment the revision and do not merge", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gate-"));
		const path = join(dir, "s.json");
		const first = await loadStore(path);
		const a = await saveStore(
			path,
			{ ...first.store, lastHead: "h1", entries: [entry("a")] },
			first.store.revision,
		);
		const second = await loadStore(path);
		const b = await saveStore(
			path,
			{ ...second.store, lastHead: "h2" },
			second.store.revision,
		);
		const final = (await loadStore(path)).store;
		expect([a.merged, b.merged]).toEqual([false, false]);
		expect(final).toMatchObject({ revision: 2, lastHead: "h2" });
		expect(final.entries.map((e) => e.id)).toEqual(["a"]);
	});

	it("interleaved runs keep both runs' entries and reset the last head", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gate-"));
		const path = join(dir, "s.json");
		const runA = await loadStore(path);
		const runB = await loadStore(path);
		await saveStore(
			path,
			{
				...runA.store,
				providers: ["anthropic"],
				lastHead: "h1",
				entries: [entry("a"), entry("shared", 2)],
			},
			runA.store.revision,
		);
		const b = await saveStore(
			path,
			{
				...runB.store,
				providers: ["openai"],
				lastHead: "h1",
				entries: [entry("b"), { ...entry("shared", 2), title: "from B" }],
			},
			runB.store.revision,
		);
		const final = (await loadStore(path)).store;
		expect(b.merged).toBe(true);
		expect(final.lastHead).toBeNull();
		expect(final.revision).toBe(2);
		expect(final.providers.sort()).toEqual(["anthropic", "openai"]);
		expect(final.entries.map((e) => e.id).sort()).toEqual(["a", "b", "shared"]);
		expect(final.entries.find((e) => e.id === "shared")?.title).toBe(
			"finding shared",
		);
	});

	it("a merge keeps the entry with the higher round", async () => {
		const dir = await mkdtemp(join(tmpdir(), "gate-"));
		const path = join(dir, "s.json");
		const runA = await loadStore(path);
		const runB = await loadStore(path);
		await saveStore(
			path,
			{ ...runA.store, entries: [entry("x", 1)] },
			runA.store.revision,
		);
		await saveStore(
			path,
			{ ...runB.store, entries: [{ ...entry("x", 3), title: "newer" }] },
			runB.store.revision,
		);
		const final = (await loadStore(path)).store;
		expect(final.entries.map((e) => e.title)).toEqual(["newer"]);
	});
});
