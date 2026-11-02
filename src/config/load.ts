import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { applyEnvOverlay, type ValueSource } from "./env.js";
import { type Config, ConfigSchema } from "./schema.js";

export interface LoadedConfig {
	config: Config;
	sources: Record<string, ValueSource>;
	warnings: string[];
}

interface LoadOptions {
	env?: Readonly<Record<string, string | undefined>>;
	yamlPath?: string;
}

const DEFAULT_YAML_PATH = fileURLToPath(
	new URL("../../config/ai-review.yaml", import.meta.url),
);

function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}

export function loadConfig(opts: LoadOptions = {}): LoadedConfig {
	const yamlPath = opts.yamlPath ?? DEFAULT_YAML_PATH;
	let text: string;
	try {
		text = readFileSync(yamlPath, "utf8");
	} catch (error) {
		throw new Error(
			`Cannot read config file ${yamlPath}: ${(error as Error).message}`,
		);
	}
	let raw: unknown;
	try {
		raw = parse(text);
	} catch (error) {
		throw new Error(`Invalid YAML in ${yamlPath}: ${(error as Error).message}`);
	}

	const { value, sources, warnings } = applyEnvOverlay(
		raw,
		opts.env ?? process.env,
	);
	const parsed = ConfigSchema.safeParse(value);
	if (!parsed.success) {
		const issues = parsed.error.issues
			.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
			.join("; ");
		throw new Error(`Invalid config (${yamlPath}): ${issues}`);
	}
	return { config: deepFreeze(parsed.data), sources, warnings };
}

let memo: LoadedConfig | undefined;

export function getLoadedConfig(): LoadedConfig {
	memo ??= loadConfig();
	return memo;
}

export function getConfigTree(): Config {
	return getLoadedConfig().config;
}

export function resetConfigForTests(): void {
	memo = undefined;
}
