import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareDiffInput } from "../../diff-model/prepare.js";
import { untrusted } from "../../diff-model/render.js";
import {
	DEFAULT_DIFF_BUDGET_CHARS,
	DEFAULT_DIFF_MODEL_BUDGET_CHARS,
} from "../../diff-pack.js";
import { toPushFile } from "../../review.js";
import type { ReviewStrategy, StrategyInput } from "../strategy.js";
import { runAuditStrategy, strategyA } from "./a.js";

const FILE_NOTES_HEADING = "Per-file computed notes:";

const srcDir = fileURLToPath(new URL("../..", import.meta.url));
const SOURCE_FILE = /\.(ts|js)$/;
const NOT_HASHED = /\.(test|d)\.(ts|js)$/;
const SHARED_SOURCES = ["prompt", "diff-pack", "moved-blocks", "push-shape"];

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
		title: input.title ?? "",
		body: input.body ?? null,
		budgetChars: DEFAULT_DIFF_BUDGET_CHARS,
		sectionBudgetChars: DEFAULT_DIFF_MODEL_BUDGET_CHARS,
		scopeLabel: "whole PR",
	});
	const notes = [...rendered.fileNotes].map(
		([filename, note]) => `${untrusted(filename)}\n${note}`,
	);
	return [
		rendered.summary,
		...(notes.length > 0 ? [FILE_NOTES_HEADING, ...notes] : []),
	]
		.filter(Boolean)
		.join("\n\n");
}

let cachedVersion: string | undefined;

/**
 * The source files whose content decides what a-dm sends: every diff model module, plus
 * the prompt and diff packing modules that place its output. Compiled `.js` is used when
 * no `.ts` is on disk.
 */
export function diffModelSourceFiles(): string[] {
	const dir = join(srcDir, "diff-model");
	const own = readdirSync(dir)
		.filter((name) => SOURCE_FILE.test(name) && !NOT_HASHED.test(name))
		.sort()
		.map((name) => join(dir, name));
	const shared = SHARED_SOURCES.flatMap((base) =>
		[".ts", ".js"]
			.map((ext) => join(srcDir, `${base}${ext}`))
			.filter(existsSync)
			.slice(0, 1),
	);
	return [...own, ...shared];
}

function diffModelVersion(): string {
	const sources = diffModelSourceFiles().map((file) => [
		relative(srcDir, file),
		readFileSync(file, "utf8"),
	]);
	return createHash("sha256")
		.update(JSON.stringify([strategyA.version, sources]))
		.digest("hex")
		.slice(0, 12);
}

/** Strategy `a` with the diff model section in its audit message; ignores `REVIEWER_TUNING.diffModel`. */
export const strategyAdm: ReviewStrategy = {
	name: "a-dm",
	get version() {
		cachedVersion ??= diffModelVersion();
		return cachedVersion;
	},
	needsCheckout: false,
	estimateCost(input) {
		const section = replayDiffModelSection(input);
		return strategyA.estimateCost({
			...input,
			diff: "x".repeat(input.diff.length + section.length),
		});
	},
	run: (input) => runAuditStrategy(input, replayDiffModelSection(input)),
};
