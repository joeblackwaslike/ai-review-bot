## root cause investigation

- investigate exactly when the Anthropic review bot started going bad, because it used to be fine At least that's what I remember so maybe verify that too . I'd like to see exactly what changes may have been introduced that caused this problem, because a lot of what we're doing to fix it might just be band-aiding the issue, find the root cause and We have the best chances of fixing this quickly and efficiently. Let's figure out by bisecting the PRs:
    - determine where exactly it started going bad
    - what commit it was associated with
    - what changes were in that commit
    - determine the root cause
    - propose a plan to fix the root cause
    - Implement the plan.
    - verify it's fixed.
    - Changes that attempted to also fix this problem without determining the root cause: evaluate whether they are still adding value. You could just go through and disable them one by one and if its not adding value, we should remove them unless you have any thoughts on why they should remain.

## outstanding work

- codify 👍/👎-with-reason in `giving-feedback-on-ai-reviews.md` and ensure that runbook is activated whenever driving a pr to approval is.
- backfill reply-derived feedback (blocked on`classify` being idempotent per `raw_feedback_id`)
- proving the #46 dedupe live if still relevant

- the `g8q`/`vms` dashboard.
- `docs/_backlog.md` lines 3 and 7 (idiom subagent, out-of-funds Telegram alert)

- evaluate the using GitHub skill, especially the driving an PR to approval runbook, ensure everything Is accurate and up to date with all of the latest changes and additions to the AI review bot repo.

## housekeeping

- go Through the backlog, remove everything that has been done so that only the things that remain to be completed or are remaining 
- `replay.mjs` is untracked in the root; decide whether it belongs in the repo or the scratchpad.
- Why do I have to always have to manually remove the git work trees?  find a way to give the agent autonomy to do that itself while being safe globally and permanently.
- remove the remaining defunct git work trees

## proactivity

- add to our harness Repo and the agents MD or whatever that's Basically states Whenever I point out a An issue, mistake, or problem and that problem is also related to a failure in process, evaluate and fix the process itself using red green tdd without me having to ask. this goes to being proactive, then include details on how the process was broken and how you fixed it when you give me the full summary of everything.
- The proactivity point. Let's think about how we can be more proactive and how we can write or create processes to encourage the right kind of proactivity. I think this will strengthen our ability to operate more autonomously.

## autonomy

- Let's encode the whole prompt of I'm going to be away for a while, so I need you to drive this autonomously, Ask any pertinent questions now using the ask user question tool, then begin operating autonomously and if any kind of ambiguity or questions come up away, use your best judgment, and document the problem, question, decision, rationale in a beads ticket, and continue. Whenever you're done, give me a summary of everything that's been completed, and a summary. of all of the tickets that you filed for these questions or ambiguities and then we can kind of go through those one by one and we can record both the questions and rationale, reasoning, And my response to the official place where we're collecting the executive decision data. Let's turn this into a command and add it to the harness repo. Actually what we should do is what we did with the /PR-loop command and driving a PR to approval runbook in the using github skill so let's create a skill for how to operate autonomously when I'm not around and have a runbook for how to operate autonomously when I am around, with a Command that is a thin shim into that.