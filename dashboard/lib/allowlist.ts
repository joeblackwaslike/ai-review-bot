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
	return allowlist.includes(login.toLowerCase());
}
