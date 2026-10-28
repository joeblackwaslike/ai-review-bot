import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ledgerFilePath, loadLedgerFile, saveLedgerFile } from "./file.js";
import type { Ledger } from "./types.js";

const entry = {
	id: "a",
	round: 1,
	path: "src/a.ts",
	line: 3,
	severity: "high",
	title: "t",
	status: "open" as const,
	decidedBy: null,
	reason: null,
	evidence: [],
};

describe("local ledger file", () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "ledger-"));
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("builds the path under .ai-review/ledger", () => {
		expect(ledgerFilePath("/r", "o", "p", 7)).toBe(
			"/r/.ai-review/ledger/o__p__7.json",
		);
	});

	it("round trips and creates directories", async () => {
		const path = ledgerFilePath(root, "o", "p", 1);
		const ledger: Ledger = [entry];
		await saveLedgerFile(path, ledger);
		expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
		expect(await loadLedgerFile(path)).toEqual(ledger);
	});

	it("returns an empty ledger for a missing file", async () => {
		expect(await loadLedgerFile(join(root, "nope.json"))).toEqual([]);
	});

	it("throws naming the file on malformed JSON", async () => {
		const path = join(root, "bad.json");
		await writeFile(path, "{not json");
		await expect(loadLedgerFile(path)).rejects.toThrow(path);
	});

	it("throws naming the file on a wrong shape", async () => {
		const path = join(root, "shape.json");
		await writeFile(path, JSON.stringify([{ ...entry, status: "weird" }]));
		await expect(loadLedgerFile(path)).rejects.toThrow(path);
		await writeFile(path, JSON.stringify({ not: "an array" }));
		await expect(loadLedgerFile(path)).rejects.toThrow(path);
	});
});
