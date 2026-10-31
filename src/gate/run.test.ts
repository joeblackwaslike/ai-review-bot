import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewPassResult } from "../audit.js";
import type { ModelReview } from "../review.js";
import type { AuditFile, GitRunner } from "../sources.js";
import { buildInlineComment, buildModelReview } from "../testing.js";
import { validateReport } from "./report.js";
import { gateRepoSlug, gateRoot, runGate } from "./run.js";
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
	since: Record<string, string[]>;
	files: Record<string, FakeFile>;
};

function repo(files: Record<string, FakeFile>, head = "head1"): FakeRepo {
	return {
		head,
		mergeBase: "base0",
		branch: "feat/x",
		ancestors: new Set(),
		since: {},
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
		if (a.startsWith("symbolic-ref")) return "refs/remotes/origin/main\n";
		if (a === "rev-parse --verify --quiet origin/main") return "x\n";
		if (a === "merge-base HEAD origin/main") return `${state.mergeBase}\n`;
		if (a === "rev-parse HEAD") return `${state.head}\n`;
		if (a.startsWith("for-each-ref")) return `${state.branch}\n`;
		if (args[0] === "merge-base" && args[1] === "--is-ancestor") {
			const sha = args[2] ?? "";
			if (sha === state.head || state.ancestors.has(sha)) return "";
			throw new Error("not an ancestor");
		}
		if (args.includes("--name-status")) {
			const ref = args[5] ?? "";
			if (args[6] !== "HEAD") throw new Error(`unexpected range ${a}`);
			if (ref !== state.mergeBase) {
				const since = state.since[ref];
				if (!since) throw new Error(`no history from ${ref}`);
				return since.map((l) => (l.includes("\t") ? l : `M\t${l}`)).join("\n");
			}
			return Object.entries(state.files)
				.map(([p, f]) =>
					f.status === "R" ? `R100\t${f.oldPath}\t${p}` : `${f.status}\t${p}`,
				)
				.join("\n");
		}
		if (args[0] === "diff" && args[1] === "-M" && args[4] === "--") {
			if (args[2] !== state.mergeBase || args[3] !== "HEAD")
				throw new Error(`diff against the wrong base: ${a}`);
			const f = state.files[args.at(-1) ?? ""];
			if (!f) throw new Error(`no diff for ${args.at(-1)}`);
			return f.diff;
		}
		if (args[0] === "diff" && args[3] === "--") {
			if (args[1] !== state.mergeBase || args[2] !== "HEAD")
				throw new Error(`diff against the wrong base: ${a}`);
			const f = state.files[args[4] ?? ""];
			if (!f) throw new Error(`no diff for ${args[4]}`);
			return f.diff;
		}
		if (args[0] === "ls-tree") {
			const f = state.files[args.at(-1) ?? ""];
			return f && f.status !== "D" ? `100644 blob x\t${args.at(-1)}\n` : "";
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
	const providersRun = over.providersRun ?? ["anthropic"];
	const providerStats =
		over.providerStats ??
		providersRun.map((provider) => ({ provider, attempted: 5, succeeded: 5 }));
	return {
		merged,
		costUsd: 0,
		models: ["m"],
		agentsAttempted: providerStats.reduce((n, s) => n + s.attempted, 0),
		agentsSucceeded: providerStats.reduce((n, s) => n + s.succeeded, 0),
		...over,
		providersRun,
		providerStats,
	};
}

const stats = (anthropic: number, openai: number) => ({
	providersRun: ["anthropic", "openai"] as ReviewPassResult["providersRun"],
	providerStats: [
		{ provider: "anthropic" as const, attempted: 5, succeeded: anthropic },
		{ provider: "openai" as const, attempted: 5, succeeded: openai },
	],
});

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
		state.since.head1 = [];
		state.head = "head2";
		state.files["src/a.ts"] = modified("a2");
		state.since.head1 = ["src/a.ts"];
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
		state.since.head1 = [];
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
			state.since.head1 = [];
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
			state.since.head1 = ["src/d.ts", "README.md"];

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
			state.since.head1 = ["R100\tsrc/c.ts\tsrc/e.ts"];

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
		state.since.head1 = ["src/a.ts"];
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
		state.since.head1 = [];
		state.head = "head2";
		state.files["src/a.ts"] = modified("a2");
		state.since.head1 = ["src/a.ts"];
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
		state.since.head1 = [];
		state.head = "head2";
		state.files["src/a.ts"] = modified("a2");
		state.since.head1 = ["src/a.ts"];
		const result = await gate(state, async () =>
			passResult(buildModelReview(), {
				providerStats: [{ provider: "anthropic", attempted: 5, succeeded: 4 }],
			}),
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
		state.since.head1 = [];
		state.head = "head2";
		state.files["src/a.ts"] = modified("a2");
		state.since.head1 = ["src/a.ts"];
		const second = await gate(state, async () =>
			passResult(buildModelReview()),
		);

		expect(first.findings).toHaveLength(1);
		expect(second.findings).toEqual([]);
	});

	it("a provider that drops out cannot get its finding inferred fixed two rounds later", async () => {
		const state = repo({ "src/a.ts": modified("a1") });
		await gate(state, async () =>
			passResult(buildModelReview({ inline_comments: [P1_ON_A] }), {
				providersRun: ["anthropic", "openai"],
			}),
		);

		state.ancestors.add("head1");
		state.since.head1 = ["src/a.ts"];
		state.head = "head2";
		state.files["src/a.ts"] = modified("a2");
		const second = await gate(state, async () =>
			passResult(buildModelReview()),
		);

		state.ancestors.add("head2");
		state.since.head2 = [];
		state.head = "head3";
		const third = await gate(
			state,
			async () => passResult(buildModelReview()),
			null,
		);

		expect(second.findings).toHaveLength(1);
		expect(third.findings).toHaveLength(1);
		expect(third.exitCode).toBe(1);
		const store = await readStore(state);
		expect(store.providers).toEqual(["anthropic", "openai"]);
		expect(store.lastHead).toBe("head1");
		expect(errors.join("\n")).toContain(storeDir);
	});

	it("a first round with one provider does not block fixes seen by a later round with both", async () => {
		const state = repo({ "src/a.ts": modified("a1") });
		const first = await gate(
			state,
			async () => passResult(buildModelReview({ inline_comments: [P1_ON_A] })),
			null,
		);

		state.ancestors.add("head1");
		state.since.head1 = ["src/a.ts"];
		state.head = "head2";
		state.files["src/a.ts"] = modified("a2");
		const both: ReviewPassResult["providersRun"] = ["anthropic", "openai"];
		const second = await gate(
			state,
			async () => passResult(buildModelReview(), { providersRun: both }),
			null,
		);

		state.ancestors.add("head2");
		state.since.head2 = [];
		state.head = "head3";
		const third = await gate(
			state,
			async () => passResult(buildModelReview(), { providersRun: both }),
			null,
		);

		expect(first.exitCode).toBe(1);
		expect(second.exitCode).toBe(0);
		expect(second.findings).toEqual([]);
		expect(third.exitCode).toBe(0);
		const store = await readStore(state);
		expect(store.providers).toEqual(["anthropic", "openai"]);
		expect(store.lastHead).toBe("head3");
		expect(store.entries.map((e) => e.status)).toEqual(["fixed"]);
	});

	describe("a provider whose every agent failed", () => {
		async function roundTwo(state: FakeRepo, over: Partial<ReviewPassResult>) {
			state.ancestors.add("head1");
			state.since.head1 = ["src/a.ts"];
			state.head = "head2";
			state.files["src/a.ts"] = modified("a2");
			return gate(
				state,
				async () => passResult(buildModelReview(), over),
				null,
			);
		}

		it("counts as not run, so a fresh store records the other provider and later infers fixes", async () => {
			const state = repo({ "src/a.ts": modified("a1") });
			const first = await gate(state, async () =>
				passResult(
					buildModelReview({ inline_comments: [P1_ON_A] }),
					stats(5, 0),
				),
			);
			expect(first.findings).toHaveLength(1);
			expect((await readStore(state)).providers).toEqual(["anthropic"]);

			const second = await roundTwo(state, stats(5, 0));

			expect(second.exitCode).toBe(0);
			expect(second.findings).toEqual([]);
			const store = await readStore(state);
			expect(store.entries.map((e) => e.status)).toEqual(["fixed"]);
			expect(store.lastHead).toBe("head2");
		});

		it("is a mismatch when the stored set had it", async () => {
			const state = repo({ "src/a.ts": modified("a1") });
			await gate(state, async () =>
				passResult(
					buildModelReview({ inline_comments: [P1_ON_A] }),
					stats(5, 5),
				),
			);

			const second = await roundTwo(state, stats(5, 0));

			expect(second.exitCode).toBe(1);
			expect(second.findings).toHaveLength(1);
			const store = await readStore(state);
			expect(store.providers).toEqual(["anthropic", "openai"]);
			expect(store.lastHead).toBe("head1");
			expect(errors.join("\n")).toMatch(/do not include every provider/);
		});

		it("cannot get a finding it raised in a mismatch round inferred fixed once it drops out", async () => {
			const state = repo({ "src/a.ts": modified("a1") });
			await gate(state, async () =>
				passResult(buildModelReview(), stats(5, 0)),
			);

			state.ancestors.add("head1");
			state.since.head1 = ["src/a.ts"];
			state.head = "head2";
			state.files["src/a.ts"] = modified("a2");
			const second = await gate(
				state,
				async () =>
					passResult(
						buildModelReview({ inline_comments: [P1_ON_A] }),
						stats(0, 5),
					),
				null,
			);

			state.ancestors.add("head2");
			state.since.head2 = ["src/a.ts"];
			state.head = "head3";
			state.files["src/a.ts"] = modified("a3");
			const third = await gate(
				state,
				async () => passResult(buildModelReview(), stats(5, 0)),
				null,
			);

			expect(second.findings).toHaveLength(1);
			expect(third.exitCode).toBe(1);
			expect(third.findings.map((f) => f.id)).toEqual(
				second.findings.map((f) => f.id),
			);
			const store = await readStore(state);
			expect(store.entries.map((e) => e.status)).toEqual(["open"]);
			expect(store.providers).toEqual(["anthropic", "openai"]);
			expect(store.lastHead).toBe("head1");
			expect(errors.join("\n")).toContain("openai 0/5");
		});

		it("a review where no provider attempted an agent is not a complete round", async () => {
			const state = repo({ "src/a.ts": modified("a1") });

			await gate(state, async () =>
				passResult(buildModelReview(), {
					providerStats: [
						{ provider: "anthropic", attempted: 0, succeeded: 0 },
					],
				}),
			);

			expect((await readStore(state)).lastHead).toBeNull();
			expect(errors.join("\n")).toMatch(/Round incomplete/);
		});

		it("is different from a provider that partly failed, which leaves the round incomplete", async () => {
			const state = repo({ "src/a.ts": modified("a1") });
			await gate(state, async () =>
				passResult(
					buildModelReview({ inline_comments: [P1_ON_A] }),
					stats(5, 5),
				),
			);

			const second = await roundTwo(state, stats(5, 3));

			expect(second.exitCode).toBe(1);
			const store = await readStore(state);
			expect(store.entries.map((e) => e.status)).toEqual(["open"]);
			expect(store.lastHead).toBe("head1");
			expect(errors.join("\n")).toMatch(/Round incomplete/);
		});
	});

	it("a rename of a file the branch added keeps the finding's id and moves its path", async () => {
		const added = (diff: string): FakeFile => ({
			...modified(diff),
			status: "A",
		});
		const state = repo({ "src/a.ts": added("a1") });
		const first = await gate(state, async () =>
			passResult(
				buildModelReview({
					inline_comments: [
						{ ...P1_ON_A, title: "Empty catch swallows the error" },
					],
				}),
			),
		);

		state.ancestors.add("head1");
		state.since.head1 = ["R100\tsrc/a.ts\tsrc/b.ts"];
		state.head = "head2";
		state.files = { "src/b.ts": added("b1") };
		const second = await gate(state, async () =>
			passResult(
				buildModelReview({
					inline_comments: [
						{
							...P1_ON_A,
							path: "src/b.ts",
							title: "Error is swallowed by the empty catch",
						},
					],
				}),
			),
		);

		expect(second.findings).toHaveLength(1);
		expect(second.findings[0]?.id).toBe(first.findings[0]?.id);
		expect(second.findings[0]?.file).toBe("src/b.ts");
		const store = await readStore(state);
		expect(store.entries.map((e) => e.path)).toEqual(["src/b.ts"]);
	});

	it("a path-less finding is carried at the same HEAD and dropped after a new commit", async () => {
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
		const first = await gate(
			state,
			async () => passResult(buildModelReview({ general_findings: [general] })),
			null,
		);

		state.ancestors.add("head1");
		state.since.head1 = [];
		const review = vi.fn(async (_files: AuditFile[]) =>
			passResult(buildModelReview()),
		);
		const rerun = await gate(state, review, null);

		state.head = "head2";
		const later = await gate(state, review, null);

		expect(first.exitCode).toBe(1);
		expect(review).not.toHaveBeenCalled();
		expect(rerun.findings.map((f) => f.id)).toEqual(
			first.findings.map((f) => f.id),
		);
		expect(rerun.exitCode).toBe(1);
		expect(later.findings).toEqual([]);
		expect(later.exitCode).toBe(0);
	});

	it("a findings-file write failure does not save the round", async () => {
		const state = repo({ "src/a.ts": modified("a1") });

		await expect(
			gate(
				state,
				async () =>
					passResult(buildModelReview({ inline_comments: [P1_ON_A] })),
				join(dir, "missing", "findings.json"),
			),
		).rejects.toThrow();
		await expect(readdir(storeDir)).rejects.toThrow();
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

describe("gateRepoSlug", () => {
	it.each([
		["https://github.com/o/r.git", "o", "r"],
		["https://github.com/o/r", "o", "r"],
		["git@github.com:o/r.git", "o", "r"],
		["ssh://git@github.com/o/r.git", "o", "r"],
		["https://gitlab.example.com/a/b/c.git", "b", "c"],
		["git@gitlab.example.com:group/sub/proj.git", "sub", "proj"],
		["/x/y/z.git", "y", "z"],
		["/x/y/z.git/", "y", "z"],
		["file:///x/y/z.git", "y", "z"],
		["../z.git", "local", "z"],
		["z", "local", "z"],
	])("maps %s to %s/%s", (origin, owner, repo) => {
		expect(gateRepoSlug(origin, "/work/top")).toEqual({ owner, repo });
	});

	it("uses the top-level directory name when there is no origin", () => {
		expect(gateRepoSlug(null, "/work/my-repo")).toEqual({
			owner: "local",
			repo: "my-repo",
		});
	});
});

describe("runGate against a real git repo", () => {
	function makeRepo() {
		const root = mkdtempSync(join(tmpdir(), "gate-git-"));
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: root, encoding: "utf-8" });
		git("init", "-q", "-b", "main");
		git("config", "user.email", "t@example.com");
		git("config", "user.name", "t");
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src/a.ts"), "try {\n  run();\n} catch {}\n");
		git("add", ".");
		git("commit", "-q", "-m", "base");
		git("checkout", "-q", "-b", "feat");
		writeFileSync(
			join(root, "src/a.ts"),
			"try {\n  run();\n  more();\n} catch {}\n",
		);
		git("commit", "-qam", "edit");
		return { root, git };
	}

	const realGate = (root: string, merged: ModelReview, cwd = root) =>
		runGate({
			cwd,
			owner: "o",
			repo: "r",
			base: "main",
			storeDir,
			review: async () => passResult(merged),
		});

	it("gateRoot maps a subdirectory to the repo top level, so diff hashes are not empty", async () => {
		const { root } = makeRepo();
		const sub = join(root, "src");

		expect(gateRoot(sub)).toBe(realpathSync(root));

		await realGate(
			root,
			buildModelReview({ inline_comments: [P1_ON_A] }),
			gateRoot(sub),
		);
		const store = JSON.parse(
			await readFile(
				join(storeDir, (await readdir(storeDir))[0] ?? ""),
				"utf8",
			),
		) as GateStore;
		const emptyDiff = createHash("sha1").update("").digest("hex");
		expect(store.entries[0]?.evidence).not.toContain(`diff:${emptyDiff}`);
	});

	it("gateRoot falls back to the given directory outside a repo", () => {
		const outside = mkdtempSync(join(tmpdir(), "gate-nogit-"));
		expect(gateRoot(outside)).toBe(outside);
	});

	it("a rebase onto a moved base keeps the file's diff hash, so a later round neither re-reviews nor fixes it", async () => {
		const { root, git } = makeRepo();
		const first = await realGate(
			root,
			buildModelReview({ inline_comments: [P1_ON_A] }),
		);

		git("checkout", "-q", "main");
		writeFileSync(join(root, "src/c.ts"), "export const c = 1;\n");
		git("add", ".");
		git("commit", "-qm", "base moves");
		git("checkout", "-q", "feat");
		git("rebase", "-q", "main");
		await realGate(root, buildModelReview());

		git("commit", "-q", "--allow-empty", "-m", "noop");
		const review = vi.fn(async (_files: AuditFile[]) =>
			passResult(buildModelReview()),
		);
		const third = await runGate({
			cwd: root,
			owner: "o",
			repo: "r",
			base: "main",
			storeDir,
			review,
		});

		expect(review).not.toHaveBeenCalled();
		expect(third.findings.map((f) => f.id)).toEqual(
			first.findings.map((f) => f.id),
		);
	});

	it("a pure rename plus one model miss keeps the finding open", async () => {
		const { root, git } = makeRepo();
		const first = await realGate(
			root,
			buildModelReview({ inline_comments: [P1_ON_A] }),
		);

		git("mv", "src/a.ts", "src/b.ts");
		git("commit", "-qm", "move");
		const second = await realGate(root, buildModelReview());

		expect(second.findings.map((f) => f.id)).toEqual(
			first.findings.map((f) => f.id),
		);
		expect(second.findings[0]?.file).toBe("src/b.ts");
	});
});
