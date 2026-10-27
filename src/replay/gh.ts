import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

export interface GhClient {
	rest<T>(route: string, params?: Record<string, string | number>): Promise<T>;
	graphql<T>(query: string, vars?: Record<string, string | number>): Promise<T>;
}

function fieldArgs(params: Record<string, string | number> = {}): string[] {
	return Object.entries(params).flatMap(([k, v]) => ["-F", `${k}=${v}`]);
}

export class GhHttpError extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

async function gh(args: string[]): Promise<string> {
	try {
		const { stdout } = await execFileAsync("gh", args, {
			maxBuffer: MAX_BUFFER,
		});
		return stdout;
	} catch (err) {
		const stderr = String((err as { stderr?: string }).stderr ?? "");
		const status = stderr.match(/HTTP (\d{3})/)?.[1];
		if (status) throw new GhHttpError(Number(status), stderr.trim());
		throw err;
	}
}

export function mergePages(pages: unknown[]): unknown {
	if (pages.every(Array.isArray)) return pages.flat();
	const [first, ...rest] = pages as Record<string, unknown>[];
	const merged = { ...first };
	for (const key of ["commits", "files"]) {
		if (Array.isArray(first?.[key])) {
			merged[key] = pages.flatMap(
				(p) => ((p as Record<string, unknown>)[key] as unknown[]) ?? [],
			);
		}
	}
	return rest.length || first ? merged : null;
}

export function ghCli(): GhClient {
	return {
		async rest<T>(route: string, params?: Record<string, string | number>) {
			const out = await gh([
				"api",
				"--method",
				"GET",
				"--paginate",
				"--slurp",
				route,
				...fieldArgs({ per_page: 100, ...params }),
			]);
			return mergePages(JSON.parse(out) as unknown[]) as T;
		},
		async graphql<T>(query: string, vars?: Record<string, string | number>) {
			const out = await gh([
				"api",
				"graphql",
				"-f",
				`query=${query}`,
				...fieldArgs(vars),
			]);
			return (JSON.parse(out) as { data: T }).data;
		},
	};
}
