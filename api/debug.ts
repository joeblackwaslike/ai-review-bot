import { createHash, timingSafeEqual } from "node:crypto";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getEffectiveConfig } from "../src/config/edge.js";
import { describeSecrets, envNameForPath } from "../src/config/env.js";
import { describeConfig, getLoadedConfig } from "../src/config/load.js";

const REDACTED_PATHS = new Set(["review.customPrompt"]);
const REDACTED_PREFIXES = ["cli.", "infra."];

function isRedacted(path: string): boolean {
	return (
		REDACTED_PATHS.has(path) ||
		REDACTED_PREFIXES.some((prefix) => path.startsWith(prefix))
	);
}
const MAX_CONFIG_ERROR_LENGTH = 300;

export function sanitizeConfigError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const redacted = message
		.replace(/\b(got\s+)"[\s\S]*$/, '$1"[redacted]"')
		.replace(/\b(value\s+)"[\s\S]*$/, '$1"[redacted]"');
	const withoutValues = redacted.split(/[\r\n\u2028\u2029]/)[0] ?? "";
	const withoutPaths = withoutValues.replace(
		/(^|[\s"'(=:])\/[^\s"']+/g,
		(match, boundary: string) => {
			const path = match.slice(boundary.length);
			const base = path.split("/").pop();
			return base && base.length > 0 ? `${boundary}${base}` : match;
		},
	);
	return withoutPaths.slice(0, MAX_CONFIG_ERROR_LENGTH);
}

function isAuthorized(authorization: string | undefined): boolean {
	const secret = process.env.CRON_SECRET;
	if (!secret || !authorization) return false;
	const digest = (value: string) => createHash("sha256").update(value).digest();
	return timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
	const hasFields = {
		hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
		hasAppId: !!process.env.GITHUB_APP_ID,
		hasPrivateKey: !!process.env.GITHUB_APP_PRIVATE_KEY,
		hasWebhookSecret: !!process.env.GITHUB_WEBHOOK_SECRET,
		hasOpenAIKey: !!process.env.OPENAI_API_KEY,
		hasOpenAIAppId: !!process.env.OPENAI_APP_ID,
		hasOpenAIPrivateKey: !!process.env.OPENAI_APP_PRIVATE_KEY,
		hasOpenAIWebhookSecret: !!process.env.OPENAI_APP_WEBHOOK_SECRET,
	};
	const authorized = isAuthorized(req.headers?.authorization);
	let loaded: ReturnType<typeof getLoadedConfig>;
	try {
		loaded = getLoadedConfig();
	} catch (error) {
		const sanitized = sanitizeConfigError(error);
		console.error(`config load failed: ${sanitized}`);
		res.status(200).json({
			...(authorized ? { configError: sanitized } : {}),
			...hasFields,
		});
		return;
	}
	const edgeEnabled = !!process.env.EDGE_CONFIG?.trim();
	let live: Awaited<ReturnType<typeof getEffectiveConfig>>;
	let liveError: string | undefined;
	try {
		live = await getEffectiveConfig();
	} catch (error) {
		liveError = sanitizeConfigError(error);
		console.error(`edge config failed: ${liveError}`);
		live = { config: loaded.config, applied: [], ignored: [] };
	}
	const effective = live.config;
	const appliedKeys = new Set(live.applied);
	if (!authorized) {
		res.status(200).json({
			reviewEnabled: effective.review.enabled,
			reviewCommand: effective.review.command,
			...hasFields,
		});
		return;
	}
	const edgeError =
		liveError ?? (live.error && sanitizeConfigError(live.error));
	res.status(200).json({
		edge: {
			enabled: edgeEnabled,
			applied: live.applied,
			ignored: live.ignored.map((i) => ({
				key: i.key,
				reason: sanitizeConfigError(i.reason),
			})),
			...(edgeError ? { error: edgeError } : {}),
		},
		config: describeConfig({ ...loaded, config: effective }).map((row) => {
			const sourced = appliedKeys.has(envNameForPath(row.path.split(".")))
				? { ...row, source: "edge" as const }
				: row;
			return isRedacted(row.path) && row.value !== undefined
				? { ...sourced, value: "[set]" }
				: sourced;
		}),
		warnings: loaded.warnings,
		secrets: describeSecrets(loaded.config, process.env),
		reviewers: Object.entries(effective.reviewers).map(([id, r]) => ({
			id,
			enabled: r.enabled,
		})),
		reviewEnabled: effective.review.enabled,
		reviewCommand: effective.review.command,
		...hasFields,
	});
}
