import type { FileKind } from "../push-shape.js";

export type Shown = "full" | "partial" | "none";

export type CodeRole =
	| "utility"
	| "domain-model"
	| "controller"
	| "auth"
	| "job"
	| "migration"
	| "test-helper"
	| "entry-point";

/** A hunk's old and new line ranges, from its `@@ -a,b +c,d @@` header. */
export interface HunkRef {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
}

export interface FileNode {
	filename: string;
	previousFilename?: string;
	status: string;
	kind: FileKind;
	role?: CodeRole;
	hunks: HunkRef[];
	shown: Shown;
}

export interface Span {
	filename: string;
	side: "base" | "head";
	startLine: number;
	endLine: number;
	shown: Shown;
}

export type DivergenceClass = "comment-only" | "rename" | "code";

export interface Divergence {
	kind: "changed" | "inserted" | "removed";
	class: DivergenceClass;
	base?: Span;
	head?: Span;
	original?: string;
}

export interface Operation {
	id: string;
	type: "relocation" | "rename" | "mechanical";
	from: Span[];
	to: Span[];
	exact: boolean;
	divergences: Divergence[];
	reviewWeight: number;
}

/** A phrase of stated intent and the PR text span it came from. */
export interface IntentClaim {
	phrase: string;
	source: "title" | "body";
	start: number;
	end: number;
}

export interface PrFacts {
	testsChanged: boolean | "unknown";
	intentClaims: IntentClaim[];
}

export interface DiffModel {
	files: FileNode[];
	operations: Operation[];
	facts: PrFacts;
	droppedClaims: number;
}
