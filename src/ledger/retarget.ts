import { findingId, type PersistedFinding } from "../review-state.js";

export interface PathFile {
	filename: string;
	previous_filename?: string;
}

export interface RetargetResult {
	kept: PersistedFinding[];
	retired: PersistedFinding[];
}

/** Maps carried findings through PR renames; a finding whose file left the PR is retired. */
export function retargetCarried(
	prior: readonly PersistedFinding[],
	files: readonly PathFile[],
): RetargetResult {
	const present = new Set(files.map((f) => f.filename));
	const renamed = new Map<string, string>();
	for (const f of files) {
		if (f.previous_filename) renamed.set(f.previous_filename, f.filename);
	}
	const kept: PersistedFinding[] = [];
	const retired: PersistedFinding[] = [];
	for (const finding of prior) {
		const { path } = finding;
		if (path === null || present.has(path)) {
			kept.push(finding);
			continue;
		}
		const next = renamed.get(path);
		if (next === undefined) {
			retired.push(finding);
			continue;
		}
		kept.push({
			...finding,
			path: next,
			id: findingId(next, finding.line, finding.title),
		});
	}
	return { kept, retired };
}
