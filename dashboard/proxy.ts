import { NextResponse } from "next/server";
import { auth } from "./auth.js";

const PUBLIC_PATH_PREFIXES = ["/api/auth"];

export const proxy = auth((req) => {
	const isPublic = PUBLIC_PATH_PREFIXES.some((p) =>
		req.nextUrl.pathname.startsWith(p),
	);
	if (!req.auth && !isPublic) {
		return NextResponse.redirect(
			new URL("/api/auth/signin", req.nextUrl.origin),
		);
	}
});

export const config = {
	matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
