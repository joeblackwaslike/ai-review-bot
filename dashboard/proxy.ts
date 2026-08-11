import { NextResponse } from "next/server";
import type { Session } from "next-auth";
import { auth } from "./auth";
import { isPublicPath, PUBLIC_PATH_PREFIXES } from "./lib/route-guard";

export const proxy = auth((req) => {
	// The inferred type of `req` loses its inherited NextRequest members
	// (nextUrl, url, ...) under this project's moduleResolution: "nodenext" — a
	// pre-existing duplicate react version between the repo root (vitepress) and
	// dashboard/ makes TS resolve next/server's types inconsistently there. The
	// object is a real NextRequest at runtime regardless; only the inferred type
	// is wrong. Importing next-auth's own `NextAuthRequest` doesn't help — it's
	// defined as `extends NextRequest` too, so it hits the identical broken
	// extends-chain (confirmed: swapping to it reproduces the same TS2339s).
	// Cast to only the two members actually used here, rather than the full
	// NextRequest shape, so this workaround can't silently mask a real type
	// error on some other property this file never touches.
	const request = req as unknown as { nextUrl: URL; auth: Session | null };
	const isPublic = isPublicPath(request.nextUrl.pathname, PUBLIC_PATH_PREFIXES);
	if (!request.auth && !isPublic) {
		return NextResponse.redirect(
			new URL("/api/auth/signin", request.nextUrl.origin),
		);
	}
});

export const config = {
	matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
