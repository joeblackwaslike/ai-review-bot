import { getConfigTree } from "./config/load.js";
import type { ReviewerId } from "./reviewer-id.js";
import { buildAppConfig } from "./reviewers.js";

export interface AppConfig {
	reviewer?: ReviewerId;
	appSlug?: string;
	appId: string;
	privateKey: string;
	webhookSecret: string;
	reviewEnabled: boolean;
	reviewDelayMs: number;
	reviewResyncDelayMs: number;
	reviewCommentPrefix: string;
	reviewCommand: string;
	provider: "anthropic" | "openai";
	feedbackEnabled: boolean;
	/** Master switch for the improvement corpus. Off by default so a deployment
	 * without DATABASE_URL behaves exactly as before. */
	improveEnabled: boolean;
	/** Post the carrier issue comment that lets the top-level review be rated.
	 * Opt-in: only the exact value IMPROVE_CARRIER_ENABLED=true enables it. It is
	 * separate from improveEnabled because it adds a visible comment to every PR. */
	improveCarrierEnabled: boolean;
	agentConcurrency: number;
	agentBudgetMs: number;
	/** PR-wide character budget for the numbered diff shown to agents. */
	diffBudgetChars: number;
	tier2Enabled: boolean;
	qstashToken?: string;
	qstashCurrentSigningKey?: string;
	qstashNextSigningKey?: string;
	/** QStash region endpoint (e.g. https://qstash-us-east-1.upstash.io). QStash
	 * is region-specific; the SDK default (qstash.upstash.io) routes to EU, so a
	 * US-region account must set this or publishes fail with "user not found". */
	qstashUrl?: string;
	publicUrl?: string;
}

function getRequiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

export function normalizePrivateKey(raw: string): string {
	return raw.replaceAll(String.raw`\n`, "\n");
}

/** Rejects a GitHub App private key in PKCS#1 format ("BEGIN RSA PRIVATE
 * KEY") — the App-auth JWT library requires PKCS#8 ("BEGIN PRIVATE KEY") and
 * fails on PKCS#1 with an error that doesn't point at the actual cause.
 * Does not normalize `\n`-escaping; returns `key` unchanged if it passes.
 * The error message text is asserted on in tests — treat it as part of this
 * function's contract, not just a log line. */
export function validatePrivateKey(key: string): string {
	if (key.includes("BEGIN RSA PRIVATE KEY")) {
		throw new Error(
			"GITHUB_APP_PRIVATE_KEY is in PKCS#1 format (BEGIN RSA PRIVATE KEY). " +
				"Convert to PKCS#8 before storing:\n" +
				"openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in key.pem -out key.pkcs8.pem",
		);
	}
	return key;
}

/** Wall-clock allowance for launching review agents, in ms.
 *
 * Sized under the Vercel Hobby `maxDuration` cap (300s) for the review routes,
 * leaving ~90s for fetching, the summary call, and the review POST. It is also
 * the hard deadline: an agent still running at the budget is aborted and
 * counted as skipped, so the run submits what it has instead of being killed
 * with nothing posted. */
export function parseAgentBudgetMs(): number {
	const seconds = getConfigTree().review.agentBudgetSeconds;
	// Rounded in milliseconds, not seconds. Flooring seconds first turned any
	// sub-second value into a 0ms budget, which skips every agent — a review
	// that silently does nothing.
	return Math.max(1, Math.floor(seconds * 1000));
}

/** `review.diffBudgetChars`: PR-wide character budget for the serialized diff. */
export function parseDiffBudgetChars(): number {
	return getConfigTree().review.diffBudgetChars;
}

/** Sequential agents cannot fit a review in the 300s Hobby cap (measured 212s at
 * 1 vs 75s at 4 on a 14-file diff, same cost, no 429s). Lower it if a provider's
 * input-tokens-per-minute limit starts rejecting the burst. */
export function parseAgentConcurrency(): number {
	return Math.floor(getConfigTree().review.agentConcurrency);
}

export interface GetConfigOptions {
	/** CLI-only call sites (cli.ts, watch.ts) never verify inbound webhooks and
	 * so never need this secret — requiring it there just forces a dev machine
	 * to hold a credential it will never use. Webhook-serving code (github-app.ts)
	 * must keep the default `true` unchanged. */
	requireWebhookSecret?: boolean;
}

export function getConfig(opts: GetConfigOptions = {}): AppConfig {
	return buildAppConfig("claude", opts);
}

export function getOpenAIAppConfig(opts: GetConfigOptions = {}): AppConfig {
	return buildAppConfig("codex", opts);
}

export interface QcAppConfig {
	appId: string;
	privateKey: string;
	webhookSecret: string;
	command: string;
	/** Distinct from the review bot's prefix so a QC report is visually
	 * separable from the review it is judging. */
	commentPrefix: string;
	/** Share of posted findings judged on a sampled (non-command) run. */
	sampleRate: number;
	enabled: boolean;
}

export function getQcAppConfig(): QcAppConfig {
	return {
		appId: getRequiredEnv("QC_APP_ID"),
		privateKey: validatePrivateKey(
			normalizePrivateKey(getRequiredEnv("QC_APP_PRIVATE_KEY")),
		),
		webhookSecret: getRequiredEnv("QC_APP_WEBHOOK_SECRET"),
		command: process.env.QC_COMMAND ?? "/qc",
		commentPrefix: process.env.QC_COMMENT_PREFIX ?? "ai-review-qc",
		sampleRate: parseSampleRate(process.env.IMPROVE_QC_SAMPLE_RATE),
		enabled: process.env.IMPROVE_QC_ENABLED !== "false",
	};
}

/** A rate outside 0..1 is a configuration mistake, not an instruction to judge
 * every finding on every PR — clamp rather than let a typo multiply spend. */
export function parseSampleRate(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === "") return 0.1;
	const n = Number(raw);
	if (!Number.isFinite(n)) {
		console.warn(
			`qc: IMPROVE_QC_SAMPLE_RATE="${raw}" is not a number; using 0.1`,
		);
		return 0.1;
	}
	return Math.min(1, Math.max(0, n));
}
