/** Third-party review bots the delay exists to wait for. Our own bots are
 * absent: waiting for ourselves would deadlock, and the point of the wait is to
 * see what the others said so we can dedupe against it. */
export const PEER_REVIEW_BOTS = [
	"coderabbitai[bot]",
	"sourcery-ai[bot]",
	"gemini-code-assist[bot]",
	"chatgpt-codex-connector[bot]",
] as const;

export interface PeerOctokit {
	paginate: (
		route: string,
		params: Record<string, unknown>,
	) => Promise<unknown[]>;
	request: (
		route: string,
		params: Record<string, unknown>,
	) => Promise<{ data: Record<string, unknown> }>;
}

interface ReviewRow {
	user: { login: string } | null;
	commit_id: string;
	submitted_at?: string;
}

export type PeerDecision = {
	run: boolean;
	reason:
		| "peers-arrived"
		| "no-peers-expected"
		| "ceiling"
		| "peer-fetch-failed"
		| "wait";
};

export interface PeerStatus {
	/** Peers that have reviewed the CURRENT head. */
	arrived: string[];
	/** Peers that have reviewed this PR at any point, current head or not. */
	seenOnPr: string[];
}

/** Pure: which peers have weighed in, and on what.
 *
 * `arrived` is gated on the head SHA — a peer's review of an older commit says
 * nothing about the diff we are about to review, so counting it would let a
 * stale review satisfy the wait. */
export function summarizePeers(
	reviews: ReviewRow[],
	headSha: string,
): PeerStatus {
	const peers = new Set<string>(PEER_REVIEW_BOTS);
	const arrived = new Set<string>();
	const seenOnPr = new Set<string>();
	for (const review of reviews) {
		const login = review.user?.login ?? "";
		if (!peers.has(login)) continue;
		seenOnPr.add(login);
		if (review.commit_id === headSha) arrived.add(login);
	}
	return { arrived: [...arrived].sort(), seenOnPr: [...seenOnPr].sort() };
}

/** Pure: should the review run now rather than wait longer?
 *
 * Three ways to stop waiting, in order of confidence:
 *   1. Every peer that has engaged with this PR has now reviewed the current
 *      head — there is nothing left to wait for.
 *   2. No peer has ever engaged with this PR and none is expected in this repo,
 *      so the wait has no purpose at all.
 *   3. The ceiling is reached — a peer that never arrives must not starve us,
 *      which is exactly how our own Codex bot went unreviewed for a whole PR.
 */
export function shouldRunNow(opts: {
	status: PeerStatus;
	peersExpectedInRepo: boolean;
	attempt: number;
	maxAttempts: number;
}): PeerDecision {
	const { status, peersExpectedInRepo, attempt, maxAttempts } = opts;

	if (
		status.seenOnPr.length > 0 &&
		status.arrived.length === status.seenOnPr.length
	) {
		return { run: true, reason: "peers-arrived" };
	}
	if (status.seenOnPr.length === 0 && !peersExpectedInRepo) {
		return { run: true, reason: "no-peers-expected" };
	}
	if (attempt >= maxAttempts) {
		return { run: true, reason: "ceiling" };
	}
	return { run: false, reason: "wait" };
}

/** Reviews on a PR, for peer inspection. */
export async function fetchPrReviews(
	octokit: PeerOctokit,
	owner: string,
	repo: string,
	pr: number,
): Promise<ReviewRow[]> {
	return (await octokit.paginate(
		"GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
		{ owner, repo, pull_number: pr, per_page: 100 },
	)) as ReviewRow[];
}

// A scheduled review polls this every peerCheckIntervalMs (default 90s) up to
// peerMaxAttempts times, so an unresolved wait re-derives this repo-level fact
// on every pass. It changes only when a peer bot is installed/removed, so a
// short TTL cache turns N sequential searches per poll into N once per TTL.
const REPO_EXPECTATION_CACHE_TTL_MS = 15 * 60 * 1000;
const repoExpectationCache = new Map<
	string,
	{ value: boolean; expiresAt: number }
>();

/** Test-only: clear the repo-expectation cache between test cases. */
export function resetPeersExpectedCache(): void {
	repoExpectationCache.clear();
}

/** Has any peer bot ever reviewed in this repo? Answers "is waiting pointless
 * here", which is the difference between a repo with review bots installed and
 * one without. Searched rather than assumed, because assuming they exist is
 * what makes every PR in a bot-free repo wait for nothing.
 *
 * Uses `reviewed-by:`, not `commenter:` — coderabbitai and sourcery-ai post
 * their findings as formal PR reviews, not comments, so `commenter:` would
 * find zero history for a peer bot that has only ever reviewed. */
export async function peersExpectedInRepo(
	octokit: PeerOctokit,
	owner: string,
	repo: string,
): Promise<boolean> {
	const cacheKey = `${owner}/${repo}`;
	const cached = repoExpectationCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) return cached.value;

	try {
		let value = false;
		for (const bot of PEER_REVIEW_BOTS) {
			const resp = await octokit.request("GET /search/issues", {
				q: `repo:${owner}/${repo} type:pr reviewed-by:${bot}`,
				per_page: 1,
			});
			const data = resp.data as { total_count?: number };
			if ((data.total_count ?? 0) > 0) {
				value = true;
				break;
			}
		}
		repoExpectationCache.set(cacheKey, {
			value,
			expiresAt: Date.now() + REPO_EXPECTATION_CACHE_TTL_MS,
		});
		return value;
	} catch (err) {
		// Search is rate-limited and flaky. Failing closed (assume peers exist)
		// keeps the old waiting behaviour, which is the safe direction: waiting
		// too long costs latency, running too early costs duplicate findings.
		// Not cached — a transient failure shouldn't pin the answer for the TTL.
		console.error("peers: repo expectation check failed; assuming peers", {
			owner,
			repo,
			error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
		});
		return true;
	}
}
