import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SeedGate } from "../seeds/score.js";
import { readSeedGates, writeSeedGate } from "./seed-gates.js";

const gate = (pass: boolean): SeedGate => ({
	pass,
	originalsMissed: pass ? 0 : 2,
	cleanFindings: 0,
	reasons: pass ? [] : ["missed two"],
});

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "seed-gates-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("writeSeedGate", () => {
	it("keeps other strategies' gates", () => {
		writeSeedGate(root, "h1", "a", gate(true));
		writeSeedGate(root, "h1", "a0", gate(false));
		expect(readSeedGates(root, "h1")).toEqual({
			a: gate(true),
			a0: gate(false),
		});
	});

	it("creates the plan-hash directory", () => {
		writeSeedGate(join(root, "nested"), "h2", "a", gate(true));
		expect(readSeedGates(join(root, "nested"), "h2").a).toEqual(gate(true));
	});

	it("replaces an earlier gate for the same strategy", () => {
		writeSeedGate(root, "h3", "a", gate(false));
		writeSeedGate(root, "h3", "a", gate(true));
		expect(readSeedGates(root, "h3")).toEqual({ a: gate(true) });
	});
});
