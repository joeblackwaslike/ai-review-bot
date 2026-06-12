import { type PollDeps, runFeedbackPoll } from "./poll.js";

/** Framework-agnostic cron logic: check the feature flag, verify the secret, run one poll.
 * The feature-flag check runs first so deployments that never opted into feedback skip
 * cleanly (200) instead of 401ing on every scheduled invocation — Vercel only sends the
 * Bearer header when CRON_SECRET is set, so without this order such deployments would emit
 * failed cron runs forever. When disabled the endpoint does no work and touches no clients,
 * so skipping before auth leaks nothing. `buildDeps` is only invoked once authorized AND
 * enabled. Returns the HTTP status + JSON body for the caller to send. */
export async function pollFeedbackRequest(opts: {
	authorization: string | undefined;
	secret: string | undefined;
	feedbackEnabled: boolean;
	buildDeps: () => PollDeps;
}): Promise<{ status: number; body: unknown }> {
	if (!opts.feedbackEnabled) {
		return { status: 200, body: { skipped: "FEEDBACK_ENABLED is not true" } };
	}
	if (!opts.secret || opts.authorization !== `Bearer ${opts.secret}`) {
		return { status: 401, body: { error: "Unauthorized" } };
	}
	// Per-comment failures are swallowed inside runFeedbackPoll; only systemic failures
	// (KV unreachable, missing env, installation auth) reach here. Keep the status+body
	// contract instead of letting the cron function 500 with a raw stack trace.
	try {
		const result = await runFeedbackPoll(opts.buildDeps());
		return { status: 200, body: result };
	} catch (err) {
		return {
			status: 500,
			body: { error: "poll failed", message: String(err) },
		};
	}
}
