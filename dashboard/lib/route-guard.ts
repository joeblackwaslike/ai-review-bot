export const PUBLIC_PATH_PREFIXES = ["/api/auth"];

/** Pure: true if `pathname` is exactly a public prefix or nested under one.
 * A plain startsWith check would also admit an unrelated future route like
 * `/api/auth-debug` — that's the bypass this boundary check exists to close. */
export function isPublicPath(pathname: string, prefixes: string[]): boolean {
	return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
