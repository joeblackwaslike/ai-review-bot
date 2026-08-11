import NextAuth from "next-auth";
import type { GitHubProfile } from "next-auth/providers/github";
import GitHub from "next-auth/providers/github";
import { isAllowedLogin, parseAllowlist, reviewToken } from "./lib/allowlist";

// Snapshotted once at module load (cold start), not re-read per request — a
// change to DASHBOARD_ALLOWED_LOGIN takes effect on the next deploy/cold
// start, not instantly. jwt() below re-checks against THIS snapshot on every
// token refresh, which revokes a session removed from the allowlist without
// waiting out its maxAge — but only once the new snapshot is live.
const allowlist = parseAllowlist(process.env.DASHBOARD_ALLOWED_LOGIN);

export const { handlers, auth, signIn, signOut } = NextAuth({
	providers: [
		GitHub({
			clientId: process.env.GITHUB_OAUTH_CLIENT_ID,
			clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET,
		}),
	],
	callbacks: {
		async signIn({ profile }) {
			return isAllowedLogin(
				(profile as GitHubProfile | undefined)?.login,
				allowlist,
			);
		},
		async jwt({ token, profile }) {
			const { login, allowed } = reviewToken(
				typeof token.login === "string" ? token.login : undefined,
				(profile as GitHubProfile | undefined)?.login,
				allowlist,
			);
			if (!allowed) {
				console.warn("dashboard: revoking session, login not on allowlist", {
					login,
				});
				return null;
			}
			token.login = login;
			return token;
		},
	},
});
