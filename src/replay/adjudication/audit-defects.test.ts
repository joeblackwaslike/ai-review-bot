import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AuditRecord, AuditRunRecord, AuditStored } from "./audit.js";
import { auditDefectsFor, labelsHashOf } from "./audit-defects.js";
import { VerdictCache } from "./cache.js";

const judge = { family: "anthropic", model: "m" } as never;
const rec = (over: Partial<AuditRecord>): AuditRecord => ({
	kind: "audit",
	auditAdded: true,
	status: "agreed",
	first: judge,
	second: null,
	path: "a.ts",
	line: 3,
	title: "t",
	body: "b",
	...over,
});
const fresh = () =>
	new VerdictCache<AuditStored>(mkdtempSync(join(tmpdir(), "defects-")));

describe("auditDefectsFor", () => {
	it("returns agreed and single-family audit records for the labels hash", () => {
		const cache = fresh();
		cache.put("s", "audit:h:a.ts:3:x", rec({ title: "one" }));
		cache.put(
			"s",
			"audit:h:b.ts:4:y",
			rec({ path: "b.ts", line: 4, title: "two", status: "single-family" }),
		);
		expect(auditDefectsFor(cache, "s", "h")).toEqual([
			{ path: "a.ts", line: 3, title: "one" },
			{ path: "b.ts", line: 4, title: "two" },
		]);
	});

	it("ignores audit-run records and other labels hashes", () => {
		const cache = fresh();
		const run: AuditRunRecord = {
			kind: "audit-run",
			first: judge,
			findingKeys: [],
			unresolved: 0,
		};
		cache.put("s", "audit-run:h", run);
		cache.put("s", "audit:other:a.ts:3:x", rec({}));
		expect(auditDefectsFor(cache, "s", "h")).toEqual([]);
	});

	it("skips records without a path or line", () => {
		const cache = fresh();
		cache.put("s", "audit:h:null:3:x", rec({ path: null }));
		cache.put("s", "audit:h:a.ts:null:y", rec({ line: null }));
		expect(auditDefectsFor(cache, "s", "h")).toEqual([]);
	});

	it("hashes labels text to 16 hex chars", () => {
		expect(labelsHashOf("x")).toMatch(/^[0-9a-f]{16}$/);
	});
});
