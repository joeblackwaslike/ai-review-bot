import type { ReplayResult } from "./replay.js";
import type { LabelFile, ReplayFixture } from "./types.js";

export interface GuardReport {
	failures: string[];
	warnings: string[];
	unexpectedSuppression: string[];
}

export function checkRecall(
	_f: ReplayFixture,
	labels: LabelFile,
	result: ReplayResult,
): GuardReport {
	const report: GuardReport = {
		failures: [],
		warnings: [],
		unexpectedSuppression: [],
	};
	const suppressed = new Set(result.rounds.flatMap((r) => r.suppressed));
	const labelOf = new Map(labels.labels.map((l) => [l.claimId, l]));
	const allowed = new Set(labels.allowedSuppression);
	const isConfirmedRepeat = (id: string) =>
		labels.repeatPairs.some((p) => p.later === id && p.confirmed);

	for (const id of suppressed) {
		const label = labelOf.get(id);
		if (label?.confirmed && label.label === "fixed" && !isConfirmedRepeat(id)) {
			report.failures.push(
				`confirmed fixed first-round claim ${id} was suppressed`,
			);
		}
		if (allowed.has(id)) {
			if (!isConfirmedRepeat(id)) {
				report.failures.push(`${id} is allowed but not a repeat`);
			}
			continue;
		}
		report.unexpectedSuppression.push(id);
		if (label?.label === "fixed" && label.confirmed && !isConfirmedRepeat(id)) {
			continue;
		}
		const message = `unexpected suppression of ${id}`;
		if (label?.confirmed) report.failures.push(message);
		else report.warnings.push(message);
	}

	for (const pair of labels.negativePairs) {
		for (const id of [pair.a, pair.b]) {
			if (suppressed.has(id)) {
				report.failures.push(
					`negative pair (${pair.a}, ${pair.b}) lost ${id}: similar claims describing different defects must both survive`,
				);
			}
		}
	}
	return report;
}
