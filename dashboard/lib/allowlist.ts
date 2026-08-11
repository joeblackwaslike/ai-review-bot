export function parseAllowlist(raw: string | undefined): string[] {
	return (raw ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

export function isAllowedLogin(
	login: string | null | undefined,
	allowlist: string[],
): boolean {
	if (!login) return false;
	const normalized = login.toLowerCase();
	return allowlist.some((entry) => entry.toLowerCase() === normalized);
}

/** Pure: the login to persist on a session token, and whether it's still
 * allowed. Called on every session read, not just initial sign-in, so
 * removing a login from the allowlist revokes access on the next token
 * refresh instead of waiting out the session's maxAge (up to 30 days by
 * default). `profileLogin` is only present at sign-in; a profile-less
 * refresh re-checks whatever login was already captured on the token. */
export function reviewToken(
	currentLogin: string | undefined,
	profileLogin: string | undefined,
	allowlist: string[],
): { login: string | undefined; allowed: boolean } {
	const login = profileLogin ?? currentLogin;
	return { login, allowed: isAllowedLogin(login, allowlist) };
}
