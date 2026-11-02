import type { GitRunner } from "../sources.js";
import type { Implementer } from "./types.js";

export function implementerFromEnv(env: NodeJS.ProcessEnv): Implementer {
	const sessionId = env.CLAUDE_CODE_SESSION_ID;
	if (sessionId) {
		return {
			agent: "claude-code",
			sessionId,
			source: "env",
			confidence: "high",
		};
	}
	return { agent: null, sessionId: null, source: null, confidence: null };
}

export function branchForHead(runGit: GitRunner): string | null {
	try {
		const listed = runGit([
			"for-each-ref",
			"--points-at",
			"HEAD",
			"--format=%(refname:short)",
			"refs/heads/",
		])
			.split("\n")
			.map((l) => l.trim())
			.find(Boolean);
		if (listed) return listed;
		const name = runGit(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
		return name && name !== "HEAD" ? name : null;
	} catch {
		return null;
	}
}
