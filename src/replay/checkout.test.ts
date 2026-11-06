import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type GitRunner,
	isCheckoutUnavailable,
	withCheckout,
} from "./checkout.js";

const run = promisify(execFile);

async function sh(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await run(
		"git",
		["-c", "user.name=t", "-c", "user.email=t@t", ...args],
		{ cwd },
	);
	return stdout.trim();
}

let root: string;
let origin: string;
let cache: string;

async function commit(file: string, content: string): Promise<string> {
	await writeFile(join(origin, file), content);
	await sh(origin, "add", ".");
	await sh(origin, "commit", "-m", `add ${file}`);
	return sh(origin, "rev-parse", "HEAD");
}

function recorder(): { git: GitRunner; calls: string[][] } {
	const calls: string[][] = [];
	const git: GitRunner = async (args, cwd) => {
		calls.push(args);
		const { stdout } = await run(
			"git",
			["-c", "user.name=t", "-c", "user.email=t@t", ...args],
			{ cwd },
		);
		return { stdout };
	};
	return { git, calls };
}

const exists = (p: string) =>
	access(p).then(
		() => true,
		() => false,
	);

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "checkout-test-"));
	origin = join(root, "origin");
	cache = join(root, "cache");
	await run("git", ["init", "-q", "-b", "main", origin]);
});

afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

describe("withCheckout", () => {
	it("clones on first use, fetches on the second, and checks out the head read-only", async () => {
		const base = await commit("a.txt", "one");
		const head1 = await commit("b.txt", "two");
		const { git, calls } = recorder();
		const opts = {
			owner: "o",
			repo: "r",
			cacheDir: cache,
			git,
			remoteUrl: async () => origin,
		};

		let seenPath = "";
		const seen = await withCheckout(
			{ ...opts, baseSha: base, headSha: head1 },
			async (h) => {
				seenPath = h.path;
				expect(h.headSha).toBe(head1);
				expect(await sh(h.path, "rev-parse", "HEAD")).toBe(head1);
				expect(await readFile(join(h.path, "b.txt"), "utf8")).toBe("two");
				await expect(
					writeFile(join(h.path, "b.txt"), "x"),
				).rejects.toMatchObject({ code: "EACCES" });
				return "ok";
			},
		);
		expect(seen).toBe("ok");
		expect(calls.some((c) => c[0] === "clone")).toBe(true);
		expect(await exists(seenPath)).toBe(false);

		const head2 = await commit("c.txt", "three");
		calls.length = 0;
		await withCheckout(
			{ ...opts, baseSha: head1, headSha: head2 },
			async (h) => {
				expect(await readFile(join(h.path, "c.txt"), "utf8")).toBe("three");
			},
		);
		expect(calls.some((c) => c[0] === "clone")).toBe(false);
		expect(calls.some((c) => c[0] === "fetch")).toBe(true);
	});

	it("removes the worktree when fn throws", async () => {
		const head = await commit("a.txt", "one");
		let seenPath = "";
		await expect(
			withCheckout(
				{
					owner: "o",
					repo: "r",
					baseSha: head,
					headSha: head,
					cacheDir: cache,
					remoteUrl: async () => origin,
				},
				async (h) => {
					seenPath = h.path;
					throw new Error("boom");
				},
			),
		).rejects.toThrow("boom");
		expect(await exists(seenPath)).toBe(false);
	});

	it("returns unavailable, without throwing, for a head that cannot be fetched", async () => {
		const base = await commit("a.txt", "one");
		let called = false;
		const result = await withCheckout(
			{
				owner: "o",
				repo: "r",
				baseSha: base,
				headSha: "0".repeat(40),
				cacheDir: cache,
				remoteUrl: async () => origin,
			},
			async () => {
				called = true;
			},
		);
		expect(called).toBe(false);
		expect(isCheckoutUnavailable(result)).toBe(true);
		if (isCheckoutUnavailable(result)) expect(result.reason).toMatch(/head/);
	});
});
