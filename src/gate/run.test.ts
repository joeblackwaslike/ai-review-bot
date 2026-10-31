import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewPassResult } from "../audit.js";
import type { ModelReview } from "../review.js";
import type { AuditFile, GitRunner } from "../sources.js";
import { buildInlineComment, buildModelReview } from "../testing.js";
import { validateReport } from "./report.js";
import { runGate } from "./run.js";
import { type GateStore, gateStorePath, storeKey } from "./store.js";

type FakeFile = {
	status: "A" | "M" | "D" | "R";
	oldPath?: string;
	diff: string;
	content: string;
};

type FakeRepo = {
	head: string;
	mergeBase: string;
	branch: string;
	ancestors: Set<string>;
	sinceLast: string[];
	files: Record<string, FakeFile>;
};

function repo(files: Record<string, FakeFile>, head = "head1"): FakeRepo {
	return {
		head,
		mergeBase: "base0",
		branch: "feat/x",
		ancestors: new Set(),
		sinceLast: [],
		files,
	};
}

const modified = (diff: string): FakeFile => ({
	status: "M",
	diff,
	content: `// ${diff}\n`,
});

function fakeGit(state: FakeRepo): GitRunner {
	return (args) => {
		const a = args.join(" ");
		if (a === "symbolic-ref refs/remotes/origin/HEAD")
			return "refs/remotes/origin/main\n";
		if (a === "rev-parse --verify --quiet origin/main") return "x\n";
		if (a === "merge-base HEAD origin/main") return `${state.mergeBase}\n`;
		if (a === "rev-parse HEAD") return `${state.head}\n`;
		if (a.startsWith("for-each-ref")) return `${state.branch}\n`;
		if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
			if (state.ancestors.has(args[2] ?? "")) return "";
			throw new Error("not an ancestor");
		}
		if (a.includes("--name-only")) return state.sinceLast.join("\n");
		if (a.includes("--name-status")) {
			return Object.entries(state.files)
				.map(([p, f]) =>
					f.status === "R" ? `R100\t${f.oldPath}\t${p}` : `${f.status}\t${p}`,
				)
				.join("\n");
		}
		if (args[0] === "diff" && args[3] === "--") {
			const f = state.files[args[4] ?? ""];
			if (!f) throw new Error(`no diff for ${args[4]}`);
			return f.diff;
		}
		if (args[0] === "show" && args[1]?.startsWith("HEAD:")) {
			const f = state.files[args[1].slice(5)];
			if (!f || f.status === "D") throw new Error("absent");
			return f.content;
		}
		throw new Error(`unexpected git ${a}`);
	};
}

function passResult(
	merged: ModelReview,
	over: Partial<ReviewPassResult> = {},
): ReviewPassResult {
	return {
		merged,
		costUsd: 0,
		providersRun: ["anthropic"],
		models: ["m"],
		agentsAttempted: 5,
		agentsSucceeded: 5,
		...over,
	};
}

const P1_ON_A = buildInlineComment({
	path: "src/a.ts",
	line: 3,
	severity: "P1",
	title: "Retry loop swallows the fetch error",
	body: "The catch block discards the error and returns undefined after the last attempt.",
});

let dir: string;
let storeDir: string;
let findingsFile: string;
let errors: string[];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "gate-run-"));
	storeDir = join(dir, "store");
	findingsFile = join(dir, "findings.json");
	await writeFile(findingsFile, "");
	errors = [];
	vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
		errors.push(a.map(String).join(" "));
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

function gate(
	state: FakeRepo,
	review: (files: AuditFile[]) => Promise<ReviewPassResult>,
	file: string | null = findingsFile,
) {
	return runGate({
		cwd: dir,
		owner: "o",
		repo: "r",
		findingsFile: file ?? undefined,
		storeDir,
		runGit: fakeGit(state),
		review,
	});
}

async function readStore(state: FakeRepo): Promise<GateStore> {
	const key = storeKey(fakeGit(state), "o", "r", state.mergeBase);
	return JSON.parse(await readFile(gateStorePath(key, storeDir), "utf8"));
}

describe("runGate", () => {
	it("writes a schema-valid report to the findings file", async () => {
		const state = repo({ "src/a.ts": modified("d1") });
		const review = vi.fn(async (_files: AuditFile[]) =>
			passResult(buildModelReview({ inline_comments: [P1_ON_A] })),
		);

		const result = await gate(state, review);

		const json = await readFile(findingsFile, "utf8");
		expect(validateReport(json)).toEqual([]);
		const { findings } = JSON.parse(json);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			severity: "error",
			file: "src/a.ts",
			line: 3,
			action: "ask-user",
		});
		expect(result.exitCode).toBe(0);
		expect(review).toHaveBeenCalledWith([
			{ path: "src/a.ts", content: "// d1\n" },
		]);
	});

	it("an empty range writes an empty report and never calls review", async () => {
		const review = vi.fn();

		const result = await gate(repo({}), review);

		expect(review).not.toHaveBeenCalled();
		expect(await readFile(findingsFile, "utf8")).toBe('{"findings":[]}');
		expect(result.exitCode).toBe(0);
		expect(result.findings).toEqual([]);
	});

	it("round 2 reviews only files whose diff changed", async () => {
		const P2_ON_B = buildInlineComment({
			path: "src/b.ts",
			severity: "P2",
			title: "Timeout constant is never read",
		});
		const state = repo({
			"src/a.ts": modified("a1"),
			"src/b.ts": modified("b1"),
		});
		await gate(state, async () =>
			passResult(buildModelReview({ inline_comments: [P1_ON_A, P2_ON_B] })),
		);

		state.ancestors.add("head1");
		state.head = "head2";
		state.files["src/a.ts"] = modified("a2");
		state.sinceLast = ["src/a.ts"];
		const review = vi.fn(async (_files: AuditFile[]) =>
			passResult(buildModelReview({ inline_comments: [P1_ON_A] })),
		);
		const result = await gate(state, review);

		expect(review).toHaveBeenCalledTimes(1);
		expect(review.mock.calls[0]?.[0].map((f) => f.path)).toEqual(["src/a.ts"]);
		expect(result.findings.map((f) => f.file).sort()).toEqual([
			"src/a.ts",
			"src/b.ts",
		]);
	});

	it("a round with no changed file skips review and still reports open findings", async () => {
		const state = repo({ "src/a.ts": modified("a1") });
		const first = await gate(state, async () =>
			passResult(buildModelReview({ inline_comments: [P1_ON_A] })),
		);

		state.ancestors.add("head1");
		state.head = "head2";
		const review = vi.fn();
		const result = await gate(state, review, null);

		expect(review).not.toHaveBeenCalled();
		expect(result.findings.map((f) => f.id)).toEqual(
			first.findings.map((f) => f.id),
		);
		expect(result.exitCode).toBe(1);
	});

	describe("delta round scope", () => {
		async function roundOne(state: FakeRepo) {
			await gate(state, async () =>
				passResult(buildModelReview({ inline_comments: [P1_ON_A] })),
			);
			state.ancestors.add("head1");
			state.head = "head2";
		}

		const reviewedIn = async (state: FakeRepo) => {
			const review = vi.fn(async (_files: AuditFile[]) =>
				passResult(buildModelReview()),
			);
			await gate(state, review);
			return review.mock.calls.flatMap(([files]) => files.map((f) => f.path));
		};

		it("does not review an untouched file that has no entry", async () => {
			const state = repo({
				"src/a.ts": modified("a1"),
				"src/c.ts": modified("c1"),
			});
			await roundOne(state);

			expect(await reviewedIn(state)).toEqual([]);
		});

		it("reviews a file named by the diff since the last head", async () => {
			const state = repo({
				"src/a.ts": modified("a1"),
				"src/c.ts": modified("c1"),
			});
			await roundOne(state);
			state.files["src/d.ts"] = { ...modified("d1"), status: "A" };
			state.sinceLast = ["src/d.ts", "README.md"];

			expect(await reviewedIn(state)).toEqual(["src/d.ts"]);
		});

		it("reviews a renamed file under its new path", async () => {
			const state = repo({
				"src/a.ts": modified("a1"),
				"src/c.ts": modified("c1"),
			});
			await roundOne(state);
			state.files = {
				"src/a.ts": modified("a1"),
				"src/e.ts": {
					status: "R",
					oldPath: "src/c.ts",
					diff: "e1",
					content: "// e1\n",
				},
			};
			state.sinceLast = ["src/e.ts"];

			expect(await reviewedIn(state)).toEqual(["src/e.ts"]);
		});

		it("reviews a file holding an open entry whose diff changed without a commit touching it", async () => {
			const state = repo({
				"src/a.ts": modified("a1"),
				"src/c.ts": modified("c1"),
			});
			await roundOne(state);
			state.mergeBase = "base1";
			state.files["src/a.ts"] = modified("a1-against-base1");

			expect(await reviewedIn(state)).toEqual(["src/a.ts"]);
		});
	});

	it("round 2 after a rebase that dropped the stored head reviews the full range and infers nothing", async () => {
		const state = repo({
			"src/a.ts": modified("a1"),
			"src/b.ts": modified("b1"),
		});
		await gate(state, async () =>
			passResult(buildModelReview({ inline_comments: [P1_ON_A] })),
		);

		state.head = "rebased";
		state.files["src/a.ts"] = modified("a2");
		state.sinceLast = ["src/a.ts"];
		const review = vi.fn(async (_files: AuditFile[]) =>
			passResult(buildModelReview()),
		);
		const result = await gate(state, review);

		expect(review.mock.calls[0]?.[0].map((f) => f.path)).toEqual([
			"src/a.ts",
			"src/b.ts",
		]);
		const store = await readStore(state);
		expect(store.entries.map((e) => e.status)).toEqual(["open"]);
		expect(result.findings).toHaveLength(1);
		expect(errors.join("\n")).toMatch(/rescope/i);
	});

	it("a fixed finding is absent from round 2 and marked fixed in the store", async () => {
		const state = repo({ "src/a.ts": modified("a1") });
		await gate(state, async () =>
			passResult(buildModelReview({ inline_comments: [P1_ON_A] })),
		);

		state.ancestors.add("head1");
		state.head = "head2";
		state.files["src/a.ts"] = modified("a2");
		state.sinceLast = ["src/a.ts"];
		const result = await gate(state, async () =>
			passResult(buildModelReview()),
		);

		expect(result.findings).toEqual([]);
		expect(JSON.parse(await readFile(findingsFile, "utf8"))).toEqual({
			findings: [],
		});
		const store = await readStore(state);
		expect(store.entries.map((e) => e.status)).toEqual(["fixed"]);
		expect(store.lastHead).toBe("head2");
	});

	it("without a findings file it prints text and exits 1 on an error finding", async () => {
		const state = repo({ "src/a.ts": modified("a1") });

		const result = await gate(
			state,
			async () => passResult(buildModelReview({ inline_comments: [P1_ON_A] })),
			null,
		);

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("src/a.ts:3");
		expect(result.stdout).toContain("Retry loop swallows the fetch error");
		expect(await readFile(findingsFile, "utf8")).toBe("");
	});

	it("without a findings file and no error finding it exits 0", async () => {
		const state = repo({ "src/a.ts": modified("a1") });
		const P3 = buildInlineComment({ path: "src/a.ts", severity: "P3" });

		const result = await gate(
			state,
			async () => passResult(buildModelReview({ inline_comments: [P3] })),
			null,
		);

		expect(result.exitCode).toBe(0);
		expect(result.findings).toHaveLength(1);
	});

	it("a corrupt store prints the reset warning and continues", async () => {
		const state = repo({ "src/a.ts": modified("a1") });
		const path = gateStorePath(
			storeKey(fakeGit(state), "o", "r", state.mergeBase),
			storeDir,
		);
		await gate(state, async () => passResult(buildModelReview()));
		await writeFile(path, "{not json");

		const result = await gate(state, async () =>
			passResult(buildModelReview({ inline_comments: [P1_ON_A] })),
		);

		expect(errors.join("\n")).toMatch(/history was reset/);
		expect(result.findings).toHaveLength(1);
		expect((await readdir(storeDir)).some((f) => f.includes(".corrupt-"))).toBe(
			true,
		);
	});

	it("an incomplete round keeps unmatched findings open", async () => {
		const state = repo({ "src/a.ts": modified("a1") });
		await gate(state, async () =>
			passResult(buildModelReview({ inline_comments: [P1_ON_A] })),
		);

		state.ancestors.add("head1");
		state.head = "head2";
		state.files["src/a.ts"] = modified("a2");
		state.sinceLast = ["src/a.ts"];
		const result = await gate(state, async () =>
			passResult(buildModelReview(), { agentsSucceeded: 4 }),
		);

		expect(result.findings).toHaveLength(1);
		expect((await readStore(state)).entries[0]?.status).toBe("open");
	});

	it("a general finding is reported only in a round that raises it", async () => {
		const state = repo({ "src/a.ts": modified("a1") });
		const general = {
			title: "No tests cover the retry path",
			body: "Nothing exercises the retry branch.",
			severity: "P1" as const,
			category: "test-gap" as const,
			confidence: 0.9,
			evidence: "See diff.",
			suppressible: false,
		};
		const first = await gate(state, async () =>
			passResult(buildModelReview({ general_findings: [general] })),
		);

		state.ancestors.add("head1");
		state.head = "head2";
		state.files["src/a.ts"] = modified("a2");
		state.sinceLast = ["src/a.ts"];
		const second = await gate(state, async () =>
			passResult(buildModelReview()),
		);

		expect(first.findings).toHaveLength(1);
		expect(second.findings).toEqual([]);
	});

	it("a review failure propagates and leaves the store untouched", async () => {
		const state = repo({ "src/a.ts": modified("a1") });

		await expect(
			gate(state, async () => {
				throw new Error("No provider could be authenticated.");
			}),
		).rejects.toThrow("No provider could be authenticated.");
		await expect(readdir(storeDir)).rejects.toThrow();
	});
});
