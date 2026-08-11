import NextAuth from "next-auth";
import type { GitHubProfile } from "next-auth/providers/github";
import GitHub from "next-auth/providers/github";
import { isAllowedLogin, parseAllowlist } from "./lib/allowlist";

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
			const login = (profile as GitHubProfile | undefined)?.login;
			if (login) {
				token.login = login;
			}
			if (!isAllowedLogin(token.login as string | undefined, allowlist)) {
				return null;
			}
			return token;
		},
	},
});
