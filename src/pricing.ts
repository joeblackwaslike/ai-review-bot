import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { KvClient } from "./feedback/kv.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";
const KV_KEY = "pricing:openrouter";
const DEFAULT_TTL_MS = 24 * 3600 * 1000;
const KV_EXPIRY_SECONDS = 48 * 3600;
const FETCH_TIMEOUT_MS = 3000;

export interface PriceTier {
	minPromptTokens: number;
	input: number;
	cachedInput: number;
	output: number;
}

/** USD per million tokens. `tiers` apply above a prompt size. */
export interface Price {
	input: number;
	cachedInput: number;
	output: number;
	tiers?: PriceTier[];
}

export type PriceTable = Record<string, Price>;

let table: PriceTable = {};
let loadedAt: number | undefined;

export function normalizeModelId(id: string): string {
	return id.toLowerCase().replaceAll(".", "-");
}

const perMillion = (v: unknown): number | undefined => {
	if (typeof v !== "string" && typeof v !== "number") return undefined;
	const n = Number((Number(v) * 1_000_000).toPrecision(12));
	return Number.isFinite(n) && n >= 0 ? n : undefined;
};

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

export function parseOpenRouterPrices(json: unknown): PriceTable {
	const out: PriceTable = {};
	if (!isRecord(json) || !Array.isArray(json.data)) return out;
	for (const entry of json.data) {
		if (!isRecord(entry) || typeof entry.id !== "string") continue;
		if (entry.id.includes(":") || entry.id.startsWith("~")) continue;
		const p = entry.pricing;
		if (!isRecord(p)) continue;
		const input = perMillion(p.prompt);
		const output = perMillion(p.completion);
		if (input === undefined || output === undefined) continue;
		const price: Price = {
			input,
			output,
			cachedInput: perMillion(p.input_cache_read) ?? input,
		};
		const tiers: PriceTier[] = [];
		for (const o of Array.isArray(p.overrides) ? p.overrides : []) {
			if (!isRecord(o)) continue;
			const tin = perMillion(o.prompt);
			const tout = perMillion(o.completion);
			const min = Number(o.min_prompt_tokens);
			if (tin === undefined || tout === undefined || !Number.isFinite(min)) {
				continue;
			}
			tiers.push({
				minPromptTokens: min,
				input: tin,
				output: tout,
				cachedInput: perMillion(o.input_cache_read) ?? tin,
			});
		}
		if (tiers.length > 0) price.tiers = tiers;
		out[normalizeModelId(entry.id)] = price;
	}
	return out;
}

export function setPriceTable(next: PriceTable, at: number = Date.now()): void {
	table = next;
	loadedAt = at;
}

export function clearPriceTable(): void {
	table = {};
	loadedAt = undefined;
}

export function priceTableSize(): number {
	return Object.keys(table).length;
}

export function lookupPrice(
	model: string,
	promptTokens: number,
): Omit<Price, "tiers"> | undefined {
	const id = normalizeModelId(model);
	const found =
		table[id] ??
		Object.entries(table).find(([key]) => key.endsWith(`/${id}`))?.[1];
	if (!found) return undefined;
	const tier = (found.tiers ?? [])
		.filter((t) => t.minPromptTokens <= promptTokens)
		.sort((a, b) => b.minPromptTokens - a.minPromptTokens)[0];
	return tier ?? found;
}

export function defaultPricingFile(): string {
	return join(homedir(), ".ai-review", "pricing.json");
}

interface Cached {
	fetchedAt: number;
	table: PriceTable;
}

function parseCached(raw: string | null): Cached | undefined {
	if (!raw) return undefined;
	const v: unknown = JSON.parse(raw);
	if (!isRecord(v) || typeof v.fetchedAt !== "number" || !isRecord(v.table)) {
		return undefined;
	}
	return { fetchedAt: v.fetchedAt, table: v.table as PriceTable };
}

export interface PrimeOptions {
	kv?: KvClient | null;
	/** CLI cache file, used when there is no KV. */
	file?: string;
	fetchImpl?: typeof fetch;
	nowMs?: number;
	ttlMs?: number;
	/** Skip the freshness checks and fetch. */
	force?: boolean;
}

async function readCache(opts: PrimeOptions): Promise<Cached | undefined> {
	if (opts.kv) return parseCached(await opts.kv.get(KV_KEY));
	if (opts.file) return parseCached(readFileSync(opts.file, "utf8"));
	return undefined;
}

async function writeCache(opts: PrimeOptions, value: Cached): Promise<void> {
	const raw = JSON.stringify(value);
	if (opts.kv) {
		await opts.kv.set(KV_KEY, raw, KV_EXPIRY_SECONDS);
	} else if (opts.file) {
		mkdirSync(dirname(opts.file), { recursive: true });
		writeFileSync(opts.file, raw);
	}
}

/** Load prices into memory: memory, then KV or file cache, then OpenRouter.
 * Best effort: any failure keeps the stale table and logs one warning. Returns
 * the number of priced models now in memory. */
export async function primePrices(opts: PrimeOptions = {}): Promise<number> {
	const now = opts.nowMs ?? Date.now();
	const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
	const fresh = (at: number) => now - at < ttl;
	if (!opts.force && loadedAt !== undefined && fresh(loadedAt)) {
		return priceTableSize();
	}
	try {
		if (!opts.force) {
			const cached = await readCache(opts).catch(() => undefined);
			if (cached && fresh(cached.fetchedAt)) {
				setPriceTable(cached.table, cached.fetchedAt);
				return priceTableSize();
			}
		}
		const res = await (opts.fetchImpl ?? fetch)(OPENROUTER_URL, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) throw new Error(`OpenRouter responded ${res.status}`);
		const fetched = parseOpenRouterPrices(await res.json());
		if (Object.keys(fetched).length === 0) {
			throw new Error("OpenRouter returned no usable prices");
		}
		setPriceTable(fetched, now);
		await writeCache(opts, { fetchedAt: now, table: fetched }).catch(
			() => undefined,
		);
	} catch (error) {
		console.warn("price refresh failed; using the last known prices", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	return priceTableSize();
}
