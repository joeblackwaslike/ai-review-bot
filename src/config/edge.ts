import { createClient } from "@vercel/global-config";
import {
	closest,
	coerce,
	ENV_PREFIX,
	envNameForPath,
	expandLeaves,
	isRecord,
	type Kind,
	listSchemaLeaves,
	setAt,
	type ZodNode,
} from "./env.js";
import { isLivePath } from "./live.js";
import { deepFreeze, getConfigTree } from "./load.js";
import { type Config, ConfigSchema } from "./schema.js";

export const EDGE_CACHE_MS = 5000;
export const EDGE_TIMEOUT_MS = 2000;

export interface LiveResult {
	config: Config;
	applied: string[];
	ignored: { key: string; reason: string }[];
	error?: string;
}

interface LiveTarget {
	path: string[];
	kind: Kind;
}

function liveTargets(base: Config): {
	live: Map<string, LiveTarget>;
	restart: Set<string>;
} {
	const leaves = expandLeaves(
		listSchemaLeaves(ConfigSchema as unknown as ZodNode),
		base,
	);
	const live = new Map<string, LiveTarget>();
	const restart = new Set<string>();
	for (const leaf of leaves) {
		if (leaf.kind === undefined || leaf.path[0] === "models") continue;
		const name = envNameForPath(leaf.path);
		if (isLivePath(leaf.path))
			live.set(name, { path: leaf.path, kind: leaf.kind });
		else restart.add(name);
	}
	return { live, restart };
}

export function applyLiveOverrides(
	base: Config,
	edge: Readonly<Record<string, unknown>>,
): LiveResult {
	const { live: targets, restart: known } = liveTargets(base);
	let candidate = structuredClone(base) as Record<string, unknown>;
	const applied: string[] = [];
	const ignored: LiveResult["ignored"] = [];

	for (const [key, raw] of Object.entries(edge)) {
		const target = targets.get(key);
		if (!target) {
			ignored.push({ key, reason: unknownReason(key, targets, known) });
			continue;
		}
		const trial = structuredClone(candidate);
		try {
			const text = typeof raw === "string" ? raw : JSON.stringify(raw);
			setAt(trial, target.path, coerce(key, text ?? "", target.kind));
		} catch (error) {
			ignored.push({ key, reason: (error as Error).message });
			continue;
		}
		const parsed = ConfigSchema.safeParse(trial);
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			ignored.push({
				key,
				reason: `fails the schema: ${issue?.path.join(".")} ${issue?.message}`,
			});
			continue;
		}
		candidate = trial;
		applied.push(key);
	}

	const config = ConfigSchema.parse(candidate);
	return { config: deepFreeze(config), applied, ignored };
}

function unknownReason(
	key: string,
	targets: Map<string, LiveTarget>,
	known: Set<string>,
): string {
	if (known.has(key)) return "not live-overridable (needs a restart)";
	if (!key.startsWith(ENV_PREFIX)) return `not an ${ENV_PREFIX} key`;
	const names = [...targets.keys()];
	return names.length === 0
		? "unknown key"
		: `unknown key; closest live key is ${closest(key, names)}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`Edge Config read timed out after ${ms}ms`)),
			ms,
		);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

let cache: { at: number; result: LiveResult } | undefined;

export function resetEdgeCacheForTests(): void {
	cache = undefined;
}

export async function getEffectiveConfig(
	opts: { now?: () => number; read?: () => Promise<unknown> } = {},
): Promise<LiveResult> {
	const cold = getConfigTree();
	const connection = process.env.EDGE_CONFIG;
	if (!connection?.trim()) return { config: cold, applied: [], ignored: [] };

	const now = (opts.now ?? Date.now)();
	if (cache && now - cache.at < EDGE_CACHE_MS) return cache.result;

	const read = opts.read ?? (() => createClient(connection).getAll());
	let result: LiveResult;
	try {
		const payload = await withTimeout(read(), EDGE_TIMEOUT_MS);
		result = applyLiveOverrides(cold, isRecord(payload) ? payload : {});
	} catch (error) {
		result = {
			config: cold,
			applied: [],
			ignored: [],
			error: (error as Error).message,
		};
	}
	cache = { at: now, result };
	return result;
}
