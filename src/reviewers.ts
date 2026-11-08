import { getEffectiveConfig } from "./config/edge.js";
import {
	ENV_ALIASES,
	type Env,
	envNameForPath,
	providerKeySpec,
	readSecret,
	reviewerSecretSpecs,
	type SecretSpec,
	SHARED_WEBHOOK_SECRET,
} from "./config/env.js";
import { getConfigTree } from "./config/load.js";
import type { Config } from "./config/schema.js";
import {
	type AppConfig,
	type GetConfigOptions,
	normalizePrivateKey,
	parseAgentBudgetMs,
	parseAgentConcurrency,
	parseDiffBudgetChars,
	validatePrivateKey,
} from "./config.js";
import { type ProviderName, splitModelId } from "./providers/names.js";
import type { LegacyProvider, ReviewerId } from "./reviewer-id.js";

export type { LegacyProvider, ReviewerId } from "./reviewer-id.js";

export type ReadinessMode = "hosted" | "cli";
export interface Readiness {
	ready: boolean;
	missing: string[];
}

export class UnknownReviewerError extends Error {
	constructor(id: string) {
		super(`Unknown reviewer: ${id}`);
		this.name = "UnknownReviewerError";
	}
}

export class ReviewerNotReadyError extends Error {
	readonly reviewerId: string;
	readonly missing: string[];
	constructor(reviewerId: string, missing: string[]) {
		super(`Reviewer ${reviewerId} is not ready: missing ${missing.join(", ")}`);
		this.name = "ReviewerNotReadyError";
		this.reviewerId = reviewerId;
		this.missing = missing;
	}
}

type ReviewerEntry = Config["reviewers"][string];

const CLI_AUTHENTICATED: readonly ProviderName[] = ["anthropic", "openai"];
const SKILL_TIERS = ["trivial", "normal", "complex", "deep"] as const;

function lookupReviewer(
	config: Pick<Config, "reviewers">,
	id: ReviewerId,
): ReviewerEntry | undefined {
	return Object.hasOwn(config.reviewers, id) ? config.reviewers[id] : undefined;
}

function requireReviewer(config: Config, id: ReviewerId): ReviewerEntry {
	const reviewer = lookupReviewer(config, id);
	if (!reviewer) throw new UnknownReviewerError(id);
	return reviewer;
}

const displayName = (spec: SecretSpec): string =>
	spec.aliases[0]?.name ?? spec.envName;

function appIdNames(id: ReviewerId): string[] {
	const path = ["reviewers", id, "appId"].join(".");
	const aliases = Object.entries(ENV_ALIASES)
		.filter(([, entry]) => entry.paths.some((p) => p.join(".") === path))
		.map(([name]) => name);
	return [envNameForPath(["reviewers", id, "appId"]), ...aliases];
}

const appIdName = (id: ReviewerId): string =>
	appIdNames(id)[1] ?? (appIdNames(id)[0] as string);

function readAppId(
	id: ReviewerId,
	env: Env,
	reviewer: ReviewerEntry | undefined,
): string | undefined {
	for (const name of appIdNames(id)) {
		const value = env[name]?.trim();
		if (value) return value;
	}
	return reviewer?.appId;
}

function reviewerSpecs(id: ReviewerId) {
	const [privateKey, webhookSecret] = reviewerSecretSpecs(id) as [
		SecretSpec,
		SecretSpec,
	];
	return { privateKey, webhookSecret };
}

function readWebhookSecret(id: ReviewerId, env: Env): string | undefined {
	return (
		readSecret(reviewerSpecs(id).webhookSecret, env).value ??
		readSecret(SHARED_WEBHOOK_SECRET, env).value
	);
}

export function listReviewerIds(): ReviewerId[] {
	return Object.keys(getConfigTree().reviewers);
}

export function reviewerProviders(
	config: Config,
	id: ReviewerId,
): ProviderName[] {
	const reviewer = requireReviewer(config, id);
	const models = Object.values(reviewer.tiers).map((t) => t.model);
	for (const name of ["summary", "triage", "revalidate"] as const) {
		const role = reviewer.roles?.[name] ?? config.roles?.[name];
		if (role) models.push(role.model);
	}
	for (const skill of Object.values(reviewer.skills ?? {})) {
		if (skill.model) models.push(skill.model);
		for (const tier of SKILL_TIERS) {
			const choice = skill[tier];
			if (choice) models.push(choice.model);
		}
	}
	return [...new Set(models.map((m) => splitModelId(m).provider))];
}

export function reviewerAuthProvider(
	config: Config,
	id: ReviewerId,
): LegacyProvider | null {
	const providers = reviewerProviders(config, id);
	const sole = providers.length === 1 ? providers[0] : undefined;
	return sole === "anthropic" || sole === "openai" ? sole : null;
}

export function reviewerReadiness(
	id: ReviewerId,
	mode: ReadinessMode,
	env: Env = process.env,
	config: Config = getConfigTree(),
): Readiness {
	const reviewer = requireReviewer(config, id);
	const missing: string[] = [];
	if (!reviewer.enabled) missing.push(`reviewers.${id}.enabled`);
	if (!readAppId(id, env, reviewer)) missing.push(appIdName(id));
	const specs = reviewerSpecs(id);
	if (readSecret(specs.privateKey, env).value === undefined) {
		missing.push(displayName(specs.privateKey));
	}
	if (mode === "hosted" && readWebhookSecret(id, env) === undefined) {
		missing.push(displayName(specs.webhookSecret));
	}
	missing.push(...missingProviderKeys(id, mode, env, config));
	return { ready: missing.length === 0, missing };
}

export function missingProviderKeys(
	id: ReviewerId,
	mode: ReadinessMode,
	env: Env = process.env,
	config: Config = getConfigTree(),
): string[] {
	const missing: string[] = [];
	for (const provider of reviewerProviders(config, id)) {
		if (mode === "cli" && CLI_AUTHENTICATED.includes(provider)) continue;
		const spec = providerKeySpec(provider);
		if (readSecret(spec, env).value === undefined) {
			missing.push(displayName(spec));
		}
	}
	return missing;
}

function requireValue(value: string | undefined, name: string): string {
	if (!value) throw new Error(`Missing required environment variable: ${name}`);
	return value;
}

export function buildAppConfig(
	id: ReviewerId,
	opts: GetConfigOptions = {},
	tree: Config = getConfigTree(),
): AppConfig {
	const requireWebhookSecret = opts.requireWebhookSecret ?? true;
	const review = tree.review;
	const reviewer = lookupReviewer(tree, id);
	const specs = reviewerSpecs(id);
	const privateKey = readSecret(specs.privateKey, process.env).value;
	const webhookSecret = readWebhookSecret(id, process.env);
	return {
		reviewer: id,
		appId: requireValue(readAppId(id, process.env, reviewer), appIdName(id)),
		appSlug: reviewer?.appSlug,
		privateKey: validatePrivateKey(
			normalizePrivateKey(
				requireValue(privateKey, displayName(specs.privateKey)),
			),
		),
		webhookSecret: requireWebhookSecret
			? requireValue(webhookSecret, displayName(specs.webhookSecret))
			: (webhookSecret ?? ""),
		reviewEnabled: review.enabled && (reviewer?.enabled ?? false),
		reviewDelayMs: review.delaySeconds * 1000,
		reviewResyncDelayMs: review.resyncDelaySeconds * 1000,
		reviewCommentPrefix: reviewer?.commentPrefix ?? `${id}-review-bot`,
		reviewCommand: review.command,
		feedbackEnabled: review.feedbackEnabled,
		improveEnabled: tree.improve.enabled,
		improveCarrierEnabled: tree.improve.carrierEnabled,
		agentConcurrency: reviewer?.concurrency ?? parseAgentConcurrency(tree),
		agentBudgetMs: parseAgentBudgetMs(tree),
		diffBudgetChars: parseDiffBudgetChars(tree),
		tier2Enabled: review.tier2Enabled,
		qstashToken: process.env.QSTASH_TOKEN,
		qstashCurrentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY,
		qstashNextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY,
		qstashUrl: tree.infra.qstashUrl,
		publicUrl: tree.infra.publicUrl,
	};
}

export function getReviewerAppConfig(
	id: ReviewerId,
	opts: GetConfigOptions = {},
): AppConfig {
	requireReviewer(getConfigTree(), id);
	return buildAppConfig(id, opts);
}

export async function getLiveReviewerAppConfig(
	id: ReviewerId,
	opts: GetConfigOptions = {},
): Promise<AppConfig> {
	const { config } = await getEffectiveConfig();
	requireReviewer(config, id);
	return buildAppConfig(id, opts, config);
}

const logged = new WeakSet<object>();

export function logReviewerReadiness(env: Env = process.env): void {
	const tree = getConfigTree();
	if (logged.has(tree)) return;
	logged.add(tree);
	for (const [id, reviewer] of Object.entries(tree.reviewers)) {
		if (!reviewer.enabled) continue;
		const { ready, missing } = reviewerReadiness(id, "hosted", env);
		if (!ready) {
			console.warn(`reviewer ${id} disabled: missing ${missing.join(", ")}`);
		}
	}
}
