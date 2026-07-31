interface NotifyOctokit {
	request: <T>(
		route: string,
		params: Record<string, unknown>,
	) => Promise<{ data: T }>;
}

interface SearchResult {
	total_count: number;
	items: { number: number; html_url: string }[];
}

/** Marker carried in the issue body so a repeat outage finds the existing issue
 * instead of opening a new one. Searching by title is brittle — titles get
 * edited — and the search API indexes the body. */
export function quotaIssueMarker(provider: string): string {
	return `<!-- ai-review:quota-exhausted:${provider} -->`;
}

/** Display name for a provider. Unknown values are surfaced as-is rather than
 * folded into a default: this label appears in the message telling someone
 * WHICH account to pay, so guessing wrong is worse than admitting ignorance. */
export function providerLabel(provider: string): string {
	if (provider === "openai") return "OpenAI";
	if (provider === "anthropic") return "Anthropic";
	return `provider "${provider}"`;
}

export function billingUrl(provider: string): string | null {
	if (provider === "openai")
		return "https://platform.openai.com/settings/organization/billing";
	if (provider === "anthropic")
		return "https://console.anthropic.com/settings/billing";
	return null;
}

export function quotaIssueTitle(provider: string): string {
	return `⛔ ${providerLabel(provider)} credits exhausted — AI review bot is down`;
}

/** Pure: the issue body. Written for someone reading a notification email on a
 * phone — what broke, that waiting will not fix it, and the one link that will. */
export function quotaIssueBody(opts: {
	provider: string;
	owner: string;
	repo: string;
	pullNumber: number;
}): string {
	const billing = billingUrl(opts.provider);
	return [
		quotaIssueMarker(opts.provider),
		`**The ${providerLabel(opts.provider)} account has no credits left, so the AI review bot cannot review anything.**`,
		"",
		"This does not clear on its own. Pushing again will not help. It needs payment.",
		"",
		billing
			? `→ **${billing}**`
			: "→ Check the billing page for that provider — this bot does not have a link for it.",
		"",
		`First seen on ${opts.owner}/${opts.repo}#${opts.pullNumber}.`,
		"",
		"Reviews resume automatically on the next commit once the balance is topped up.",
		"Close this issue once you have paid — it will reopen if the balance runs out again.",
	].join("\n");
}

/** Open a tracking issue for a spent provider balance, or no-op when one is
 * already open. The issue exists to reach a human: GitHub emails the repo owner
 * on a new issue, so this is an email path that needs no extra credentials.
 *
 * Best-effort by design — a notification failure must not mask the outage it is
 * reporting, which is already on the PR and in the logs. */
export async function notifyQuotaExhausted(opts: {
	octokit: NotifyOctokit;
	provider: string;
	owner: string;
	repo: string;
	pullNumber: number;
	/** Optional; omitted when unknown. Assigning the repo OWNER is wrong on an
	 * org-owned repo — there `owner` is the org slug, not a user login, and the
	 * issues API rejects it with a 422 that would lose the notification. */
	assignee?: string;
}): Promise<{ created: boolean; url?: string }> {
	const { octokit, owner, repo, provider } = opts;
	try {
		const marker = quotaIssueMarker(provider);
		const existing = await octokit.request<SearchResult>("GET /search/issues", {
			q: `repo:${owner}/${repo} is:issue is:open "${marker}"`,
		});
		const found = existing.data.items?.[0];
		if (found) {
			console.log("quota issue already open; not duplicating", {
				provider,
				url: found.html_url,
			});
			return { created: false, url: found.html_url };
		}

		const created = await octokit.request<{ html_url: string }>(
			"POST /repos/{owner}/{repo}/issues",
			{
				owner,
				repo,
				title: quotaIssueTitle(provider),
				body: quotaIssueBody(opts),
				...(opts.assignee ? { assignees: [opts.assignee] } : {}),
			},
		);
		console.error("opened quota-exhausted issue", {
			provider,
			url: created.data.html_url,
		});
		return { created: true, url: created.data.html_url };
	} catch (err) {
		console.error("failed to open quota-exhausted issue", {
			provider,
			owner,
			repo,
			error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
		});
		return { created: false };
	}
}
