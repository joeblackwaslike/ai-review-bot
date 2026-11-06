import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { LabelFile, ReplayFixture } from "../types.js";
import {
	AUDIT_PROMPT_HASH,
	type AuditFinding,
	type AuditJudge,
	type AuditStored,
	auditFixture,
} from "./audit.js";
import { VerdictCache } from "./cache.js";

const fixture = {
	rounds: [
		{
			claims: [
				{
					id: "c1",
					path: "a.ts",
					line: 10,
					title: "Retry delay skipped on first attempt",
					text: "retry delay skipped on first attempt",
				},
			],
		},
	],
} as unknown as ReplayFixture;
const labels = { labels: [{ claimId: "c1" }] } as unknown as LabelFile;

const covered: AuditFinding = {
	path: "a.ts",
	line: 11,
	title: "Retry delay skipped on first attempt",
	body: "b",
};
const missedA: AuditFinding = {
	path: "b.ts",
	line: 5,
	title: "Unbounded loop never terminates on empty queue",
	body: "b",
};
const missedB: AuditFinding = {
	path: "c.ts",
	line: 7,
	title: "Token written to the log in plain text",
	body: "b",
};

const judge = (
	findings: AuditFinding[] | Error,
	family: "anthropic" | "openai" = "anthropic",
) => {
	const run = vi.fn<AuditJudge["run"]>(async () => {
		if (findings instanceof Error) throw findings;
		return findings;
	});
	return { family, model: `m-${family}`, run } satisfies AuditJudge;
};

const base = () => ({
	snapshot: "snap",
	fixture,
	labels,
	diff: "diff",
	labelsHash: "L1",
	cache: new VerdictCache<AuditStored>(mkdtempSync(join(tmpdir(), "aud-"))),
});

describe("auditFixture", () => {
	it("drops a defect a labelled claim already covers", async () => {
		const result = await auditFixture({
			...base(),
			judge: judge([covered, missedA]),
			second: judge([missedA], "openai"),
			caps: { anthropic: 1, openai: 1 },
		});
		expect(result.added.map((a) => a.title)).toEqual([missedA.title]);
		expect(result.added[0]?.auditAdded).toBe(true);
	});

	it("marks a defect the second judge does not repeat as unresolved", async () => {
		const result = await auditFixture({
			...base(),
			judge: judge([missedA, missedB]),
			second: judge([missedA], "openai"),
			caps: { anthropic: 1, openai: 1 },
		});
		expect(result.added.map((a) => a.title)).toEqual([missedA.title]);
		expect(result.unresolved).toBe(1);
	});

	it("marks single-family when there is no second judge or the OpenAI cap is 0", async () => {
		const second = judge([missedA], "openai");
		const result = await auditFixture({
			...base(),
			judge: judge([missedA]),
			second,
			caps: { anthropic: 1, openai: 0 },
		});
		expect(second.run).not.toHaveBeenCalled();
		expect(result.added[0]?.status).toBe("single-family");
		expect(result.singleFamily).toBe(1);
	});

	it("makes no call on a repeat run", async () => {
		const shared = base();
		const run = (j: ReturnType<typeof judge>) =>
			auditFixture({
				...shared,
				judge: j,
				second: null,
				caps: { anthropic: 1, openai: 0 },
			});
		await run(judge([missedA]));
		const again = judge([missedA]);
		const result = await run(again);
		expect(again.run).not.toHaveBeenCalled();
		expect(result.added).toHaveLength(1);
		expect(result.calls).toEqual({ anthropic: 0, openai: 0 });
	});

	it("makes no call when the Anthropic cap is 0", async () => {
		const j = judge([missedA]);
		const result = await auditFixture({
			...base(),
			judge: j,
			second: null,
			caps: { anthropic: 0, openai: 0 },
		});
		expect(j.run).not.toHaveBeenCalled();
		expect(result.deferred).toBe(true);
	});

	it("stores audit records under a kind that is not a verdict", async () => {
		const shared = base();
		await auditFixture({
			...shared,
			judge: judge([missedA]),
			second: null,
			caps: { anthropic: 1, openai: 0 },
		});
		const kinds = [shared.cache.get("snap", "audit-run:L1")?.kind];
		expect(kinds).toEqual(["audit-run"]);
	});

	it("re-runs when the labels changed", async () => {
		const shared = base();
		const run = (j: ReturnType<typeof judge>, labelsHash: string) =>
			auditFixture({
				...shared,
				labelsHash,
				judge: j,
				second: null,
				caps: { anthropic: 1, openai: 0 },
			});
		await run(judge([missedA]), "L1");
		const again = judge([missedA]);
		await run(again, "L2");
		expect(again.run).toHaveBeenCalledTimes(1);
	});

	it("re-runs when the cached run used another model or prompt", async () => {
		const shared = base();
		const run = (j: ReturnType<typeof judge>) =>
			auditFixture({
				...shared,
				judge: j,
				second: null,
				caps: { anthropic: 1, openai: 0 },
			});
		await run(judge([missedA]));
		const other = { ...judge([missedA]), model: "newer-model" };
		await run(other);
		expect(other.run).toHaveBeenCalledTimes(1);
		const stale = shared.cache.get("snap", "audit-run:L1");
		expect(stale?.kind).toBe("audit-run");
		expect(AUDIT_PROMPT_HASH).toMatch(/^[0-9a-f]{64}$/);
	});

	it("surfaces a thrown cross-check and caches nothing", async () => {
		const shared = base();
		const result = await auditFixture({
			...shared,
			judge: judge([missedA]),
			second: judge(new Error("quota exhausted"), "openai"),
			caps: { anthropic: 1, openai: 1 },
		});
		expect(result.crossCheckFailed).toBe("quota exhausted");
		expect(result.added[0]?.status).toBe("single-family");
		expect(shared.cache.get("snap", "audit-run:L1")).toBeUndefined();
		const clean = await auditFixture({
			...shared,
			judge: judge([missedA]),
			second: null,
			caps: { anthropic: 1, openai: 0 },
		});
		expect(clean.crossCheckFailed).toBeNull();
	});

	it("keeps the same defect reported at two lines", async () => {
		const twin: AuditFinding = { ...missedA, line: 40 };
		const result = await auditFixture({
			...base(),
			judge: judge([missedA, twin]),
			second: null,
			caps: { anthropic: 1, openai: 0 },
		});
		expect(result.added.map((a) => a.line)).toEqual([5, 40]);
	});
});
