import { fixtureId } from "./claims.js";
import type { ClassFile } from "./classify.js";
import { candidateFamilies } from "./retraction-rule.js";
import type { LabelFile, ReplayFixture } from "./types.js";

export interface MarginCount {
	hit: number;
	of: number;
}

export interface FixtureMargin {
	fixtureId: string;
	filler: MarginCount;
	otherRejected: MarginCount;
	unadjudicatedClass: MarginCount;
	unadjudicatedLabel: MarginCount;
	repeats: MarginCount;
	unclassified: MarginCount;
	fixed: MarginCount;
	unlabeled: MarginCount;
	hitIds: string[];
	families: Record<string, number>;
}

export interface Margin {
	perFixture: FixtureMargin[];
	total: FixtureMargin;
	singleFixtureFamilies: string[];
}

type Bucket =
	| "filler"
	| "otherRejected"
	| "unadjudicatedClass"
	| "unadjudicatedLabel"
	| "repeats"
	| "unclassified"
	| "fixed"
	| "unlabeled";

function emptyMargin(id: string): FixtureMargin {
	const zero = (): MarginCount => ({ hit: 0, of: 0 });
	return {
		fixtureId: id,
		filler: zero(),
		otherRejected: zero(),
		unadjudicatedClass: zero(),
		unadjudicatedLabel: zero(),
		repeats: zero(),
		unclassified: zero(),
		fixed: zero(),
		unlabeled: zero(),
		hitIds: [],
		families: {},
	};
}

const BUCKETS: Bucket[] = [
	"filler",
	"otherRejected",
	"unadjudicatedClass",
	"unadjudicatedLabel",
	"repeats",
	"unclassified",
	"fixed",
	"unlabeled",
];

function bucketOf(
	claimId: string,
	labels: LabelFile,
	classes: ClassFile | undefined,
): Bucket {
	const label = labels.labels.find((l) => l.claimId === claimId)?.label;
	if (label === "fixed") return "fixed";
	if (label === "unadjudicated") return "unadjudicatedLabel";
	if (label !== "rejected") return "unlabeled";
	const rec = classes?.records.find((r) => r.claimId === claimId);
	if (!rec)
		return labels.repeatPairs.some((p) => p.later === claimId)
			? "repeats"
			: "unclassified";
	if (rec.final === "filler") return "filler";
	if (rec.final === "unadjudicated") return "unadjudicatedClass";
	return "otherRejected";
}

function marginFor(
	f: ReplayFixture,
	labels: LabelFile,
	classes: ClassFile | undefined,
): FixtureMargin {
	const m = emptyMargin(fixtureId(f));
	for (const c of f.rounds.flatMap((r) => r.claims)) {
		const bucket = bucketOf(c.id, labels, classes);
		m[bucket].of++;
		const families = candidateFamilies({
			title: c.title ?? "",
			body: c.text ?? "",
			severity: c.severity,
		});
		if (families.length === 0) continue;
		m[bucket].hit++;
		m.hitIds.push(c.id);
		for (const name of families) m.families[name] = (m.families[name] ?? 0) + 1;
	}
	m.hitIds.sort();
	return m;
}

export function filterMargin(
	fixtures: ReplayFixture[],
	labelFiles: LabelFile[],
	classFiles: ClassFile[],
): Margin {
	const perFixture = fixtures.map((f) => {
		const id = fixtureId(f);
		const labels = labelFiles.find((l) => l.fixtureId === id);
		if (!labels) throw new Error(`no labels for ${id}`);
		return marginFor(
			f,
			labels,
			classFiles.find((c) => c.fixtureId === id),
		);
	});
	const total = emptyMargin("total");
	const familyFixtures = new Map<string, number>();
	for (const p of perFixture) {
		for (const b of BUCKETS) {
			total[b].hit += p[b].hit;
			total[b].of += p[b].of;
		}
		total.hitIds.push(...p.hitIds);
		for (const [name, n] of Object.entries(p.families)) {
			total.families[name] = (total.families[name] ?? 0) + n;
			familyFixtures.set(name, (familyFixtures.get(name) ?? 0) + 1);
		}
	}
	total.hitIds.sort();
	return {
		perFixture,
		total,
		singleFixtureFamilies: [...familyFixtures]
			.filter(([, n]) => n === 1)
			.map(([name]) => name)
			.sort(),
	};
}

function line(label: string, m: FixtureMargin): string {
	const unadj = m.unadjudicatedClass.hit + m.unadjudicatedLabel.hit;
	return `${label} would remove ${m.filler.hit} of ${m.filler.of} filler, ${m.otherRejected.hit} other-rejected, ${unadj} unadjudicated, ${m.fixed.hit} of ${m.fixed.of} fixed`;
}

export function formatMargin(m: Margin): string {
	const t = m.total;
	return [
		line("candidate retraction rule", t),
		"  measurement only, not applied in production",
		`  also would remove ${t.repeats.hit} of ${t.repeats.of} repeat-rejected, ${t.unclassified.hit} of ${t.unclassified.of} unclassified, ${t.unlabeled.hit} of ${t.unlabeled.of} unlabeled`,
		`  unadjudicated split: ${t.unadjudicatedClass.hit} of ${t.unadjudicatedClass.of} in class, ${t.unadjudicatedLabel.hit} of ${t.unadjudicatedLabel.of} by label`,
		...m.perFixture.map(
			(p) =>
				`  ${p.fixtureId}: ${p.filler.hit} of ${p.filler.of} filler, ${p.otherRejected.hit} other-rejected, ${p.unadjudicatedClass.hit + p.unadjudicatedLabel.hit} unadjudicated, ${p.fixed.hit} of ${p.fixed.of} fixed`,
		),
		`  families: ${
			Object.entries(t.families)
				.map(([n, k]) => `${n}=${k}`)
				.join(", ") || "none"
		}`,
		`  families hitting only one fixture: ${m.singleFixtureFamilies.join(", ") || "none"}`,
		`  recall is resubstitution: phrases were designed after reading all ${t.filler.of} filler claims`,
	].join("\n");
}
