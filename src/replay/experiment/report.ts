import type { ChainedScore } from "./chain-score.js";
import type { ExperimentScore } from "./score.js";

const num = (v: number | null, digits = 3): string =>
	v === null || Number.isNaN(v) ? "n/a" : v.toFixed(digits);

function formatChained(
	score: ExperimentScore,
	chained: ChainedScore,
	planHash: string,
): string {
	const lines = [
		`experiment ${planHash} (${score.final ? "FINAL, test split" : "tuning and validation splits"})`,
		"chained: recycling and convergence only",
	];
	if (score.directional)
		lines.push(
			"DIRECTIONAL: below 30 PRs, 10 per split or 5 repositories; no go or no-go claim is made",
		);
	if (score.partial) lines.push("PARTIAL: some planned cells have no result");
	if (score.staleExcluded > 0)
		lines.push(`${score.staleExcluded} stale cell(s) excluded`);
	if (score.exploratory) lines.push(score.exploratory);
	lines.push("", "per strategy and provider (macro mean over PRs):");
	for (const s of chained.summaries)
		lines.push(
			`  ${s.strategy} [${s.provider}] PRs=${s.nPrs} recycling ${num(s.recycling)} | convergence round ${num(s.convergenceRound, 2)} | recall ${num(s.recall)} | incomplete chains ${num(s.incompleteRate * 100, 0)}%`,
		);
	lines.push("", `paired against ${score.baseline} (PR-level bootstrap):`);
	for (const c of chained.comparisons) {
		lines.push(
			`  ${c.candidate} vs ${score.baseline} [${c.provider}] n=${c.nPrs} recycling diff ${num(c.recycling.mean)} [${num(c.recycling.lo)}, ${num(c.recycling.hi)}], convergence diff ${num(c.convergence.mean, 2)} [${num(c.convergence.lo, 2)}, ${num(c.convergence.hi, 2)}]; excluded ${c.excludedIncomplete} PR(s) for incomplete chains`,
		);
	}
	lines.push("", "no verdict in chained mode");
	return lines.join("\n");
}

export function formatScoreReport(
	score: ExperimentScore,
	meta: { planHash: string; hostedFitSeconds: number },
): string {
	if (score.chained) return formatChained(score, score.chained, meta.planHash);
	const lines: string[] = [
		`experiment ${meta.planHash} (${score.final ? "FINAL, test split" : "tuning and validation splits"})`,
		"per-round mode only: recycling and convergence need chained mode (phase 6) and are not measured here",
	];
	if (score.directional)
		lines.push(
			"DIRECTIONAL: below 30 PRs, 10 per split or 5 repositories; no go or no-go claim is made",
		);
	if (score.partial) lines.push("PARTIAL: some planned cells have no result");
	if (score.staleExcluded > 0)
		lines.push(
			`${score.staleExcluded} stale cell(s) excluded (strategy version changed since the run)`,
		);
	if (score.exploratory) lines.push(score.exploratory);

	lines.push("", "per strategy and provider (macro mean over PRs):");
	for (const s of score.summaries)
		lines.push(
			`  ${s.strategy} [${s.provider}] PRs=${s.nPrs} precision ${num(s.precision)} recall ${num(s.recall)} | real ${s.real}, not-real ${s.notReal}, moved ${s.moved} | unresolved ${s.unresolved}, unadjudicated ${s.unadjudicated}, single-family ${s.singleFamily}, provisional labels ${s.provisional} | join rate ${s.joinRate.joined}/${s.joinRate.candidates} (matcher ${s.joinRate.matcher}) | median cost $${num(s.medianCostUsd, 2)}, inside ${meta.hostedFitSeconds}s ${num(s.fitShare * 100, 0)}%, median latency ${num(s.medianWallMs / 1000, 1)}s`,
		);

	lines.push("", `paired against ${score.baseline} (PR-level bootstrap):`);
	for (const c of score.comparisons) {
		const p = c.comparison.precision;
		lines.push(
			`  ${c.candidate} vs ${score.baseline} [${c.provider}] n=${c.comparison.nPrs} precision diff ${num(p.mean)} [${num(p.lo)}, ${num(p.hi)}], recall diff ${num(c.comparison.recallDiffPoints, 1)} pts, median cost $${num(c.comparison.medianCostCandidate, 2)} vs $${num(c.comparison.medianCostBaseline, 2)}; excluded ${c.comparison.excludedIncomplete} PR(s) for incomplete coverage, ${c.comparison.excludedNullPrecision} for no judged finding; ${c.comparison.intersectionCells} shared cell(s)`,
		);
	}

	for (const c of score.comparisons)
		if (c.comparison.emptyIntersectionPrs.length > 0)
			lines.push(
				`  ${c.candidate} vs ${score.baseline} [${c.provider}] no shared cell: ${c.comparison.emptyIntersectionPrs.join(", ")}`,
			);

	lines.push("");
	if (!score.final) lines.push("no verdict outside --final");
	else if (score.directional)
		lines.push("verdict: directional only, no go or no-go claim");
	else
		for (const v of score.verdicts) {
			lines.push(`verdict ${v.candidate}: ${v.verdict.label}`);
			for (const r of v.verdict.reasons) lines.push(`    ${r}`);
		}
	return lines.join("\n");
}
