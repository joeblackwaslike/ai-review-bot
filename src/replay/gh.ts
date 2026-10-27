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

async function gh(args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("gh", args, {
		maxBuffer: MAX_BUFFER,
	});
	return stdout;
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
				...fieldArgs(params),
			]);
			const pages = JSON.parse(out) as unknown[];
			return (
				pages.every(Array.isArray) ? pages.flat() : (pages[0] ?? null)
			) as T;
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
