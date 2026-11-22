import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { PushFile } from "../moved-blocks.js";
import { seedReviewInput } from "../replay/seeds/input.js";
import { listSeeds } from "../replay/seeds/schema.js";
import { toPushFile } from "../review.js";
import { buildDiffModel } from "./index.js";

const execFileAsync = promisify(execFile);
const HISTORY_COMMITS = 15;

interface Corpus {
	label: string;
	files: PushFile[];
}

async function seedCorpora(): Promise<Corpus[]> {
	const corpora: Corpus[] = [];
	for (const seed of await listSeeds()) {
		const input = await seedReviewInput(seed);
		try {
			corpora.push({ label: seed.id, files: input.files.map(toPushFile) });
		} finally {
			await input.cleanup();
		}
	}
	return corpora;
}

async function git(args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		maxBuffer: 64 * 1024 * 1024,
	});
	return stdout;
}

const STATUS: Record<string, string> = {
	A: "added",
	D: "removed",
	R: "renamed",
};

async function commitCorpus(sha: string): Promise<Corpus | null> {
	const names = await git([
		"diff",
		"-M",
		"--name-status",
		`${sha}^`,
		sha,
		"--",
		"src",
	]);
	const files: PushFile[] = [];
	for (const line of names.split("\n").filter(Boolean)) {
		const [code, first, second] = line.split("\t");
		const filename = second ?? first;
		const paths = second ? [first, second] : [first];
		const raw = await git(["diff", "-M", `${sha}^`, sha, "--", ...paths]);
		const at = raw.search(/^@@/m);
		files.push(
			toPushFile({
				filename,
				status: STATUS[code[0]] ?? "modified",
				...(at === -1 ? {} : { patch: raw.slice(at).replace(/\n$/, "") }),
				...(second ? { previous_filename: first } : {}),
			}),
		);
	}
	return files.length > 0 ? { label: sha.slice(0, 7), files } : null;
}

async function historyCorpora(): Promise<Corpus[]> {
	try {
		const shas = (
			await git(["log", `-${HISTORY_COMMITS}`, "--no-merges", "--format=%H"])
		)
			.split("\n")
			.filter(Boolean);
		const corpora: Corpus[] = [];
		for (const sha of shas) {
			const corpus = await commitCorpus(sha).catch(() => null);
			if (corpus) corpora.push(corpus);
		}
		return corpora;
	} catch {
		return [];
	}
}

describe("buildDiffModel on real code", () => {
	it("buildDiffModel runs over every recorded fixture without throwing and reports relocation counts and dropped claims", async () => {
		const corpora = [...(await seedCorpora()), ...(await historyCorpora())];
		const rows = corpora.map(({ label, files }) => {
			const model = buildDiffModel({
				scopeFiles: files,
				prFiles: files,
				prFilesComplete: true,
				title: "",
				body: null,
			});
			return {
				label,
				files: files.length,
				relocations: model.operations.filter((o) => o.type === "relocation")
					.length,
				droppedClaims: model.droppedClaims,
			};
		});
		console.info(
			`diff model over ${rows.length} real diffs\n${rows
				.filter((r) => r.relocations > 0 || r.droppedClaims > 0)
				.map(
					(r) =>
						`${r.label} files=${r.files} relocations=${r.relocations} dropped=${r.droppedClaims}`,
				)
				.join(
					"\n",
				)}\ntotal relocations=${rows.reduce((n, r) => n + r.relocations, 0)} dropped=${rows.reduce((n, r) => n + r.droppedClaims, 0)}`,
		);
		expect(rows.length).toBeGreaterThan(0);
	}, 120_000);
});
