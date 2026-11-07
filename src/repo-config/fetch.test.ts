import { describe, expect, it, vi } from "vitest";
import { fetchRepoConfig, type RepoConfigOctokit } from "./fetch.js";

const SHA = "a".repeat(40);
const b64 = (s: string) => Buffer.from(s).toString("base64");

function fakeOctokit(content: () => Promise<{ data: unknown }>) {
	const getContent = vi.fn(content);
	const octokit: RepoConfigOctokit = {
		rest: {
			repos: {
				get: async () => ({ data: { default_branch: "trunk" } }),
				getBranch: async () => ({ data: { commit: { sha: SHA } } }),
				getContent,
			},
		},
	};
	return { octokit, getContent };
}

function fakeKv() {
	const store = new Map<string, string>();
	return {
		store,
		get: async (k: string) => store.get(k) ?? null,
		set: async (k: string, v: string) => {
			store.set(k, v);
		},
	};
}

const file = (text: string) => ({
	data: { type: "file", content: b64(text), size: text.length },
});
const run = (
	octokit: RepoConfigOctokit,
	kv: ReturnType<typeof fakeKv> | null = null,
) => fetchRepoConfig({ octokit, owner: "o", repo: "r", kv });

describe("fetchRepoConfig", () => {
	it("reads the default branch ref, not the PR head", async () => {
		const { octokit, getContent } = fakeOctokit(async () =>
			file("version: 1\n"),
		);
		const r = await run(octokit);
		expect(r.config).toEqual({ version: 1 });
		expect(getContent).toHaveBeenCalledWith({
			owner: "o",
			repo: "r",
			path: ".github/ai-review.yml",
			ref: SHA,
		});
	});

	it("falls back to the branch name when the sha is not hex", async () => {
		const getContent = vi.fn(async () => file("version: 1\n"));
		const octokit: RepoConfigOctokit = {
			rest: {
				repos: {
					get: async () => ({ data: { default_branch: "trunk" } }),
					getBranch: async () => ({ data: { commit: { sha: "not-hex!" } } }),
					getContent,
				},
			},
		};
		await run(octokit);
		expect(getContent).toHaveBeenCalledWith(
			expect.objectContaining({ ref: "trunk" }),
		);
	});

	it("404 returns empty and is cached", async () => {
		const kv = fakeKv();
		const { octokit, getContent } = fakeOctokit(async () => {
			throw Object.assign(new Error("nf"), { status: 404 });
		});
		expect(await run(octokit, kv)).toEqual({});
		expect(await run(octokit, kv)).toEqual({});
		expect(getContent).toHaveBeenCalledTimes(1);
	});

	it("oversize returns a note", async () => {
		const { octokit } = fakeOctokit(async () =>
			file(`version: 1\n# ${"x".repeat(20_001)}`),
		);
		expect((await run(octokit)).note).toMatch(/larger than/);
	});

	it("directory response returns a note", async () => {
		const { octokit } = fakeOctokit(async () => ({ data: [{ type: "dir" }] }));
		expect((await run(octokit)).note).toMatch(/not a regular file/);
	});

	it("bad yaml returns a note without echoing content", async () => {
		const { octokit } = fakeOctokit(async () => file("secret: [unclosed\n"));
		const r = await run(octokit);
		expect(r.note).toBeDefined();
		expect(r.note).not.toContain("secret");
		expect(r.note).not.toContain("unclosed");
	});

	it("schema failure names the path, never the value", async () => {
		const { octokit } = fakeOctokit(async () =>
			file("version: 1\nreview:\n  minSeverity: TOPSECRET\n"),
		);
		const r = await run(octokit);
		expect(r.note).toContain("review/minSeverity");
		expect(r.note).not.toContain("TOPSECRET");
		expect(r.note?.length).toBeLessThanOrEqual(200);
	});

	it("alias bombs are rejected", async () => {
		const lines = ["a: &a [1,1,1,1]"];
		for (let i = 0; i < 30; i++) lines.push(`k${i}: *a`);
		const { octokit } = fakeOctokit(async () => file(lines.join("\n")));
		expect((await run(octokit)).note).toBeDefined();
	});

	it("invalid base64 and invalid UTF-8 return a note", async () => {
		const bad = fakeOctokit(async () => ({
			data: { type: "file", content: "!!!not base64!!!", size: 5 },
		}));
		expect((await run(bad.octokit)).note).toMatch(/UTF-8/);
		const bin = fakeOctokit(async () => ({
			data: {
				type: "file",
				content: Buffer.from([0xff, 0xfe, 0xfd]).toString("base64"),
				size: 3,
			},
		}));
		expect((await run(bin.octokit)).note).toMatch(/UTF-8/);
	});

	it("cache hit skips getContent", async () => {
		const kv = fakeKv();
		const { octokit, getContent } = fakeOctokit(async () =>
			file("version: 1\n"),
		);
		await run(octokit, kv);
		const r = await run(octokit, kv);
		expect(r.config).toEqual({ version: 1 });
		expect(getContent).toHaveBeenCalledTimes(1);
		expect(kv.store.has(`repo-config:o/r@${SHA}`)).toBe(true);
	});

	it("a failing KV does not break the fetch", async () => {
		const kv = {
			get: async () => {
				throw new Error("down");
			},
			set: async () => {
				throw new Error("down");
			},
		};
		const { octokit } = fakeOctokit(async () => file("version: 1\n"));
		expect(
			(await fetchRepoConfig({ octokit, owner: "o", repo: "r", kv })).config,
		).toEqual({ version: 1 });
	});

	it("octokit throwing returns the generic note", async () => {
		const { octokit } = fakeOctokit(async () => {
			throw new Error("boom");
		});
		expect(await run(octokit)).toEqual({
			note: "repo config could not be read",
		});
	});

	it("rejects a poisoned cache entry and reads fresh", async () => {
		const kv = fakeKv();
		kv.store.set(
			`repo-config:o/r@${SHA}`,
			JSON.stringify({ config: { version: 1, enabled: true } }),
		);
		const { octokit, getContent } = fakeOctokit(async () =>
			file("version: 1\n"),
		);
		const r = await run(octokit, kv);
		expect(r.config).toEqual({ version: 1 });
		expect(getContent).toHaveBeenCalledTimes(1);
	});

	it("treats a non-object cached value as a miss", async () => {
		const kv = fakeKv();
		kv.store.set(`repo-config:o/r@${SHA}`, "[1,2]");
		const { octokit, getContent } = fakeOctokit(async () =>
			file("version: 1\n"),
		);
		expect((await run(octokit, kv)).config).toEqual({ version: 1 });
		expect(getContent).toHaveBeenCalledTimes(1);
	});

	it("sanitizes and caps a cached note", async () => {
		const kv = fakeKv();
		kv.store.set(
			`repo-config:o/r@${SHA}`,
			JSON.stringify({ note: `<img src=x>\n@someone ${"y".repeat(300)}` }),
		);
		const { octokit } = fakeOctokit(async () => file("version: 1\n"));
		const r = await run(octokit, kv);
		expect(r.note).not.toMatch(/[<>@\n]/);
		expect(r.note?.length).toBeLessThanOrEqual(200);
	});

	it("names an unknown key without echoing markup or mentions", async () => {
		const { octokit } = fakeOctokit(async () =>
			file('version: 1\n"<img src=x>": 1\n"@someone": 2\n'),
		);
		const r = await run(octokit);
		expect(r.note).toMatch(/unrecognized_keys/);
		expect(r.note).not.toContain("<img");
		expect(r.note).not.toContain("@someone");
		expect(r.note).not.toMatch(/[<>@ ]\S*=/);
	});

	it("never lets a key in a note look like a link", async () => {
		const root = fakeOctokit(async () =>
			file('version: 1\n"www.evil.com": 1\n'),
		);
		const rootNote = (await run(root.octokit)).note ?? "";
		expect(rootNote).toMatch(/unrecognized_keys/);
		expect(rootNote).not.toContain("www.");
		const nested = fakeOctokit(async () =>
			file('version: 1\nreview:\n  "www.evil.com": 1\n'),
		);
		const nestedNote = (await run(nested.octokit)).note ?? "";
		expect(nestedNote).toContain("review");
		expect(nestedNote).not.toContain("www.");
		expect(nestedNote).not.toMatch(/invalid at \S*\./);
	});

	it("logs a non-404 API failure with owner, repo and status only", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { octokit } = fakeOctokit(async () => {
			throw Object.assign(new Error("secret body"), { status: 502 });
		});
		await run(octokit);
		expect(warn).toHaveBeenCalledWith("repo config fetch failed", {
			owner: "o",
			repo: "r",
			status: 502,
		});
		expect(JSON.stringify(warn.mock.calls)).not.toContain("secret body");
		warn.mockRestore();
	});

	it("logs KV read and write failures at warn without the error object", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const kv = {
			get: async () => {
				throw new Error("kv-secret");
			},
			set: async () => {
				throw new Error("kv-secret");
			},
		};
		const { octokit } = fakeOctokit(async () => file("version: 1\n"));
		await fetchRepoConfig({ octokit, owner: "o", repo: "r", kv });
		expect(warn).toHaveBeenCalledWith("repo config cache read failed", {
			owner: "o",
			repo: "r",
		});
		expect(warn).toHaveBeenCalledWith("repo config cache write failed", {
			owner: "o",
			repo: "r",
		});
		expect(JSON.stringify(warn.mock.calls)).not.toContain("kv-secret");
		warn.mockRestore();
	});
});
