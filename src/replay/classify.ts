import { isRetractionCandidate } from "./retraction-rule.js";
import type {
	ClaimLabel,
	LabelFile,
	PostedClaim,
	ReplayFixture,
} from "./types.js";

export type FalsePositiveClass =
	| "filler"
	| "stale"
	| "contradicted"
	| "speculative"
	| "other";

export type FinalClass = FalsePositiveClass | "unadjudicated";

export interface ClassRecord {
	claimId: string;
	rules: FalsePositiveClass | null;
	claude: FalsePositiveClass | null;
	codex: FalsePositiveClass | null;
	final: FinalClass;
	reactionOnly: boolean;
}

export interface ClassFile {
	fixtureId: string;
	provisional: boolean;
	records: ClassRecord[];
}

export interface ClassSummary {
	counts: Record<FalsePositiveClass, number>;
	classified: number;
	unadjudicated: number;
	rejectedTotal: number;
	unadjudicatedLabels: number;
	repeats: number | null;
	agreement: { agreed: number; of: number };
	ruleAgreement: { agreed: number; of: number };
}

const CLASSES: FalsePositiveClass[] = [
	"filler",
	"stale",
	"contradicted",
	"speculative",
	"other",
];

export function isFillerText(title: string, text: string): boolean {
	return isRetractionCandidate({ title, body: text });
}

function findThread(f: ReplayFixture, c: PostedClaim) {
	return c.commentId === null
		? undefined
		: f.threads.find((t) => t.commentId === c.commentId);
}

const FIX_WORDING =
	/\b(?:fix(?:ed|es)?|addressed|resolved|reverted|patched|handled|landed)\b/g;
const NEGATION = /\b(?:not|never|no|without|still)\b|n't\b|\bun-$/;

function affirmsFix(sentence: string): boolean {
	return [...sentence.matchAll(FIX_WORDING)].some(
		(m) => !NEGATION.test(sentence.slice(0, m.index)),
	);
}

function citesEarlierCommit(f: ReplayFixture, c: PostedClaim): boolean {
	const thread = findThread(f, c);
	if (!thread) return false;
	const shas = f.rounds
		.filter((r) => r.index < c.roundIndex)
		.flatMap((r) => r.commitsSince.map((m) => m.sha.toLowerCase()));
	if (!shas.length) return false;
	return thread.replies
		.filter((r) => r.author === f.author)
		.flatMap((r) => r.body.toLowerCase().split(/(?<=[.!?;])\s+/))
		.filter(affirmsFix)
		.some((sentence) =>
			(sentence.match(/\b[0-9a-f]{7,40}\b/g) ?? []).some((tok) =>
				shas.some((sha) => sha.startsWith(tok)),
			),
		);
}

export function ruleClass(
	f: ReplayFixture,
	c: PostedClaim,
	label: ClaimLabel,
): "filler" | "stale" | null {
	if (label.label === "fixed") return null;
	if (isFillerText(c.title ?? "", c.text ?? "")) return "filler";
	if (citesEarlierCommit(f, c)) return "stale";
	return null;
}

export function firstSeenRejected(
	f: ReplayFixture,
	labels: LabelFile,
): PostedClaim[] {
	const later = new Set(labels.repeatPairs.map((p) => p.later));
	const rejected = new Set(
		labels.labels.filter((l) => l.label === "rejected").map((l) => l.claimId),
	);
	return f.rounds
		.flatMap((r) => r.claims)
		.filter((c) => rejected.has(c.id) && !later.has(c.id));
}

export function resolveFinal(
	r: Pick<ClassRecord, "claude" | "codex">,
): FinalClass {
	return r.claude !== null && r.claude === r.codex ? r.claude : "unadjudicated";
}

export function ruleAgreement(files: ClassFile[]): {
	agreed: number;
	of: number;
} {
	let agreed = 0;
	let of = 0;
	for (const rec of files.flatMap((x) => x.records)) {
		const modelsAgree =
			rec.claude !== null &&
			rec.claude === rec.codex &&
			(rec.claude === "filler" || rec.claude === "stale");
		if (rec.rules === null && !modelsAgree) continue;
		of++;
		if (
			rec.rules !== null &&
			rec.rules === rec.claude &&
			rec.rules === rec.codex
		)
			agreed++;
	}
	return { agreed, of };
}

export function summarizeClasses(
	files: ClassFile[],
	rejectedTotal: number,
	unadjudicatedLabels: number,
	repeats: number | null = null,
): ClassSummary {
	const counts = Object.fromEntries(CLASSES.map((c) => [c, 0])) as Record<
		FalsePositiveClass,
		number
	>;
	let unadjudicated = 0;
	let agreed = 0;
	let of = 0;
	for (const rec of files.flatMap((x) => x.records)) {
		if (rec.final === "unadjudicated") unadjudicated++;
		else counts[rec.final]++;
		if (rec.claude !== null && rec.codex !== null) {
			of++;
			if (rec.claude === rec.codex) agreed++;
		}
	}
	return {
		counts,
		classified: CLASSES.reduce((n, c) => n + counts[c], 0),
		unadjudicated,
		rejectedTotal,
		unadjudicatedLabels,
		repeats,
		agreement: { agreed, of },
		ruleAgreement: ruleAgreement(files),
	};
}

export function formatClassReport(s: ClassSummary): string {
	const recorded = s.classified + s.unadjudicated;
	const repeats = s.repeats ?? s.rejectedTotal - recorded;
	const firstSeen = s.repeats === null ? recorded : s.rejectedTotal - s.repeats;
	const unclassified = firstSeen - recorded;
	return [
		"false-positive classes (provisional)",
		...CLASSES.map((c) => `  ${c.padEnd(13)} ${s.counts[c]}`),
		`  classified ${s.classified} of ${firstSeen} first-seen rejected (${s.rejectedTotal} rejected labels, ${repeats} repeats excluded)`,
		...(unclassified > 0 ? [`  unclassified ${unclassified}`] : []),
		`  agreement ${s.agreement.agreed} of ${s.agreement.of}`,
		`  rules vs models: ${s.ruleAgreement.agreed} of ${s.ruleAgreement.of}`,
		`  unadjudicated ${s.unadjudicated} (+${s.unadjudicatedLabels} unadjudicated labels)`,
	].join("\n");
}
