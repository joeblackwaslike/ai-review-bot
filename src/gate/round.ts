import { createHash } from "node:crypto";
import type { Provider } from "../auth.js";
import { findOpenMatch } from "../ledger/match.js";
import { suppressInReview } from "../ledger/suppress.js";
import { isSettled, type LedgerEntry } from "../ledger/types.js";
import type { ModelReview } from "../review.js";
import type { GateStore } from "./store.js";

export type RoundInput = {
	merged: ModelReview;
	store: GateStore;
	head: string;
	round: number;
	hashes: ReadonlyMap<string, string>;
	renames: ReadonlyMap<string, string>;
	reviewedPaths: ReadonlySet<string> | "all";
	complete: boolean;
	providers: Provider[];
	fullRescope: boolean;
};

export type Emitted = { entry: LedgerEntry; suggestion: string | null };

export type RoundResult = {
	store: GateStore;
	emitted: Emitted[];
	suppressed: number;
	warnings: string[];
};

type Finding = {
	title: string;
	body: string;
	severity: string;
	path?: string;
	line?: number;
};

const FIXED_NOTE = "inferred: absent after diff changed";

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

const actionFor = (severity: string) =>
	severity === "P3" ? "no-op" : "ask-user";

const storedDiff = (e: LedgerEntry) =>
	e.evidence.find((s) => s.startsWith("diff:"))?.slice("diff:".length);

function sameSet(a: readonly string[], b: readonly string[]): boolean {
	const setA = new Set(a);
	const setB = new Set(b);
	return setA.size === setB.size && [...setA].every((p) => setB.has(p));
}

function withRenames(
	entries: readonly LedgerEntry[],
	renames: ReadonlyMap<string, string>,
): LedgerEntry[] {
	return entries.map((e) => {
		const to = e.path === null ? undefined : renames.get(e.path);
		return to === undefined ? e : { ...e, path: to };
	});
}

/** Assigns `ai-review-<sha1>` ids, suffixing `-2`, `-3` within a hash input in body-hash order, skipping ids already in the store. */
function mintIds(
	drafts: readonly LedgerEntry[],
	head: string,
	taken: Set<string>,
): LedgerEntry[] {
	const base = (e: LedgerEntry) =>
		`ai-review-${sha1(`${e.path ?? "-"}|${e.title}|${head}`).slice(0, 12)}`;
	const order = drafts
		.map((e, i) => ({
			i,
			base: base(e),
			key: sha1(e.body ?? ""),
			line: e.line ?? 0,
		}))
		.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.line - b.line));
	const ids: string[] = [];
	for (const { i, base: root } of order) {
		let n = 1;
		let id = root;
		while (taken.has(id)) {
			n += 1;
			id = `${root}-${n}`;
		}
		taken.add(id);
		ids[i] = id;
	}
	return drafts.map((e, i) => ({ ...e, id: ids[i] }));
}

function inferenceWarnings(input: RoundInput, hasOpen: boolean): string[] {
	const warnings: string[] = [];
	if (!input.complete) {
		warnings.push(
			"Round incomplete: an agent failed or was skipped, so no open finding was inferred fixed.",
		);
	}
	if (hasOpen && !sameSet(input.providers, input.store.providers)) {
		warnings.push(
			`Provider set changed (${input.store.providers.join(", ") || "none"} -> ${input.providers.join(", ")}), so no open finding was inferred fixed.`,
		);
	}
	if (input.fullRescope) {
		warnings.push(
			"Full-range rescope: the last reviewed head is not an ancestor of HEAD, so no open finding was inferred fixed.",
		);
	}
	return warnings;
}

/** One gate round: renames, open-entry matching, suppression of the unmatched rest against entries settled before the round, id minting, then fixed inference. Pure. */
export function applyRound(input: RoundInput): RoundResult {
	const { store, head, round, hashes, reviewedPaths } = input;
	const inScope = (path: string | null) =>
		path === null || reviewedPaths === "all" || reviewedPaths.has(path);
	const diffOf = (path: string | null) =>
		path === null ? "none" : (hashes.get(path) ?? "none");
	const freshFields = (f: Finding, prior?: LedgerEntry) => {
		const path = f.path ?? prior?.path ?? null;
		const line = f.path ? (f.line ?? null) : (prior?.line ?? null);
		return {
			round,
			path,
			line,
			severity: f.severity,
			title: f.title,
			body: f.body,
			action: actionFor(f.severity),
			evidence: [`head:${head}`, `diff:${diffOf(path)}`],
		};
	};

	const entries = withRenames(store.entries, input.renames);
	const settledBefore = entries.filter(isSettled);

	const claimed = new Map<string, LedgerEntry>();
	const matched: Emitted[] = [];
	const isUnclaimed = (f: Finding, suggestion: string | null) => {
		const match = findOpenMatch(
			f,
			entries.filter(
				(e) => !isSettled(e) && inScope(e.path) && !claimed.has(e.id),
			),
		);
		if (!match) return true;
		const refreshed = { ...match, ...freshFields(f, match) };
		claimed.set(match.id, refreshed);
		matched.push({ entry: refreshed, suggestion });
		return false;
	};
	const unclaimed = {
		...input.merged,
		inline_comments: input.merged.inline_comments.filter((c) =>
			isUnclaimed(c, c.suggestion),
		),
		general_findings: input.merged.general_findings.filter((g) =>
			isUnclaimed(g, null),
		),
	};

	const { review, suppressed } = suppressInReview(unclaimed, settledBefore);
	const fresh: { finding: Finding; suggestion: string | null }[] = [
		...review.inline_comments.map((c) => ({
			finding: c,
			suggestion: c.suggestion,
		})),
		...review.general_findings.map((g) => ({ finding: g, suggestion: null })),
	];
	const minted = mintIds(
		fresh.map(({ finding }) => ({
			id: "",
			...freshFields(finding),
			status: "open",
			decidedBy: null,
			reason: null,
		})),
		head,
		new Set(entries.map((e) => e.id)),
	);

	const warnings = inferenceWarnings(
		input,
		entries.some((e) => !isSettled(e)),
	);
	const canInfer =
		input.complete &&
		!input.fullRescope &&
		sameSet(input.providers, store.providers);
	const diffChanged = (path: string, e: LedgerEntry) => {
		const current = hashes.get(path);
		return current === undefined || storedDiff(e) !== current;
	};

	const next = entries.map((e): LedgerEntry => {
		const refreshed = claimed.get(e.id);
		if (refreshed) return refreshed;
		if (
			canInfer &&
			!isSettled(e) &&
			e.path !== null &&
			inScope(e.path) &&
			diffChanged(e.path, e)
		) {
			return {
				...e,
				round,
				status: "fixed",
				decidedBy: null,
				evidence: [...e.evidence, FIXED_NOTE],
			};
		}
		return e;
	});

	const emitted = [
		...matched,
		...minted.map((entry, i) => ({ entry, suggestion: fresh[i].suggestion })),
	];

	return {
		store: {
			...store,
			entries: [...next, ...minted],
			...(input.complete
				? { providers: [...input.providers], lastHead: head }
				: {}),
		},
		emitted,
		suppressed: suppressed.length,
		warnings,
	};
}
