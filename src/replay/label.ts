import { isSameClaim } from "../claim-dedupe.js";
import { fixtureId } from "./claims.js";
import type {
	ClaimLabel,
	LabelFile,
	PostedClaim,
	RepeatPair,
	ReplayFixture,
	ThreadEvidence,
} from "./types.js";

const DEFERRED =
	/follow-?up|out of scope|separate pr|later pr|will address (this )?later|tracked in/i;
const REJECTED =
	/\bintentional(ly)?\b|\bno change\b|\bby design\b|no defect|working as intended|won'?t fix|not a (bug|problem|issue)|\bkept (it |this )?as[- ]is\b|\balready done\b/i;
const FIX_REF =
	/\bfixed in\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i;
const REJECTING_REACTIONS = new Set(["-1", "confused"]);
const HUNK_SLACK = 3;

function stamp(at: string | null | undefined, text: string): string {
	return `${at || "unknown"}|${text}`;
}

function hunkEvidence(f: ReplayFixture, c: PostedClaim): string | null {
	if (!c.path || c.line === null) return null;
	// Commits between this claim's round and the next round are the candidate fixes.
	const next = f.rounds.find((r) => r.index === c.roundIndex + 1);
	for (const commit of next?.commitsSince ?? []) {
		for (const file of commit.files) {
			if (file.path !== c.path) continue;
			const line = c.line;
			if (
				file.ranges.some(
					([s, e]) => line >= s - HUNK_SLACK && line <= e + HUNK_SLACK,
				)
			) {
				return stamp(
					commit.committedAt,
					`changed ${c.path} near line ${line} in ${commit.sha}`,
				);
			}
		}
	}
	return null;
}

function labelClaim(f: ReplayFixture, c: PostedClaim): ClaimLabel {
	const make = (
		label: ClaimLabel["label"],
		confidence: ClaimLabel["confidence"],
		evidence: string[],
	): ClaimLabel => ({
		claimId: c.id,
		label,
		confidence,
		evidence,
		confirmed: false,
	});

	const thread: ThreadEvidence | undefined =
		c.commentId === null
			? undefined
			: f.threads.find((t) => t.commentId === c.commentId);
	const replies = (thread?.replies ?? []).filter((r) => r.author === f.author);
	const quote = (r: (typeof replies)[number]) => stamp(r.createdAt, r.body);

	const deferred = replies.filter((r) => DEFERRED.test(r.body));
	if (deferred.length) return make("deferred", "high", deferred.map(quote));
	const rejected = replies.filter((r) => REJECTED.test(r.body));
	if (rejected.length) return make("rejected", "high", rejected.map(quote));

	const fixes = replies.filter((r) => FIX_REF.test(r.body));
	if (fixes.length) return make("fixed", "high", fixes.map(quote));

	const hunk = hunkEvidence(f, c);
	if (hunk) return make("fixed", "low", [hunk]);

	const signals = f.reactions.filter(
		(r) =>
			r.commentId === c.commentId &&
			r.user === f.author &&
			REJECTING_REACTIONS.has(r.content),
	);
	if (signals.length) {
		return make(
			"rejected",
			"low",
			signals.map((r) =>
				stamp(r.createdAt, `reaction ${r.content} by ${r.user}`),
			),
		);
	}
	return make("unadjudicated", "low", []);
}

function proposeRepeats(f: ReplayFixture): RepeatPair[] {
	const pairs: RepeatPair[] = [];
	for (const later of f.rounds) {
		for (const earlier of f.rounds.filter((r) => r.index < later.index)) {
			for (const a of later.claims) {
				for (const b of earlier.claims) {
					const moved =
						a.path !== b.path &&
						a.title.trim().toLowerCase() === b.title.trim().toLowerCase();
					if (moved || isSameClaim(a, b)) {
						pairs.push({ later: a.id, earlier: b.id, confirmed: false });
					}
				}
			}
		}
	}
	return pairs;
}

export function labelFixture(f: ReplayFixture): LabelFile {
	return {
		fixtureId: fixtureId(f),
		provisional: true,
		labels: f.rounds.flatMap((r) => r.claims.map((c) => labelClaim(f, c))),
		repeatPairs: proposeRepeats(f),
		negativePairs: [],
		allowedSuppression: [],
	};
}

export function mergeConfirmations(
	proposed: LabelFile,
	edited: LabelFile,
): LabelFile {
	const editedLabels = new Map(edited.labels.map((l) => [l.claimId, l]));
	const labels = proposed.labels.map((l) => {
		const e = editedLabels.get(l.claimId);
		return e?.confirmed ? e : l;
	});

	const pairKey = (p: RepeatPair) => `${p.later}|${p.earlier}`;
	const editedPairs = new Map(edited.repeatPairs.map((p) => [pairKey(p), p]));
	const repeatPairs = proposed.repeatPairs.map((p) => {
		const e = editedPairs.get(pairKey(p));
		return e?.confirmed ? e : p;
	});

	const byId = new Map(labels.map((l) => [l.claimId, l]));
	const guarded = new Set([
		...edited.allowedSuppression,
		...labels.filter((l) => l.label === "fixed").map((l) => l.claimId),
	]);
	const provisional = [...guarded].some((id) => !byId.get(id)?.confirmed);

	return {
		...proposed,
		provisional,
		labels,
		repeatPairs,
		negativePairs: edited.negativePairs,
		allowedSuppression: edited.allowedSuppression,
	};
}
