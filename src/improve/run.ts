import type { KvClient } from "../feedback/kv.js";
import type { ModelSelection } from "../router.js";
import { classifyBundles } from "./classify.js";
import type { Db } from "./db/client.js";
import {
	insertClassified,
	listFindingOutcomes,
	listUnclassifiedBundles,
} from "./db/repo.js";
import { drainKvEvents } from "./drain.js";
import {
	type CycleThresholds,
	DEFAULT_THRESHOLDS,
	type IssueOctokit,
	openProposalIssue,
	planProposals,
} from "./issues.js";
import { fpSignature } from "./match.js";

export interface CycleResult {
	drained: { read: number; inserted: number; malformed: number } | null;
	classified: number;
	failedBatches: number;
	proposals: { kind: string; action: string; url?: string }[];
}

/** One full improvement cycle: drain, classify, detect, propose.
 *
 * Each stage is independent and failures are contained — a classifier outage
 * must not stop proposals being filed from what is already classified, and a
 * GitHub outage must not lose the classification work just done. The cycle is
 * idempotent throughout, so a partial run is simply resumed by the next one. */
export async function runImproveCycle(deps: {
	db: Db;
	kv?: KvClient | null;
	octokit: IssueOctokit;
	owner: string;
	repo: string;
	selection: ModelSelection;
	thresholds?: CycleThresholds;
	dryRun?: boolean;
}): Promise<CycleResult> {
	const t = deps.thresholds ?? DEFAULT_THRESHOLDS;
	const result: CycleResult = {
		drained: null,
		classified: 0,
		failedBatches: 0,
		proposals: [],
	};

	if (deps.kv) {
		try {
			result.drained = await drainKvEvents({ kv: deps.kv, db: deps.db });
		} catch (err) {
			console.error("improve cycle: drain failed", { error: String(err) });
		}
	}

	try {
		const bundles = await listUnclassifiedBundles(deps.db, t.classifyLimit);
		if (bundles.length > 0) {
			const run = await classifyBundles(bundles, deps.selection);
			result.failedBatches = run.failedBatches;
			const byId = new Map(bundles.map((b) => [b.rawFeedbackId, b]));
			for (const c of run.classified) {
				const bundle = byId.get(c.rawFeedbackId);
				if (!bundle) continue;
				result.classified += await insertClassified(deps.db, {
					rawFeedbackId: c.rawFeedbackId,
					intent: c.intent,
					confidence: c.confidence.toFixed(2),
					isBotRelated: c.isBotRelated,
					matchedFindingId: bundle.findingId,
					fpSignature: fpSignature(bundle.skills, bundle.findingTitle),
					model: c.model,
				});
			}
		}
	} catch (err) {
		console.error("improve cycle: classification failed", {
			error: String(err),
		});
	}

	try {
		const outcomes = await listFindingOutcomes(deps.db);
		for (const plan of planProposals(outcomes, t)) {
			const opened = await openProposalIssue({
				octokit: deps.octokit,
				owner: deps.owner,
				repo: deps.repo,
				plan,
				dryRun: deps.dryRun,
			});
			result.proposals.push({
				kind: plan.kind,
				action: opened.action,
				url: opened.url,
			});
		}
	} catch (err) {
		console.error("improve cycle: proposals failed", { error: String(err) });
	}

	return result;
}
