import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface FileRef {
	owner: string;
	repo: string;
	path: string;
	sha: string;
}

export type FileFetcher = (ref: FileRef) => Promise<string | null>;

function cachePath(cacheDir: string, ref: FileRef): string {
	const digest = createHash("sha256")
		.update(`${ref.owner}/${ref.repo}@${ref.sha}:${ref.path}`)
		.digest("hex");
	return join(cacheDir, "files", `${digest}.txt`);
}

/**
 * A file as it was at `sha`, read through `fetcher` once and kept on disk. The cache key is a hash
 * of the whole reference, so a path like `../x` cannot leave the directory. A missing file
 * (`null`) is not cached, so a later run asks again.
 */
export async function fetchHeadFile(
	ref: FileRef,
	fetcher: FileFetcher,
	cacheDir: string,
): Promise<string | null> {
	const path = cachePath(cacheDir, ref);
	try {
		return await readFile(path, "utf8");
	} catch {
		// not cached yet
	}
	const content = await fetcher(ref);
	if (content === null) return null;
	await mkdir(join(cacheDir, "files"), { recursive: true });
	await writeFile(path, content, "utf8");
	return content;
}
