import type { PushFile } from "../moved-blocks.js";
import { classifyFile } from "../push-shape.js";
import type { FileNode, HunkRef } from "./types.js";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;

function parseHunks(patch: string | undefined): HunkRef[] {
	if (!patch) return [];
	return [...patch.matchAll(HUNK_HEADER)].map((m) => ({
		oldStart: Number(m[1]),
		oldLines: m[2] === undefined ? 1 : Number(m[2]),
		newStart: Number(m[3]),
		newLines: m[4] === undefined ? 1 : Number(m[4]),
	}));
}

/** One node per file of the push, with its kind and hunk ranges. */
export function buildFileNodes(files: PushFile[]): FileNode[] {
	return files.map((f) => ({
		filename: f.filename,
		...(f.previous_filename ? { previousFilename: f.previous_filename } : {}),
		status: f.status,
		kind: classifyFile(f.filename),
		hunks: parseHunks(f.patch),
		shown: "full",
	}));
}
