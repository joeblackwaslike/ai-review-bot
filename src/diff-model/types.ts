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

export type DivergenceClass =
	| "comment-only"
	| "rename"
	| "signature"
	| "receiver"
	| "code";

export interface Divergence {
	kind: "changed" | "inserted" | "removed";
	class: DivergenceClass;
	base?: Span;
	head?: Span;
	original?: string;
}

export interface Operation {
	id: string;
	type: "relocation" | "rename" | "mechanical" | "copy";
	from: Span[];
	to: Span[];
	exact: boolean;
	divergences: Divergence[];
	reviewWeight: number;
	/** Why a mechanical operation is mechanical. Required for a mechanical operation, which is not rendered without it. */
	reason?: "whitespace" | "imports";
	/**
	 * Shape of a relocation beyond its text. `reindent` is the head block's indentation minus
	 * the base block's, in columns, set only when it is not 0. `sourceNew` is reserved for copy
	 * operations and is not set by relocations.
	 */
	shape?: { reindent?: number; sourceNew?: boolean };
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
