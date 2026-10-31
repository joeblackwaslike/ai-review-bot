import { createHash } from "node:crypto";
import type { Provider } from "../auth.js";
import { findOpenMatch, findSettledMatch } from "../ledger/match.js";
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
	storePath?: string;
	idleProviders?: {
		provider: Provider;
		succeeded: number;
		attempted: number;
	}[];
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

const isInferredFix = (e: LedgerEntry) =>
	e.status === "fixed" && e.decidedBy === null;

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

const actionFor = (severity: string) =>
	severity === "P3" ? "no-op" : "ask-user";

const storedDiff = (e: LedgerEntry) =>
	e.evidence.find((s) => s.startsWith("diff:"))?.slice("diff:".length);

const includesAll = (ran: readonly string[], stored: readonly string[]) =>
	stored.every((p) => ran.includes(p));

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

const unionProviders = (
	stored: readonly Provider[],
	ran: readonly Provider[],
) => [
	...stored,
	...ran.filter((p, i) => !stored.includes(p) && ran.indexOf(p) === i),
];

const providerMismatch = (input: RoundInput) =>
	input.store.providers.length > 0 &&
	!includesAll(input.providers, input.store.providers);

function inferenceWarnings(input: RoundInput, hasOpen: boolean): string[] {
	const warnings: string[] = [];
	if (!input.complete) {
		warnings.push(
			"Round incomplete: an agent failed or was skipped, so no open finding was inferred fixed.",
		);
	}
	if (providerMismatch(input)) {
		const idle = (input.idleProviders ?? [])
			.map((s) => `${s.provider} ${s.succeeded}/${s.attempted}`)
			.join(", ");
		warnings.push(
			`Providers that ran (${input.providers.join(", ") || "none"}) do not include every provider in the stored set (${input.store.providers.join(", ")}), so no open finding was inferred fixed and the last reviewed head was kept.${idle ? ` Authenticated with no successful agent: ${idle}.` : ""} After a permanent provider change, delete ${input.storePath ?? "the gate history file"} to start over.`,
		);
	} else if (hasOpen && input.store.providers.length === 0) {
		warnings.push(
			"No provider has reviewed this branch yet, so no open finding was inferred fixed.",
		);
	}
	if (input.fullRescope) {
		warnings.push(
			"Full-range rescope: the last reviewed head is not an ancestor of HEAD, so no open finding was inferred fixed.",
		);
	}
	return warnings;
}

/** One gate round: renames, open-entry matching, reopening of inferred fixes, suppression of the rest against entries a person settled before the round, id minting, then fixed inference. Pure. */
export function applyRound(input: RoundInput): RoundResult {
	const { store, head, round, hashes, reviewedPaths } = input;
	const inScope = (path: string) =>
		reviewedPaths === "all" || reviewedPaths.has(path);
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
	const settledByPerson = entries.filter(
		(e) => isSettled(e) && e.decidedBy !== null,
	);

	const claimed = new Map<string, LedgerEntry>();
	const matched: Emitted[] = [];
	const isUnclaimed = (f: Finding, suggestion: string | null) => {
		const pool = entries.filter((e) => !claimed.has(e.id));
		const match =
			findOpenMatch(f, pool) ?? findSettledMatch(f, pool.filter(isInferredFix));
		if (!match) return true;
		const refreshed: LedgerEntry = {
			...match,
			...freshFields(f, match),
			status: "open",
			decidedBy: null,
			reason: null,
		};
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

	const { review, suppressed } = suppressInReview(unclaimed, settledByPerson);
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
		(store.providers.length === 0
			? input.providers.length === 0
			: includesAll(input.providers, store.providers));
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
			(inScope(e.path) || !hashes.has(e.path)) &&
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
			providers: unionProviders(store.providers, input.providers),
			...(input.complete && !providerMismatch(input) ? { lastHead: head } : {}),
		},
		emitted,
		suppressed: suppressed.length,
		warnings,
	};
}
