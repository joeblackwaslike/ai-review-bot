import { type NextRequest, NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "./auth";

const PUBLIC_PATH_PREFIXES = ["/api/auth"];

export const proxy = auth((req) => {
	// The inferred type of `req` loses its inherited NextRequest members
	// (nextUrl, url, ...) under this project's moduleResolution: "nodenext" — a
	// pre-existing duplicate react version between the repo root (vitepress) and
	// dashboard/ makes TS resolve next/server's types inconsistently there. The
	// object is a real NextRequest at runtime regardless; only the inferred type
	// is wrong. Importing next-auth's own `NextAuthRequest` doesn't help — it's
	// defined as `extends NextRequest` too, so it hits the identical broken
	// extends-chain (confirmed: swapping to it reproduces the same TS2339s).
	// Reconstructing the shape from `next/server`'s own NextRequest sidesteps
	// next-auth's already-broken alias entirely.
	const request = req as unknown as NextRequest & { auth: Session | null };
	const isPublic = PUBLIC_PATH_PREFIXES.some(
		(p) =>
			request.nextUrl.pathname === p ||
			request.nextUrl.pathname.startsWith(`${p}/`),
	);
	if (!request.auth && !isPublic) {
		return NextResponse.redirect(
			new URL("/api/auth/signin", request.nextUrl.origin),
		);
	}
});

export const config = {
	matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
