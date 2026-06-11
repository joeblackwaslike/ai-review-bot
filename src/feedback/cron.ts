import { type PollDeps, runFeedbackPoll } from "./poll.js";

/** Framework-agnostic cron logic: verify the secret, check the feature flag, run one poll.
 * `buildDeps` is only invoked once authorized AND enabled (so KV/app clients aren't built
 * for rejected calls). Returns the HTTP status + JSON body for the caller to send. */
export async function pollFeedbackRequest(opts: {
	authorization: string | undefined;
	secret: string | undefined;
	feedbackEnabled: boolean;
	buildDeps: () => PollDeps;
}): Promise<{ status: number; body: unknown }> {
	if (!opts.secret || opts.authorization !== `Bearer ${opts.secret}`) {
		return { status: 401, body: { error: "Unauthorized" } };
	}
	if (!opts.feedbackEnabled) {
		return { status: 200, body: { skipped: "FEEDBACK_ENABLED is not true" } };
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
