import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { collectRightSideLines, numberPatchLines } from "../../diff-lines.js";
import type { PullFile } from "../../review.js";
import type { FrozenFixture } from "../frozen.js";
import type { CheckoutHandle } from "../strategy.js";
import type { Round } from "../types.js";
import { seedGit } from "./git.js";
import { type MaterializedSeed, materializeSeed } from "./materialize.js";
import type { Seed } from "./schema.js";

const execFileAsync = promisify(execFile);

export interface SeedReviewInput {
	fixture: FrozenFixture;
	round: Round;
	diff: string;
	files: PullFile[];
	checkout: CheckoutHandle;
	cleanup(): Promise<void>;
}

const STATUS: Record<string, string> = {
	A: "added",
	M: "modified",
	D: "removed",
	R: "renamed",
	C: "copied",
	T: "modified",
};

function stripHeader(raw: string): string | undefined {
	const at = raw.search(/^@@/m);
	return at === -1 ? undefined : raw.slice(at).replace(/\n$/, "");
}

async function diffFiles(m: MaterializedSeed): Promise<PullFile[]> {
	const names = await seedGit(m.repoPath, [
		"diff",
		"-M",
		"--name-status",
		m.baseSha,
		m.headSha,
	]);
	const files: PullFile[] = [];
	for (const line of names.split("\n").filter(Boolean)) {
		const [code, first, second] = line.split("\t");
		const previous = second === undefined ? undefined : first;
		const filename = second ?? first;
		const paths = previous ? [previous, filename] : [filename];
		const patch = stripHeader(
			await seedGit(m.repoPath, [
				"diff",
				"-M",
				m.baseSha,
				m.headSha,
				"--",
				...paths,
			]),
		);
		const body = patch?.split("\n") ?? [];
		files.push({
			filename,
			status: STATUS[code[0]] ?? "modified",
			...(patch === undefined ? {} : { patch }),
			additions: body.filter((l) => l.startsWith("+")).length,
			deletions: body.filter((l) => l.startsWith("-")).length,
			...(previous ? { previous_filename: previous } : {}),
		});
	}
	return files;
}

/**
 * Materialises the seed and shapes it like a one-round replay input: files from the
 * base..head diff, a right-side-numbered diff, and a read-only checkout of the head tree.
 */
export async function seedReviewInput(seed: Seed): Promise<SeedReviewInput> {
	const m = await materializeSeed(seed);
	const cleanup = async () => {
		await execFileAsync("chmod", ["-R", "u+w", m.repoPath]).catch(() => {});
		await m.cleanup();
	};
	try {
		const files = await diffFiles(m);
		const diff = files
			.map((f) => `### ${f.filename}\n${numberPatchLines(f.patch ?? "")}`)
			.join("\n\n");
		const round: Round = {
			index: 0,
			reviewId: 0,
			provider: "anthropic",
			submittedAt: "2026-01-01T00:00:00Z",
			headSha: m.headSha,
			baseSha: m.baseSha,
			mergeBase: m.baseSha,
			triggerAt: null,
			approximate: false,
			commitsSince: [],
			claims: [],
		};
		const fixture: FrozenFixture = {
			owner: "seed",
			repo: `${seed.opId}-${seed.variant}`,
			pull: 0,
			provider: "anthropic",
			author: "seed",
			rounds: [round],
			threads: [],
			reactions: [],
			excluded: { unknownTimestamp: 0, later: 0 },
		};
		await execFileAsync("chmod", ["-R", "a-w", m.repoPath]);
		return {
			fixture,
			round,
			diff,
			files,
			checkout: { path: m.repoPath, baseSha: m.baseSha, headSha: m.headSha },
			cleanup,
		};
	} catch (err) {
		await cleanup();
		throw err;
	}
}

/** True when the seed's defect range lies entirely on right-side lines the diff shows. */
export function truthInDiff(seed: Seed, files: PullFile[]): boolean {
	if (seed.truth.clean) return true;
	const { path, startLine, endLine } = seed.truth.defects[0];
	const patch = files.find((f) => f.filename === path)?.patch;
	if (!patch) return false;
	const shown = collectRightSideLines(patch);
	for (let line = startLine; line <= endLine; line++) {
		if (!shown.has(line)) return false;
	}
	return true;
}
