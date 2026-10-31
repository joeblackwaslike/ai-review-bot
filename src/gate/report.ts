import type { LedgerEntry } from "../ledger/types.js";

export type GateSeverity = "error" | "warning" | "info";
export type GateAction = "ask-user" | "no-op";

export type GateFinding = {
	id: string;
	severity: GateSeverity;
	description: string;
	file?: string;
	line?: number;
	action: GateAction;
};

const MAX_FINDINGS = 500;
const MAX_BYTES = 1024 * 1024;
const SEVERITIES = ["error", "warning", "info"];
const ACTIONS = ["auto-fix", "ask-user", "no-op"];
const KNOWN_FIELDS = new Set([
	"id",
	"severity",
	"description",
	"file",
	"line",
	"action",
]);

export function toGateFinding(
	entry: LedgerEntry,
	suggestion?: string | null,
): GateFinding {
	const info = entry.severity === "P3";
	const warning = entry.severity === "P2";
	const description = [entry.title, entry.body, suggestion]
		.filter((p): p is string => typeof p === "string" && p.trim() !== "")
		.join("\n\n");
	return {
		id: entry.id,
		severity: info ? "info" : warning ? "warning" : "error",
		description,
		...(entry.path ? { file: entry.path } : {}),
		...(entry.path && entry.line !== null ? { line: entry.line } : {}),
		action: info ? "no-op" : "ask-user",
	};
}

export function capFindings(
	findings: GateFinding[],
	max = MAX_FINDINGS,
): { kept: GateFinding[]; dropped: number } {
	let excess = findings.length - max;
	if (excess <= 0) return { kept: findings, dropped: 0 };
	const dropIdx = new Set<number>();
	for (const sev of ["info", "warning", "error"] as const) {
		for (let i = findings.length - 1; i >= 0 && excess > 0; i--) {
			if (findings[i]?.severity === sev) {
				dropIdx.add(i);
				excess--;
			}
		}
	}
	return {
		kept: findings.filter((_, i) => !dropIdx.has(i)),
		dropped: dropIdx.size,
	};
}

export function formatReport(findings: GateFinding[]): string {
	return JSON.stringify({ findings });
}

export function validateReport(json: string): string[] {
	if (Buffer.byteLength(json, "utf8") > MAX_BYTES) {
		return ["report exceeds 1 MiB"];
	}
	let doc: unknown;
	try {
		doc = JSON.parse(json);
	} catch {
		return ["report is not valid JSON"];
	}
	if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
		return ["report must be an object"];
	}
	const rest = Object.keys(doc).filter((k) => k !== "findings");
	const list = (doc as { findings?: unknown }).findings;
	if (!Array.isArray(list)) return ["findings must be an array"];
	const problems = rest.map((k) => `unknown top-level field "${k}"`);
	if (list.length > MAX_FINDINGS) {
		problems.push(`more than ${MAX_FINDINGS} findings (${list.length})`);
	}
	const seen = new Set<string>();
	list.forEach((raw, i) => {
		const at = `findings[${i}]`;
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			problems.push(`${at} must be an object`);
			return;
		}
		const f = raw as Record<string, unknown>;
		for (const k of Object.keys(f)) {
			if (!KNOWN_FIELDS.has(k)) problems.push(`${at} has unknown field "${k}"`);
		}
		if (typeof f.id !== "string" || f.id === "") {
			problems.push(`${at}.id must be a non-empty string`);
		} else {
			if (f.id.includes(","))
				problems.push(`${at}.id must not contain a comma`);
			if (seen.has(f.id)) problems.push(`${at}.id "${f.id}" is duplicated`);
			seen.add(f.id);
		}
		if (typeof f.severity !== "string" || !SEVERITIES.includes(f.severity)) {
			problems.push(`${at}.severity must be one of ${SEVERITIES.join(", ")}`);
		}
		if (typeof f.description !== "string" || f.description === "") {
			problems.push(`${at}.description must be a non-empty string`);
		}
		if (f.file !== undefined && typeof f.file !== "string") {
			problems.push(`${at}.file must be a string`);
		}
		if (
			f.line !== undefined &&
			(typeof f.line !== "number" || !Number.isInteger(f.line) || f.line < 0)
		) {
			problems.push(`${at}.line must be a non-negative integer`);
		}
		if (
			f.action !== undefined &&
			(typeof f.action !== "string" || !ACTIONS.includes(f.action))
		) {
			problems.push(`${at}.action must be one of ${ACTIONS.join(", ")}`);
		}
	});
	return problems;
}
