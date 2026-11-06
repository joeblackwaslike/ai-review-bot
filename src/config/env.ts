import { z } from "zod";
import { ConfigSchema } from "./schema.js";

export const ENV_PREFIX = "AI_REVIEW_";

export type ValueSource = "env" | "alias" | "yaml" | "default";

export interface AliasEntry {
	path: readonly string[];
	deprecated: boolean;
}

const deprecated = (...path: string[]): AliasEntry => ({
	path,
	deprecated: true,
});
const permanent = (...path: string[]): AliasEntry => ({
	path,
	deprecated: false,
});

export const ENV_ALIASES: Readonly<Record<string, AliasEntry>> = {
	REVIEW_ENABLED: deprecated("review", "enabled"),
	REVIEW_DELAY_SECONDS: deprecated("review", "delaySeconds"),
	REVIEW_RESYNC_DELAY_SECONDS: deprecated("review", "resyncDelaySeconds"),
	REVIEW_COMMAND: deprecated("review", "command"),
	CUSTOM_REVIEW_PROMPT: deprecated("review", "customPrompt"),
	AGENT_CONCURRENCY: deprecated("review", "agentConcurrency"),
	REVIEW_AGENT_BUDGET_SECONDS: deprecated("review", "agentBudgetSeconds"),
	REVIEW_DIFF_BUDGET_CHARS: deprecated("review", "diffBudgetChars"),
	REVIEW_TIER2_ENABLED: deprecated("review", "tier2Enabled"),
	FEEDBACK_ENABLED: deprecated("review", "feedbackEnabled"),
	IMPROVE_ENABLED: deprecated("improve", "enabled"),
	IMPROVE_CARRIER_ENABLED: deprecated("improve", "carrierEnabled"),
	PUBLIC_URL: deprecated("infra", "publicUrl"),
	QSTASH_URL: deprecated("infra", "qstashUrl"),
	AI_REVIEW_GATE_DIR: permanent("cli", "gateDir"),
	AI_REVIEW_MISTAKES_DIR: permanent("cli", "mistakesDir"),
	AI_REVIEW_LOG_FILE: permanent("cli", "logFile"),
};

export interface OverlayResult {
	value: unknown;
	sources: Record<string, ValueSource>;
	warnings: string[];
}

export class UnknownConfigEnvError extends Error {
	constructor(name: string, suggestion: string) {
		super(`Unknown config env var ${name}. Did you mean ${suggestion}?`);
		this.name = "UnknownConfigEnvError";
	}
}

type Kind = "boolean" | "number" | "string" | "json";

export interface SchemaLeaf {
	path: string[];
	mapIndexes: number[];
	kind: Kind | undefined;
	type: string;
	default: string;
	description: string;
}

type Env = Readonly<Record<string, string | undefined>>;

export function envNameForPath(path: readonly string[]): string {
	const segments = path.map((segment) =>
		segment
			.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
			.replace(/-/g, "_")
			.toUpperCase(),
	);
	return ENV_PREFIX + segments.join("__");
}

export interface ZodNode {
	_zod: { def: { type: string; innerType?: ZodNode; valueType?: ZodNode } };
	shape?: Record<string, ZodNode>;
}

export const unwrap = (node: ZodNode): ZodNode => {
	let current = node;
	while (
		current._zod.def.type === "default" ||
		current._zod.def.type === "optional"
	) {
		current = current._zod.def.innerType as ZodNode;
	}
	return current;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

const getAt = (obj: unknown, path: readonly string[]): unknown =>
	path.reduce<unknown>(
		(cur, key) => (isRecord(cur) ? cur[key] : undefined),
		obj,
	);

const UNSAFE_KEYS: ReadonlySet<string> = new Set([
	"__proto__",
	"constructor",
	"prototype",
]);

const setAt = (
	obj: Record<string, unknown>,
	path: readonly string[],
	value: unknown,
): void => {
	const unsafe = path.find((key) => UNSAFE_KEYS.has(key));
	if (unsafe !== undefined) {
		throw new Error(
			`Config path ${path.join(".")} contains unsafe key "${unsafe}"`,
		);
	}
	let cur = obj;
	for (const key of path.slice(0, -1)) {
		if (!isRecord(cur[key])) cur[key] = {};
		cur = cur[key] as Record<string, unknown>;
	}
	cur[path[path.length - 1] as string] = value;
};

const KIND_BY_TYPE: Record<string, Kind> = {
	boolean: "boolean",
	number: "number",
	string: "string",
	enum: "string",
	array: "json",
};

const MAP_KEYS: Record<string, string> = {
	models: "<provider/model>",
	reviewers: "<id>",
	providerOptions: "<provider>",
	skills: "<skill>",
	providers: "<provider>",
};

interface Def {
	type: string;
	innerType?: ZodNode;
	valueType?: ZodNode;
	element?: ZodNode;
	entries?: Record<string, unknown>;
	defaultValue?: unknown;
}

const defOf = (node: ZodNode): Def => node._zod.def as Def;

function wrapperChain(node: ZodNode): ZodNode[] {
	const chain = [node];
	let current = node;
	while (defOf(current).innerType) {
		current = defOf(current).innerType as ZodNode;
		chain.push(current);
	}
	return chain;
}

function describeOf(node: ZodNode): string {
	for (const n of wrapperChain(node)) {
		const text = z.globalRegistry.get(n as never)?.description;
		if (text) return text;
	}
	return "";
}

function typeOf(node: ZodNode): string {
	const def = defOf(unwrap(node));
	if (def.type === "enum") {
		return `one of ${Object.keys(def.entries ?? {}).join(", ")}`;
	}
	if (def.type === "array") return `${typeOf(def.element as ZodNode)}[]`;
	if (def.type === "custom") return "object";
	return def.type;
}

function defaultOf(node: ZodNode): string {
	const wrapper = wrapperChain(node).find((n) => defOf(n).type === "default");
	if (wrapper) return JSON.stringify(defOf(wrapper).defaultValue);
	return wrapperChain(node).some((n) => defOf(n).type === "optional")
		? "unset"
		: "required";
}

export function listSchemaLeaves(
	node: ZodNode,
	path: string[] = [],
	mapIndexes: number[] = [],
	out: SchemaLeaf[] = [],
): SchemaLeaf[] {
	const inner = unwrap(node);
	const def = defOf(inner);
	if (def.type === "object" && inner.shape) {
		for (const [key, child] of Object.entries(inner.shape)) {
			listSchemaLeaves(child, [...path, key], mapIndexes, out);
		}
	} else if (def.type === "record") {
		listSchemaLeaves(
			def.valueType as ZodNode,
			[...path, MAP_KEYS[path.at(-1) as string] ?? "<key>"],
			[...mapIndexes, path.length],
			out,
		);
	} else {
		out.push({
			path,
			mapIndexes,
			kind: KIND_BY_TYPE[def.type],
			type: typeOf(node),
			default: defaultOf(node),
			description: describeOf(node),
		});
	}
	return out;
}

function expandLeaves(leaves: SchemaLeaf[], raw: unknown): SchemaLeaf[] {
	return leaves.flatMap((leaf) => {
		const go = (prefix: string[], from: number): string[][] => {
			const m = leaf.mapIndexes.find((i) => i >= from);
			if (m === undefined) return [[...prefix, ...leaf.path.slice(from)]];
			const base = [...prefix, ...leaf.path.slice(from, m)];
			const obj = getAt(raw, base);
			if (!isRecord(obj)) return [];
			return Object.keys(obj).flatMap((key) => go([...base, key], m + 1));
		};
		return go([], 0).map((path) => ({ ...leaf, path, mapIndexes: [] }));
	});
}

function coerce(name: string, text: string, kind: Kind): unknown {
	if (kind === "boolean") {
		const lower = text.trim().toLowerCase();
		if (lower === "true") return true;
		if (lower === "false") return false;
		throw new Error(`${name} must be a boolean (true or false), got "${text}"`);
	}
	if (kind === "number") {
		const n = Number(text);
		if (!Number.isFinite(n)) {
			throw new Error(`${name} must be a finite number, got "${text}"`);
		}
		return n;
	}
	if (kind === "json") {
		try {
			return JSON.parse(text);
		} catch {
			throw new Error(`${name} must be valid JSON, got "${text}"`);
		}
	}
	return text;
}

function distance(a: string, b: string): number {
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) {
			row[j] = Math.min(
				(prev[j] as number) + 1,
				(row[j - 1] as number) + 1,
				(prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
		}
		prev = row;
	}
	return prev[b.length] as number;
}

const closest = (name: string, candidates: string[]): string =>
	candidates.reduce((best, c) =>
		distance(name, c) < distance(name, best) ? c : best,
	);

const isSet = (v: string | undefined): v is string =>
	v !== undefined && v.trim() !== "";

export function applyEnvOverlay(raw: unknown, env: Env): OverlayResult {
	const value: Record<string, unknown> = isRecord(raw)
		? structuredClone(raw)
		: {};
	const leaves = expandLeaves(
		listSchemaLeaves(ConfigSchema as unknown as ZodNode),
		value,
	).filter((l) => l.kind !== undefined && l.path[0] !== "models");

	const derived = new Map(leaves.map((l) => [envNameForPath(l.path), l]));
	const valid = [
		...derived.keys(),
		...Object.keys(ENV_ALIASES).filter((n) => n.startsWith(ENV_PREFIX)),
	];
	for (const name of Object.keys(env)) {
		if (
			name.startsWith(ENV_PREFIX) &&
			!derived.has(name) &&
			!ENV_ALIASES[name]
		) {
			throw new UnknownConfigEnvError(name, closest(name, valid));
		}
	}

	const sources: Record<string, ValueSource> = {};
	const warnings: string[] = [];
	const aliasFor = new Map<string, [string, AliasEntry]>();
	for (const [name, entry] of Object.entries(ENV_ALIASES)) {
		aliasFor.set(entry.path.join("."), [name, entry]);
	}

	for (const leaf of leaves) {
		const dotted = leaf.path.join(".");
		const derivedName = envNameForPath(leaf.path);
		const alias = aliasFor.get(dotted);
		const derivedText = env[derivedName];
		const aliasText = alias ? env[alias[0]] : undefined;
		let source: ValueSource =
			getAt(value, leaf.path) === undefined ? "default" : "yaml";

		if (isSet(derivedText)) {
			setAt(
				value,
				leaf.path,
				coerce(derivedName, derivedText, leaf.kind as Kind),
			);
			source = "env";
			if (alias && isSet(aliasText)) {
				warnings.push(
					`${alias[0]} and ${derivedName} are both set; using ${derivedName}`,
				);
			}
		} else if (alias && isSet(aliasText)) {
			setAt(value, leaf.path, coerce(alias[0], aliasText, leaf.kind as Kind));
			source = "alias";
			if (alias[1].deprecated) {
				warnings.push(`${alias[0]} is deprecated; use ${derivedName}`);
			}
		}
		sources[dotted] = source;
	}

	return { value, sources, warnings };
}
