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
