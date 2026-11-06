import { createHash } from "node:crypto";
import { isSameClaim } from "../../claim-dedupe.js";
import { joinsClaim, labelledClaims } from "../metrics.js";
import type { LabelFile, ReplayFixture } from "../types.js";
import type { VerdictCache } from "./cache.js";
import { claimKey } from "./snapshot.js";
import type { JudgeFamily, JudgeRecord } from "./types.js";

export const AUDIT_PROMPT = [
	"You are auditing the diff of a pull request for real defects.",
	"Below are claims reviewers already raised. List real defects in the diff that none of those claims covers.",
	"Give a file path, a right-side line number, a short title and a body for each. List nothing you are not confident is a defect.",
].join("\n");

export const AUDIT_PROMPT_HASH = createHash("sha256")
	.update(AUDIT_PROMPT)
	.digest("hex");

export interface AuditFinding {
	path: string | null;
	line: number | null;
	title: string;
	body: string;
}

export interface AuditInput {
	diff: string;
	claims: { path: string | null; line: number | null; title: string }[];
}

export interface AuditJudge {
	family: JudgeFamily;
	model: string;
	run: (input: AuditInput) => Promise<AuditFinding[]>;
}

export interface AuditRecord extends AuditFinding {
	kind: "audit";
	auditAdded: true;
	status: "agreed" | "single-family";
	first: JudgeRecord;
	second: JudgeRecord | null;
}

export interface AuditRunRecord {
	kind: "audit-run";
	first: JudgeRecord;
	findingKeys: string[];
	unresolved: number;
}

export type AuditStored = AuditRecord | AuditRunRecord;

export interface AuditResult {
	added: AuditRecord[];
	unresolved: number;
	singleFamily: number;
	deferred: boolean;
	/** Message of a thrown cross-check; the findings are then single-family and not cached. */
	crossCheckFailed: string | null;
	calls: { anthropic: number; openai: number };
}

export interface AuditOptions {
	snapshot: string;
	fixture: ReplayFixture;
	labels: LabelFile;
	diff: string;
	/** Hash of the labels file content; the audit depends on which claims count as covered. */
	labelsHash: string;
	judge: AuditJudge;
	second: AuditJudge | null;
	cache: VerdictCache<AuditStored>;
	caps: { anthropic: number; openai: number };
}

const runKey = (labelsHash: string) => `audit-run:${labelsHash}`;
const findingKey = (labelsHash: string, f: AuditFinding) =>
	`audit:${labelsHash}:${claimKey(f)}`;
const judgeRecord = (j: AuditJudge): JudgeRecord => ({
	family: j.family,
	model: j.model,
	promptHash: AUDIT_PROMPT_HASH,
});

function summarize(
	records: AuditRecord[],
	unresolved: number,
	calls: AuditResult["calls"],
): AuditResult {
	return {
		added: records,
		unresolved,
		singleFamily: records.filter((r) => r.status === "single-family").length,
		deferred: false,
		crossCheckFailed: null,
		calls,
	};
}

export async function auditFixture(opts: AuditOptions): Promise<AuditResult> {
	const { cache, snapshot, judge, second, caps } = opts;
	const { labelsHash } = opts;
	const prior = cache.get(snapshot, runKey(labelsHash));
	if (
		prior?.kind === "audit-run" &&
		prior.first.promptHash === AUDIT_PROMPT_HASH &&
		prior.first.model === judge.model
	) {
		const records = prior.findingKeys.flatMap((k) => {
			const r = cache.get(snapshot, k);
			return r?.kind === "audit" ? [r] : [];
		});
		return summarize(records, prior.unresolved, { anthropic: 0, openai: 0 });
	}
	const calls = { anthropic: 0, openai: 0 };
	if (calls[judge.family] >= caps[judge.family]) {
		return { ...summarize([], 0, calls), deferred: true };
	}
	const claims = labelledClaims(opts.fixture, opts.labels);
	const input: AuditInput = {
		diff: opts.diff,
		claims: claims.map(({ path, line, title }) => ({ path, line, title })),
	};
	calls[judge.family]++;
	const listed = await judge.run(input);
	const uncovered = [
		...new Map(
			listed
				.filter(
					(f) =>
						!claims.some((c) =>
							joinsClaim({ ...f, skill: null, severity: null }, c),
						),
				)
				.map((f) => [findingKey(labelsHash, f), f]),
		).values(),
	];

	let confirmations: AuditFinding[] | null = null;
	let crossCheckFailed: string | null = null;
	if (
		second &&
		uncovered.length > 0 &&
		calls[second.family] < caps[second.family]
	) {
		calls[second.family]++;
		try {
			confirmations = await second.run(input);
		} catch (err) {
			crossCheckFailed = err instanceof Error ? err.message : String(err);
		}
	}

	const added: AuditRecord[] = [];
	let unresolved = 0;
	for (const f of uncovered) {
		const confirmed =
			confirmations?.some(
				(o) => claimKey(o) === claimKey(f) || isSameClaim(o, f),
			) ?? false;
		if (confirmations && !confirmed) {
			unresolved++;
			continue;
		}
		added.push({
			...f,
			kind: "audit",
			auditAdded: true,
			status: confirmations ? "agreed" : "single-family",
			first: judgeRecord(judge),
			second: confirmations && second ? judgeRecord(second) : null,
		});
	}

	if (crossCheckFailed === null) {
		for (const r of added) cache.put(snapshot, findingKey(labelsHash, r), r);
		cache.put(snapshot, runKey(labelsHash), {
			kind: "audit-run",
			first: judgeRecord(judge),
			findingKeys: added.map((r) => findingKey(labelsHash, r)),
			unresolved,
		});
	}
	return { ...summarize(added, unresolved, calls), crossCheckFailed };
}
