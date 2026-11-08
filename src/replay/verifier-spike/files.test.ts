import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fetchHeadFile } from "./files.js";

const ref = { owner: "o", repo: "r", path: "src/a.ts", sha: "abc123" };
const dir = () => mkdtempSync(join(tmpdir(), "verifier-files-"));

describe("fetchHeadFile", () => {
	it("fetches once and serves the second read from the cache", async () => {
		const cacheDir = dir();
		const fetcher = vi.fn(async () => "file body");
		expect(await fetchHeadFile(ref, fetcher, cacheDir)).toBe("file body");
		expect(await fetchHeadFile(ref, fetcher, cacheDir)).toBe("file body");
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("keeps a separate cache entry per sha and per path", async () => {
		const cacheDir = dir();
		const fetcher = vi.fn(async (r: typeof ref) => `${r.sha}:${r.path}`);
		expect(await fetchHeadFile(ref, fetcher, cacheDir)).toBe("abc123:src/a.ts");
		expect(
			await fetchHeadFile({ ...ref, sha: "def456" }, fetcher, cacheDir),
		).toBe("def456:src/a.ts");
		expect(
			await fetchHeadFile({ ...ref, path: "src/b.ts" }, fetcher, cacheDir),
		).toBe("abc123:src/b.ts");
		expect(fetcher).toHaveBeenCalledTimes(3);
	});

	it("returns null for a missing file and tries again next time", async () => {
		const cacheDir = dir();
		const fetcher = vi.fn(async () => null);
		expect(await fetchHeadFile(ref, fetcher, cacheDir)).toBeNull();
		expect(await fetchHeadFile(ref, fetcher, cacheDir)).toBeNull();
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("does not let a path escape the cache directory", async () => {
		const cacheDir = dir();
		const fetcher = vi.fn(async () => "x");
		await expect(
			fetchHeadFile({ ...ref, path: "../../etc/passwd" }, fetcher, cacheDir),
		).resolves.toBe("x");
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
});
