import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClassFile } from "./classify.js";
import { defaultFixturesDir } from "./command.js";
import { filterMargin, formatMargin } from "./filter-margin.js";
import type { LabelFile, PostedClaim, ReplayFixture } from "./types.js";

function claim(
	id: string,
	title: string,
	text: string,
	severity = "P2",
): PostedClaim {
	return {
		id,
		roundIndex: 0,
		reviewId: 1,
		source: "inline",
		commentId: null,
		path: null,
		line: null,
		severity,
		title,
		text,
	};
}

function fixtureOf(claims: PostedClaim[]): ReplayFixture {
	return {
		schemaVersion: 1,
		owner: "o",
		repo: "r",
		pull: 1,
		provider: "anthropic",
		author: "a",
		recordedAt: "2026-01-01T00:00:00Z",
		rounds: [{ index: 0, claims }],
		threads: [],
		reactions: [],
	} as unknown as ReplayFixture;
}

function labelsOf(labels: [string, string][]): LabelFile {
	return {
		fixtureId: "o__r__1__anthropic",
		provisional: true,
		labels: labels.map(([claimId, label]) => ({
			claimId,
			label,
			confidence: "high",
			evidence: [],
			confirmed: false,
		})),
		repeatPairs: [],
		negativePairs: [],
		allowedSuppression: [],
	} as unknown as LabelFile;
}

function classesOf(records: [string, string][]): ClassFile {
	return {
		fixtureId: "o__r__1__anthropic",
		provisional: true,
		records: records.map(([claimId, final]) => ({
			claimId,
			rules: null,
			claude: null,
			codex: null,
			final,
			reactionOnly: false,
		})),
	} as unknown as ClassFile;
}

describe("filterMargin buckets", () => {
	const retract = "Real-looking text. No actionable defect found.";
	const f = fixtureOf([
		claim("filler", "Filler", retract),
		claim("other", "Other", retract),
		claim("unadj", "Unadj", retract),
		claim("ulabel", "ULabel", retract),
		claim("fixed", "Fixed", retract),
		claim("repeat", "Repeat", retract),
		claim("kept", "Kept", "A real defect."),
		claim("p0", "P0", retract, "P0"),
	]);
	const labels = labelsOf([
		["filler", "rejected"],
		["other", "rejected"],
		["unadj", "rejected"],
		["ulabel", "unadjudicated"],
		["fixed", "fixed"],
		["repeat", "rejected"],
		["kept", "rejected"],
		["p0", "rejected"],
	]);
	const classes = classesOf([
		["filler", "filler"],
		["other", "contradicted"],
		["unadj", "unadjudicated"],
		["kept", "other"],
		["p0", "filler"],
	]);
	const m = filterMargin([f], [labels], [classes]);

	it("counts hits per bucket", () => {
		expect(m.total.filler).toEqual({ hit: 1, of: 2 });
		expect(m.total.otherRejected).toEqual({ hit: 1, of: 2 });
		expect(m.total.unadjudicatedClass).toEqual({ hit: 1, of: 1 });
		expect(m.total.unadjudicatedLabel).toEqual({ hit: 1, of: 1 });
		expect(m.total.repeats).toEqual({ hit: 1, of: 1 });
		expect(m.total.fixed).toEqual({ hit: 1, of: 1 });
	});

	it("never counts a P0 as a hit", () => {
		expect(m.total.hitIds).not.toContain("p0");
	});

	it("lists hit ids sorted", () => {
		expect(m.total.hitIds).toEqual([
			"filler",
			"fixed",
			"other",
			"repeat",
			"ulabel",
			"unadj",
		]);
	});

	it("prints the plan's margin line", () => {
		expect(formatMargin(m)).toContain(
			"self-retraction filter: removes 1 of 2 filler, 1 other-rejected, 2 unadjudicated, 1 of 1 fixed",
		);
	});
});

function loadCommitted() {
	const dir = defaultFixturesDir(import.meta.url);
	const names = readdirSync(dir)
		.filter((n) => n.endsWith("__anthropic.classes.json"))
		.sort();
	const fixtures: ReplayFixture[] = [];
	const labels: LabelFile[] = [];
	const classes: ClassFile[] = [];
	for (const n of names) {
		const base = n.replace(/\.classes\.json$/, "");
		const read = (p: string) => JSON.parse(readFileSync(join(dir, p), "utf8"));
		if (!existsSync(join(dir, `${base}.json`))) continue;
		fixtures.push(read(`${base}.json`));
		labels.push(read(`${base}.labels.json`));
		classes.push(read(n));
	}
	return { fixtures, labels, classes };
}

describe("filterMargin on the committed Claude fixtures", () => {
	const { fixtures, labels, classes } = loadCommitted();
	const m = filterMargin(fixtures, labels, classes);

	it("covers all three fixtures and the 17 fixed claims", () => {
		expect(m.perFixture).toHaveLength(3);
		expect(m.total.fixed.of).toBe(17);
		expect(m.total.filler.of).toBe(15);
	});

	it("never removes a fixed claim", () => {
		expect(m.total.fixed.hit).toBe(0);
	});

	it("pins the exact claims the filter removes", () => {
		const pinned = Object.fromEntries(
			m.perFixture.map((p) => [p.fixtureId.split("__")[1], p.hitIds]),
		);
		expect(pinned).toEqual({
			"agent-skills": [
				"r0:body:0",
				"r0:body:5",
				"r1:body:0",
				"r1:body:1",
				"r3:body:0",
				"r3:body:2",
				"r4:body:4",
			],
			"ai-listings": ["r3:c4371932215:1", "r3:c4371932219:0"],
			"stealth-browser": [
				"r0:c4370502157:0",
				"r0:c4370502157:1",
				"r0:c4370502158:1",
				"r0:c4370502170:1",
				"r0:c4370502179:0",
				"r1:c4370934163:0",
			],
		});
	});

	it("hits 13 of 15 agreed-filler claims and nothing from the other classes", () => {
		expect(m.total.filler).toEqual({ hit: 13, of: 15 });
		expect(m.total.otherRejected.hit).toBe(0);
		expect(m.total.repeats.hit).toBe(0);
	});
});
