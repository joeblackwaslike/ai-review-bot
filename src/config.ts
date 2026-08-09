export interface AppConfig {
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
	/** Milliseconds between peer-check passes (env var is in seconds, converted
	 * at parse time). Short, because the point is to notice peers arriving
	 * rather than to wait out a worst case. */
	peerCheckIntervalMs: number;
	/** How many passes before reviewing regardless. Bounds the wait so a peer
	 * that never arrives cannot starve the review entirely. */
	peerMaxAttempts: number;
	/** Master switch for the improvement corpus. Off by default so a deployment
	 * without DATABASE_URL behaves exactly as before. */
	improveEnabled: boolean;
	/** Post the carrier issue comment that lets the top-level review be rated.
	 * Separate from improveEnabled because it adds a visible comment to every
	 * PR, which is worth being able to turn off on its own. */
	improveCarrierEnabled: boolean;
	agentConcurrency: number;
	agentBudgetMs: number;
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

// Returns the first argument that is a non-blank string after trimming, else
// the final argument. Treats "" / whitespace-only env values as unset so a
// blank prefix can't make `body.includes(prefix)` match everything.
function firstNonBlank(...values: Array<string | undefined>): string {
	for (const v of values) {
		const trimmed = v?.trim();
		if (trimmed) return trimmed;
	}
	return values[values.length - 1] ?? "";
}

function getRequiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

function normalizePrivateKey(raw: string): string {
	return raw.replaceAll(String.raw`\n`, "\n");
}

function validatePrivateKey(key: string): string {
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
 * Sized under the Vercel function `maxDuration` for the review routes (800s) so
 * the run can merge and submit what it has instead of being killed mid-flight
 * with nothing posted. Deep-tier PRs run eight agents at 150-300s each, which
 * does not fit; a partial review does. */
export function parseAgentBudgetMs(): number {
	const raw = Number(process.env.REVIEW_AGENT_BUDGET_SECONDS ?? "600");
	// Rounded in milliseconds, not seconds. Flooring seconds first turned any
	// sub-second value into a 0ms budget, which passes the positive check above
	// and then skips every agent — a review that silently does nothing.
	const ms = Number.isFinite(raw) && raw > 0 ? Math.floor(raw * 1000) : 600_000;
	return Math.max(1, ms);
}

export function parseAgentConcurrency(): number {
	return Math.max(
		1,
		Math.floor(Number(process.env.AGENT_CONCURRENCY ?? "1")) || 1,
	);
}

// Parse a delay env var expressed in seconds into milliseconds. A missing,
// blank, non-numeric, or negative value falls back to the default: a bare
// Number() would yield NaN (or a negative), and setTimeout(fn, NaN) fires
// immediately — silently defeating the dedup wait this delay exists to provide.
export function parseDelayMs(
	envValue: string | undefined,
	defaultSeconds: number,
): number {
	const seconds = Number(envValue);
	if (envValue?.trim() && Number.isFinite(seconds) && seconds >= 0) {
		return seconds * 1000;
	}
	return defaultSeconds * 1000;
}

export function getConfig(): AppConfig {
	return {
		appId: getRequiredEnv("GITHUB_APP_ID"),
		privateKey: validatePrivateKey(
			normalizePrivateKey(getRequiredEnv("GITHUB_APP_PRIVATE_KEY")),
		),
		webhookSecret: getRequiredEnv("GITHUB_WEBHOOK_SECRET"),
		reviewEnabled: process.env.REVIEW_ENABLED !== "false",
		reviewDelayMs: parseDelayMs(process.env.REVIEW_DELAY_SECONDS, 540),
		reviewResyncDelayMs: parseDelayMs(
			process.env.REVIEW_RESYNC_DELAY_SECONDS,
			300,
		),
		reviewCommentPrefix: firstNonBlank(
			process.env.REVIEW_COMMENT_PREFIX,
			"ai-review-bot",
		),
		reviewCommand: process.env.REVIEW_COMMAND ?? "/ai-review",
		provider: "anthropic",
		feedbackEnabled: process.env.FEEDBACK_ENABLED === "true",
		peerCheckIntervalMs: parsePositiveMs(
			process.env.PEER_CHECK_INTERVAL_SECONDS,
			90_000,
		),
		peerMaxAttempts: parsePositiveInt(process.env.PEER_MAX_ATTEMPTS, 6),
		improveEnabled: process.env.IMPROVE_ENABLED === "true",
		improveCarrierEnabled: process.env.IMPROVE_CARRIER_ENABLED !== "false",
		agentConcurrency: parseAgentConcurrency(),
		agentBudgetMs: parseAgentBudgetMs(),
		tier2Enabled: process.env.REVIEW_TIER2_ENABLED !== "false",
		qstashToken: process.env.QSTASH_TOKEN,
		qstashCurrentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
		qstashNextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
		qstashUrl: process.env.QSTASH_URL,
		publicUrl: process.env.PUBLIC_URL,
	};
}

export function getOpenAIAppConfig(): AppConfig {
	return {
		appId: getRequiredEnv("OPENAI_APP_ID"),
		privateKey: validatePrivateKey(
			normalizePrivateKey(getRequiredEnv("OPENAI_APP_PRIVATE_KEY")),
		),
		webhookSecret: getRequiredEnv("OPENAI_APP_WEBHOOK_SECRET"),
		reviewEnabled: process.env.REVIEW_ENABLED !== "false",
		reviewDelayMs: parseDelayMs(process.env.REVIEW_DELAY_SECONDS, 540),
		reviewResyncDelayMs: parseDelayMs(
			process.env.REVIEW_RESYNC_DELAY_SECONDS,
			300,
		),
		reviewCommentPrefix: firstNonBlank(
			process.env.OPENAI_REVIEW_COMMENT_PREFIX,
			process.env.REVIEW_COMMENT_PREFIX,
			"codex-review-bot",
		),
		reviewCommand: process.env.REVIEW_COMMAND ?? "/ai-review",
		provider: "openai",
		feedbackEnabled: process.env.FEEDBACK_ENABLED === "true",
		peerCheckIntervalMs: parsePositiveMs(
			process.env.PEER_CHECK_INTERVAL_SECONDS,
			90_000,
		),
		peerMaxAttempts: parsePositiveInt(process.env.PEER_MAX_ATTEMPTS, 6),
		improveEnabled: process.env.IMPROVE_ENABLED === "true",
		improveCarrierEnabled: process.env.IMPROVE_CARRIER_ENABLED !== "false",
		agentConcurrency: parseAgentConcurrency(),
		agentBudgetMs: parseAgentBudgetMs(),
		tier2Enabled: process.env.REVIEW_TIER2_ENABLED !== "false",
		qstashToken: process.env.QSTASH_TOKEN,
		qstashCurrentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
		qstashNextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
		qstashUrl: process.env.QSTASH_URL,
		publicUrl: process.env.PUBLIC_URL,
	};
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

/** Seconds → ms, falling back on anything unparseable or non-positive. A zero
 * or negative interval would busy-loop the scheduler. */
export function parsePositiveMs(
	raw: string | undefined,
	fallbackMs: number,
): number {
	if (raw === undefined || raw.trim() === "") return fallbackMs;
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) {
		console.warn(`config: invalid interval "${raw}"; using ${fallbackMs}ms`);
		return fallbackMs;
	}
	const ms = Math.floor(n * 1000);
	if (ms <= 0) {
		console.warn(`config: invalid interval "${raw}"; using ${fallbackMs}ms`);
		return fallbackMs;
	}
	return ms;
}

export function parsePositiveInt(
	raw: string | undefined,
	fallback: number,
): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) {
		console.warn(`config: invalid count "${raw}"; using ${fallback}`);
		return fallback;
	}
	return n;
}
