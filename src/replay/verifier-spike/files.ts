import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

const inFlight = new Map<string, Promise<string | null>>();

/**
 * A file as it was at `sha`, read through `fetcher` once and kept on disk. The cache key is a hash
 * of the whole reference, so a path like `../x` cannot leave the directory. Callers that ask for
 * the same file at the same time share one fetch, and the file is written to a temporary name and
 * renamed into place, so a reader never sees a partial file. A missing file (`null`) is not
 * cached, so a later run asks again.
 */
export function fetchHeadFile(
	ref: FileRef,
	fetcher: FileFetcher,
	cacheDir: string,
): Promise<string | null> {
	const path = cachePath(cacheDir, ref);
	const pending = inFlight.get(path);
	if (pending) return pending;
	const work = load(path, ref, fetcher, cacheDir).finally(() =>
		inFlight.delete(path),
	);
	inFlight.set(path, work);
	return work;
}

async function load(
	path: string,
	ref: FileRef,
	fetcher: FileFetcher,
	cacheDir: string,
): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		// not cached yet
	}
	const content = await fetcher(ref);
	if (content === null) return null;
	await mkdir(join(cacheDir, "files"), { recursive: true });
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(temp, content, "utf8");
	await rename(temp, path);
	return content;
}
