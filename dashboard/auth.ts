import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";
import { isAllowedLogin, parseAllowlist } from "./lib/allowlist.js";

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
				(profile as { login?: string } | undefined)?.login,
				allowlist,
			);
		},
	},
});
