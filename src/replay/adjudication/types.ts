export type Verdict = "real" | "not-real" | "unclear";
export type Scope = "change" | "moved" | null;
export type JudgeFamily = "anthropic" | "openai";
export type VerdictStatus = "agreed" | "unresolved" | "single-family";

export interface JudgeRecord {
	family: JudgeFamily;
	model: string;
	promptHash: string;
}

export interface VerdictRecord {
	kind?: "verdict";
	verdict: Verdict;
	scope: Scope;
	reason: string;
	first: JudgeRecord;
	second: JudgeRecord | null;
	secondVerdict: Verdict | null;
	status: VerdictStatus;
}
