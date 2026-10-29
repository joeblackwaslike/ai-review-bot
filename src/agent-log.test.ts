import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AgentRecord,
	disableAgentLogFile,
	enableAgentLogFile,
	formatAgentsMarker,
	logAgentRecords,
	parseAgentsMarker,
	toRecord,
} from "./agent-log.js";

const KNOWN = new Set(["code-reviewer.md", "security-sast.md", "a.md"]);
const FOOTER = "\n\n---\n*Model: x*\n";

const ok = (skill: string, attempt: 1 | 2 = 1): AgentRecord => ({
	skill,
	attempt,
	status: "ok",
	durationMs: 10,
	inputTokens: 1,
	outputTokens: 2,
});
const err = (skill: string): AgentRecord => ({
	skill,
	attempt: 1,
	status: "error",
	class: "network",
	retryable: true,
	errorName: "Error",
	durationMs: 5,
});
const body = (line: string) => `summary${"\n\n"}${line}${FOOTER}`;

describe("agents marker", () => {
	it("round trips records and pending", () => {
		const records = [ok("code-reviewer.md"), err("security-sast.md")];
		const line = formatAgentsMarker(records, ["a.md"], KNOWN);
		expect(line.startsWith("<!-- ai-review:agents=")).toBe(true);
		expect(parseAgentsMarker(body(line), KNOWN)).toEqual({
			records,
			pending: ["a.md"],
		});
	});

	it("drops unknown skills, unknown error names and bad numbers", () => {
		const line = formatAgentsMarker(
			[
				ok("code-reviewer.md"),
				ok("evil.md"),
				{ ...err("a.md"), errorName: "Nope" as never },
				{ ...ok("a.md"), durationMs: -1 },
			],
			["evil.md", "a.md"],
			new Set([...KNOWN, "evil.md"]),
		);
		expect(parseAgentsMarker(body(line), KNOWN)).toEqual({
			records: [ok("code-reviewer.md")],
			pending: ["a.md"],
		});
	});

	it("returns null when nothing valid parses", () => {
		const line = formatAgentsMarker([ok("evil.md")], [], new Set(["evil.md"]));
		expect(parseAgentsMarker(body(line), KNOWN)).toBeNull();
		expect(parseAgentsMarker("no marker", KNOWN)).toBeNull();
	});

	it("never emits --> or raw angle brackets inside the value", () => {
		const line = formatAgentsMarker(
			[{ ...err("a.md"), finishReason: "-->x<b>" }],
			[],
			KNOWN,
		);
		const inner = line.slice("<!-- ai-review:agents=".length, -" -->".length);
		expect(inner).not.toMatch(/-->|<|>/);
		expect(line.endsWith(" -->")).toBe(true);
		expect(line.match(/-->/g)).toHaveLength(1);
		expect(parseAgentsMarker(body(line), KNOWN)?.records[0]?.finishReason).toBe(
			"-->x<b>",
		);
	});

	it("keeps all non-ok records and pending when oversized, dropping ok first", () => {
		const oks = Array.from({ length: 30 }, () => ok("code-reviewer.md"));
		const errs = Array.from({ length: 5 }, () => err("a.md"));
		const pending = ["a.md", "code-reviewer.md", "security-sast.md"];
		const line = formatAgentsMarker([...oks, ...errs], pending, KNOWN);
		const parsed = parseAgentsMarker(body(line), KNOWN);
		expect(parsed?.records.filter((r) => r.status !== "ok")).toHaveLength(5);
		expect(parsed?.records.length).toBeLessThanOrEqual(20);
		expect(parsed?.pending).toEqual(pending);
		expect(line.length).toBeLessThanOrEqual(4096 + 64);
	});

	it("drops retried first attempts before other ok records", () => {
		const records = [
			ok("a.md", 1),
			ok("a.md", 2),
			...Array.from({ length: 19 }, () => ok("security-sast.md")),
		];
		const parsed = parseAgentsMarker(
			body(formatAgentsMarker(records, [], KNOWN)),
			KNOWN,
		);
		expect(parsed?.records).toHaveLength(20);
		expect(
			parsed?.records.some((r) => r.skill === "a.md" && r.attempt === 1),
		).toBe(false);
	});

	it("ignores quoted, mid-text and duplicated markers", () => {
		const line = formatAgentsMarker([ok("a.md")], [], KNOWN);
		expect(
			parseAgentsMarker(`> ${line}\n\n---\n*Model: x*\n`, KNOWN),
		).toBeNull();
		expect(
			parseAgentsMarker(`${line}\n\ntail text\n${FOOTER}`, KNOWN),
		).toBeNull();
		expect(parseAgentsMarker(body(`${line}\n${line}`), KNOWN)).toBeNull();
	});

	it("never copies model text, response or cause content", () => {
		const outcome = {
			status: "error",
			failure: { class: "unknown", retryable: false, errorName: "Error" },
			durationMs: 1,
			text: "SECRET-TEXT",
			response: "SECRET-RESPONSE",
			cause: "SECRET-CAUSE",
			message: "SECRET-MSG",
		} as never;
		const rec = toRecord("a.md", 1, outcome);
		const line = formatAgentsMarker([rec], [], KNOWN);
		expect(JSON.stringify(rec)).not.toMatch(/SECRET/);
		expect(line).not.toMatch(/SECRET/);
	});
});

describe("toRecord", () => {
	it("maps usage names", () => {
		expect(
			toRecord("a.md", 2, {
				status: "ok",
				usage: { promptTokens: 7, completionTokens: 9 },
				durationMs: 3,
			}),
		).toEqual({
			skill: "a.md",
			attempt: 2,
			status: "ok",
			durationMs: 3,
			inputTokens: 7,
			outputTokens: 9,
		});
	});

	it("flattens failure and optional usage on error", () => {
		expect(
			toRecord("a.md", 1, {
				status: "error",
				failure: {
					class: "transient_http",
					retryable: true,
					httpStatus: 503,
					errorName: "AI_APICallError",
				},
				usage: { promptTokens: 1, completionTokens: 0 },
				durationMs: 4,
			}),
		).toEqual({
			skill: "a.md",
			attempt: 1,
			status: "error",
			class: "transient_http",
			retryable: true,
			httpStatus: 503,
			errorName: "AI_APICallError",
			durationMs: 4,
			inputTokens: 1,
			outputTokens: 0,
		});
	});

	it("keeps only status for rate_limited, quota_exhausted, skipped", () => {
		expect(toRecord("a.md", 1, { status: "rate_limited" })).toEqual({
			skill: "a.md",
			attempt: 1,
			status: "rate_limited",
		});
		expect(toRecord("a.md", 1, { status: "skipped" }).status).toBe("skipped");
		expect(toRecord("a.md", 1, { status: "quota_exhausted" }).status).toBe(
			"quota_exhausted",
		);
	});
});

describe("logAgentRecords", () => {
	let dir: string;
	let file: string;
	const ctx = {
		owner: "o",
		repo: "r",
		pr: 4,
		sha: "abc",
		provider: "anthropic",
		model: "m",
		messages: { "a.md": "x".repeat(500) },
	};

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "agent-log-"));
		file = join(dir, "sub", "agents.jsonl");
	});
	afterEach(async () => {
		disableAgentLogFile();
		vi.restoreAllMocks();
		await rm(dir, { recursive: true, force: true });
	});

	it("calls console.log once per record", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		logAgentRecords([ok("a.md"), err("a.md")], ctx);
		expect(spy).toHaveBeenCalledTimes(2);
		expect(spy.mock.calls[0]?.[0]).toBe("agent outcome");
		expect(spy.mock.calls[0]?.[1]).toMatchObject({ skill: "a.md", pr: 4 });
	});

	it("writes nothing when disabled", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		logAgentRecords([ok("a.md")], ctx);
		await expect(readFile(file)).rejects.toThrow();
	});

	it("appends JSON lines with ts, ids and a 300-char message when enabled", async () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		enableAgentLogFile(file);
		logAgentRecords([err("a.md"), ok("code-reviewer.md")], ctx);
		const lines = (await readFile(file, "utf8")).trim().split("\n");
		expect(lines).toHaveLength(2);
		const first = JSON.parse(lines[0] ?? "");
		expect(first).toMatchObject({
			owner: "o",
			repo: "r",
			pr: 4,
			sha: "abc",
			provider: "anthropic",
			model: "m",
			skill: "a.md",
			status: "error",
		});
		expect(Number.isNaN(Date.parse(first.ts))).toBe(false);
		expect(first.message).toHaveLength(300);
		expect(JSON.parse(lines[1] ?? "").message).toBeUndefined();
	});

	it("swallows write errors", () => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		enableAgentLogFile(join(dir, "file-as-dir"));
		enableAgentLogFile(join(dir, "\0bad"));
		expect(() => logAgentRecords([ok("a.md")], ctx)).not.toThrow();
		expect(errSpy).toHaveBeenCalled();
	});
});
