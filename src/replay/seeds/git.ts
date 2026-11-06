import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function cleanEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [k, v] of Object.entries(process.env))
		if (!k.startsWith("GIT_")) env[k] = v;
	return { ...env, ...extra };
}

/** Runs git in `cwd` with no hooks and no inherited `GIT_*` variables, so it can only touch `cwd`. */
export async function seedGit(
	cwd: string,
	args: string[],
	extraEnv: Record<string, string> = {},
): Promise<string> {
	const { stdout } = await execFileAsync(
		"git",
		["-c", "core.hooksPath=/dev/null", ...args],
		{ cwd, env: cleanEnv(extraEnv), maxBuffer: 16 * 1024 * 1024 },
	);
	return stdout.trim();
}
