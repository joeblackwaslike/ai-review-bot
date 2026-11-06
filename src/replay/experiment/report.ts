import type { ExperimentScore } from "./score.js";

const num = (v: number | null, digits = 3): string =>
	v === null || Number.isNaN(v) ? "n/a" : v.toFixed(digits);

export function formatScoreReport(
	score: ExperimentScore,
	meta: { planHash: string },
): string {
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
			`  ${s.strategy} [${s.provider}] PRs=${s.nPrs} precision ${num(s.precision)} recall ${num(s.recall)} | real ${s.real}, not-real ${s.notReal}, moved ${s.moved} | unresolved ${s.unresolved}, unadjudicated ${s.unadjudicated}, single-family ${s.singleFamily}, provisional labels ${s.provisional} | median cost $${num(s.medianCostUsd, 2)}, inside 210s ${num(s.fitShare * 100, 0)}%`,
		);

	lines.push("", `paired against ${score.baseline} (PR-level bootstrap):`);
	for (const c of score.comparisons) {
		const p = c.comparison.precision;
		lines.push(
			`  ${c.candidate} vs ${score.baseline} [${c.provider}] n=${c.comparison.nPrs} precision diff ${num(p.mean)} [${num(p.lo)}, ${num(p.hi)}], recall diff ${num(c.comparison.recallDiffPoints, 1)} pts, median cost $${num(c.comparison.medianCostCandidate, 2)} vs $${num(c.comparison.medianCostBaseline, 2)}; excluded ${c.comparison.excludedIncomplete} PR(s) for incomplete coverage, ${c.comparison.excludedNullPrecision} for no judged finding`,
		);
	}

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
