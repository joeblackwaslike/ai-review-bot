/** Framework-agnostic cron logic for the improvement cycle.
 *
 * The flag check runs BEFORE the secret check, matching feedback/cron.ts: Vercel
 * only sends the Bearer header once CRON_SECRET is set, so a deployment that
 * never opted in would otherwise emit a failed cron run forever. Skipping before
 * auth leaks nothing, because a disabled cycle touches no clients. */
export async function improveRequest<T>(opts: {
	authorization: string | undefined;
	secret: string | undefined;
	improveEnabled: boolean;
	run: () => Promise<T>;
}): Promise<{ status: number; body: unknown }> {
	if (!opts.improveEnabled) {
		return { status: 200, body: { skipped: "IMPROVE_ENABLED is not true" } };
	}
	if (!opts.secret || opts.authorization !== `Bearer ${opts.secret}`) {
		return { status: 401, body: { error: "Unauthorized" } };
	}
	try {
		return { status: 200, body: await opts.run() };
	} catch (err) {
		// Stage failures are already contained inside runImproveCycle; reaching
		// here means something systemic (no database, bad credentials). Return the
		// contract rather than letting the function 500 with a raw stack trace.
		console.error("improve cron: cycle failed", { err });
		return {
			status: 500,
			body: {
				error: "improve cycle failed",
				message: err instanceof Error ? err.message : String(err),
			},
		};
	}
}
