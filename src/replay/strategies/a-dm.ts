import { prepareDiffInput } from "../../diff-model/prepare.js";
import { DEFAULT_DIFF_BUDGET_CHARS } from "../../diff-pack.js";
import { toPushFile } from "../../review.js";
import type { ReviewStrategy, StrategyInput } from "../strategy.js";
import { runAuditStrategy, strategyA } from "./a.js";

const SECTION_BUDGET_CHARS = 6000;
const FILE_NOTES_HEADING = "Per-file computed notes:";

/**
 * The computed notes for a replay round: the rendered summary, then each file's note under
 * a labeled block, because the replay audit message holds one diff blob with no per-file
 * framing. Empty when the model has nothing to say.
 */
export function replayDiffModelSection(input: StrategyInput): string {
	const files = input.files.map(toPushFile);
	const { rendered } = prepareDiffInput({
		scopeFiles: files,
		prFiles: files,
		prFilesComplete: true,
		title: "",
		body: null,
		budgetChars: DEFAULT_DIFF_BUDGET_CHARS,
		sectionBudgetChars: SECTION_BUDGET_CHARS,
		scopeLabel: "whole PR",
	});
	const notes = [...rendered.fileNotes].map(
		([filename, note]) => `${filename}\n${note}`,
	);
	return [
		rendered.summary,
		...(notes.length > 0 ? [FILE_NOTES_HEADING, ...notes] : []),
	]
		.filter(Boolean)
		.join("\n\n");
}

/** Strategy `a` with the diff model section in its audit message; ignores `REVIEWER_TUNING.diffModel`. */
export const strategyAdm: ReviewStrategy = {
	...strategyA,
	name: "a-dm",
	get version() {
		return strategyA.version;
	},
	run: (input) => runAuditStrategy(input, replayDiffModelSection(input)),
};
