# Deletion operations

Code, files or dependencies that existed now don't. A deletion is the hardest change to review
from the diff alone, because the diff shows only what is gone. What the removed code did, who
relied on it, and what now fails without it are all somewhere else. The guide's
[five-lines-removed example](../../Code-Review-Guide-and-Playbooks.md#review-locally-not-only-in-the-browser)
is the model: the browser shows five red lines, and every question that matters needs a
search or a blame.

Two questions sort every deletion. Was the removed code *used*: does anything at head still
reference it? And was it *protecting* something: did it guard an input, a state or a caller's
assumption? Unused code can go. Protective code goes only when the protection moved or
stopped mattering, and the PR has to show which. That's
[Chesterton's Fence](../../Code-Review-Guide-and-Playbooks.md#readability-and-review) applied
as a procedure. Deleting a test, or skipping one, is a different operation: see
[composite.md](composite.md). Moving code and then deleting the original is
[relocation.md](relocation.md). Removing a public symbol's signature or a config key is
also an interface change, so read [interface.md](interface.md) alongside.

## DEL-01: Dead code removed

```yaml
id: DEL-01
name: Dead code removed
family: deletion
aliases: [remove unused code, cleanup, prune]
signals:
  - a function, class, constant or module deleted with no added lines that replace it
  - the PR title or description says "remove unused", "cleanup" or "dead code"
  - no matching changes in callers, because there were none
  - tests for the deleted symbol deleted alongside it
narrows_playbooks: true
escalates_with: [public-api, critical-path]
guide_refs:
  - "#readability-and-review"
  - "#building-for-needs-you-dont-have"
  - "#compatibility-hyrums-law"
tools: [lsp-references, ripgrep, blame-C, log-L, module-graph, linked-work-item]
bot_visibility: partial
```

### What it looks like in a diff

Red lines only. A helper, a class, a branch of a conditional or a whole module disappears,
and nothing else in the PR changes to compensate. The description says the code was unused.
In Python the deleted symbol may also disappear from an `__all__` list; in TypeScript, from an
`export` line or an `index.ts` barrel.

### How to recognize it

The removed symbol has no references at base other than its own definition and its own tests.
A language server's references list at the base commit answers this for ordinary imports.
Text search answers the rest: the symbol name inside strings, templates, decorators, config,
reflection (`getattr`, `import_module`, `obj[name]`) and framework registration. If the
references list is empty and the search finds nothing, it's dead. If either finds something
that survives the PR, this is [DEL-03](#del-03-file-deleted) or a
live-code removal.

Look-alikes to rule out:

- **Used through a name the tool can't follow.** A Django signal receiver, a pytest fixture,
  a Celery task, a decorator-registered route, a plugin entry point. These have zero static
  references and are still live.
- **Public in practice.** Nothing in this repo calls it, but it's exported from a package
  other repos import. That's an interface removal ([IFC-08](interface.md#ifc-08-export-surface-added-or-removed)).
- **Replaced.** The deleted code has a successor added elsewhere. That's a move or a rewrite,
  not a deletion ([relocation.md](relocation.md), [behavior.md](behavior.md)).

### Likely intents

1. **Cleanup after a refactor.** The last caller went in an earlier PR.
2. **Cleanup after a feature removal.** This is the tail of [DEL-02](#del-02-feature-removed).
3. **YAGNI.** Speculative code that never got a user.
4. **Tooling-driven.** A linter or `vulture` / `knip` report listed it as unused.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Does anything reference it at base? | Go to References | `lsp-references` at base |
| Is it referenced by name in strings, config or reflection? | Search across files | `ripgrep` for the name and its dotted path |
| Is it exported to other packages? | Check `__all__`, `index.ts`, `package.json` `exports` | `read-file` on those at base |
| Why did it exist? | Git blame / Timeline | `blame-C`, `log-L`, `git log -S <name>` to find the commit that added it |
| What does the PR say it's for? | Read description and ticket | `linked-work-item` |

### What not to spend review on

The deleted body. Its quality is irrelevant once it's gone. Don't comment on what was wrong
with it.

### Checklist

- **Nothing at head references it.** Check both the language-server view and a text search for
  the name. The ones to catch are string references: `mock.patch` targets, `vi.mock` paths,
  config entries, docs and runbooks.
- **It isn't reachable through reflection or registration.** Decorators, signal receivers,
  entry points, fixtures, CLI subcommands that register by import side effect.
- **It isn't part of a public surface.** If it is, the removal needs a deprecation cycle or a
  stated break.
- **The leftovers went too.** Its tests, fixtures, mocks, constants, imports that only it used,
  and docs. A PR that deletes the function but leaves its test file importing nothing is
  half done.
- **What it used to call is now unreachable too.** Dead code often has dead dependencies.
  Either remove them in this PR or say they follow.

### How it combines with domain playbooks

It narrows them to nothing for the deleted lines. A domain playbook matters only if the code
was reachable in a way static search can't see, which is the question above. On a critical
path ([code on the critical path](../../Code-Review-Guide-and-Playbooks.md#code-on-the-critical-path)),
"unused" claims need stronger evidence than a clean reference search: production logs or
metrics showing no calls.

### Red flags

- A "dead code" PR that also changes live code.
- A deleted function whose name appears in a string at head.
- Deleting a function that one test, and nothing else, called. The test was the only user
  because the feature is gone, or because the test was about to be needed.
- "Unused" code deleted from a library whose consumers live in other repos.

### Worked example

```diff
--- a/billing/legacy.py
+++ b/billing/legacy.py
-def format_invoice_v1(invoice: Invoice) -> str:
-    ...
--- a/tests/billing/test_legacy.py
+++ b/tests/billing/test_legacy.py
-def test_format_invoice_v1(): ...
```

A good review confirms no references at base beyond the test, then runs
`rg "format_invoice_v1|billing.legacy"` and finds an entry in
`config/schedule.yaml` naming `billing.legacy.format_invoice_v1`. That's the finding.

### ai-review-bot today

The bot sees only the red lines, and when the diff is over budget deletion-only hunks are
dropped from the prompt. It can't search for remaining references, so "unused" is taken on the
author's word. Agents may comment on the quality of the deleted code, which is wasted. What it
would need: a references and string search at base and head.

### Eval seed

On a removal of a function whose only remaining mention is a task name in a YAML schedule, the
review flags the schedule entry and says nothing about the deleted body.

## DEL-02: Feature removed

```yaml
id: DEL-02
name: Feature removed
family: deletion
aliases: [sunset, remove endpoint, rip out, retire]
signals:
  - a route handler, CLI command, UI screen or job deleted together with its models, tests and docs
  - a large net-negative diff across many layers
  - description or ticket says "remove", "sunset" or "retire"
  - feature flag or config key for it deleted
narrows_playbooks: true
escalates_with: [public-api, data-write, migration, critical-path]
guide_refs:
  - "#endpoint-schema-changes-versioning-and-deprecation"
  - "#migrations-and-deployment-sequencing"
  - "#background-jobs-queues-and-events"
  - "#readability-and-review"
tools: [lsp-references, lsp-call-hierarchy, ripgrep, module-graph, linked-work-item]
bot_visibility: partial
```

### What it looks like in a diff

A vertical slice vanishes: the route, the service it called, the model, the serializer, the
tests, the template, the docs page. Often one or two live files change a little to unregister
it: a router include, a navigation menu entry, a settings key.

### How to recognize it

Many deletions across layers that reference each other, plus small edits at the registration
points. The deleted files form a connected group in the import graph, and the only edges that
leave the group go to the few files edited in the PR.

Look-alikes to rule out:

- **Partial removal.** Part of the feature is gone and the rest still runs, now with a hole.
- **Feature moved to another service.** Deleted here, added elsewhere. The deletion is correct
  only if the destination is live.
- **Flag cleanup.** One branch of a feature flag removed. See [DEL-09](#del-09-feature-flag-cleaned-up).

### Likely intents

A product decision to sunset, a replacement shipped earlier, or a migration to another
system. The ticket should say which. A feature removal with no ticket is a question for the
author before it's a question about code.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Is the deleted set closed? | Go to References on each entry point | `lsp-references`, `module-graph` for edges leaving the group |
| Are there outside consumers (clients, other services, cron, webhooks)? | Check API docs, access logs, other repos | `ripgrep` for route paths and event names; `linked-work-item` |
| What data does it own? | Read the models | `read-file` on the deleted models and their migrations |
| What was queued or scheduled for it? | Search for task and event names | `ripgrep` for task names, queue names, cron entries |
| How was it deprecated? | Check for `Deprecation`/`Sunset` headers, a changelog entry | `read-file`, `ripgrep` |

### What not to spend review on

The deleted code's internals. Review the boundary of the removal, not the removed material.

### Checklist

- **Deprecated before removed.** For anything with outside callers, the
  [endpoint playbook](../../Code-Review-Guide-and-Playbooks.md#endpoint-schema-changes-versioning-and-deprecation)
  says removal is its own PR, after usage reaches zero or the sunset date has passed. Ask for
  the usage evidence.
- **The registration points are all updated.** Router includes, nav menus, OpenAPI tags, CLI
  command lists, permission or role definitions, feature flag defaults, docs indexes.
- **In-flight work is drained.** Queued messages, scheduled jobs and retries naming the
  removed handlers. The
  [background jobs playbook](../../Code-Review-Guide-and-Playbooks.md#background-jobs-queues-and-events)
  covers the consumer side: a message with no handler goes to a dead letter queue, or fails
  forever.
- **Data is handled on purpose.** Tables, columns, stored files and cache keys the feature
  owned are either left alone (and the PR says so) or dropped in a later migration step. A
  code removal that also drops tables in the same release breaks any old instance still
  running during the deploy: see [DEL-10](#del-10-schema-element-dropped).
- **Dependent features are checked.** Something else may have read this feature's data, called
  its endpoint, or listened to its events.
- **Observability cleaned up.** Dashboards, alerts and log queries for the removed feature
  should go with it, or they'll page on silence.
- **Tests and docs are removed as well**, not left testing nothing.

### How it combines with domain playbooks

It narrows them for the deleted code and widens them at the seams. The seams are what the
playbooks for [migrations](../../Code-Review-Guide-and-Playbooks.md#migrations-and-deployment-sequencing),
endpoints and [auth](../../Code-Review-Guide-and-Playbooks.md#authentication-and-authorization)
cover: if the feature owned a permission or a role, check that deleting it doesn't leave a
policy referencing a missing name.

### Red flags

- Removal of an endpoint that logs show is still called.
- Route removed in the same PR that introduces its replacement with different semantics.
- A deleted background consumer for a queue that producers still write to.
- Migration dropping tables in the same PR as the code removal.
- Permissions or roles deleted without a check of who holds them.

### Worked example

A PR removes `/v1/reports/export`, its service, tests and docs. Search finds a nightly job in
`jobs/schedule.py` that still POSTs to it, and a mobile client version in `docs/clients.md`
that lists it as required. The comments are the job and the client, plus a request for the
last-seen traffic date.

### ai-review-bot today

The bot reviews the PR as a pile of deletions with a few small edits. It can't see callers
outside the diff, queues, schedules or clients. Because a removal is mostly deletion-only
hunks, a diff over the budget loses all of them, including the hunks that unregister the
feature. What it would need: reference and string search at head, and the
ticket.

### Eval seed

On a removal of an endpoint whose route is still called from a scheduled job, the review flags
the job and does not comment on the deleted handler.

## DEL-03: File deleted

```yaml
id: DEL-03
name: File deleted
family: deletion
aliases: [dangling import, broken reference, orphaned reference]
signals:
  - a file deleted, no added file with matching content
  - imports of the deleted module still present in files the PR doesn't touch
  - config, CI or Docker steps naming the deleted path unchanged
  - a test that mocks or patches the deleted module's path unchanged
narrows_playbooks: false
escalates_with: [public-api, critical-path]
guide_refs:
  - "#review-locally-not-only-in-the-browser"
  - "#compatibility-hyrums-law"
tools: [pr-files-api, ripgrep, lsp-references, module-graph, ci-results]
bot_visibility: none
```

### What it looks like in a diff

The deletion looks complete: a file removed, maybe its test. What the diff can't show is the
untouched files that still mention it. The PR is incomplete, and CI may or may not say so,
depending on the reference.

### How to recognize it

Take each deleted path and search head for references. A static import of a deleted module
fails at import time, so type checkers and the test run catch it. The ones CI misses are
references that resolve lazily or only in some environments:

- a function-level or conditional import
- `importlib.import_module("pkg.old")`, `import()`, `require(variable)`
- a string path in `mock.patch`, `vi.mock` or `jest.mock` that the test never hits
- a path in `pyproject.toml`, `package.json`, `tsconfig` `paths`, a Dockerfile `COPY`, a CI
  workflow, `CODEOWNERS`, a coverage or lint exclusion
- a template, SQL file, or docs page that includes the file
- a framework registry: `INSTALLED_APPS`, a plugin list, a route table

### Likely intents

The author meant to delete it, believed it was unreferenced, and missed the indirect uses.
This operation is a mistake with no intent behind it. The entry exists so it gets caught.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Does anything at head name this path or module? | Search across files | `ripgrep` for the path, dotted module, and basename |
| Does anything import it statically? | Go to References before checkout | `lsp-references`, `module-graph` |
| Did the PR's CI run import the paths that matter? | Check check runs | `ci-results` |
| What did the file export? | Read it at base | `read-file` at base, `file-outline` |

### What not to spend review on

The deleted file's contents.

### Checklist

- **Every reference is removed or retargeted.** Not just imports: patch targets, config, CI,
  Dockerfiles, docs, `CODEOWNERS`.
- **Lazy imports.** A conditional import is a runtime failure on the first request that takes
  that branch.
- **Mocks that no longer patch anything.** `mock.patch("pkg.old.fn")` against a deleted module
  raises at patch time; `create=True`, `autospec` skipped or a string that matches a still-
  existing module can pass vacuously.
- **Coverage and lint config.** An exclude or include list naming the deleted path should
  lose the entry. One that now matches nothing hides a real gap if the path was meant to move.
- **A re-export for external consumers**, if the module was importable from outside.

### How it combines with domain playbooks

It widens them: the reference that survived sits in code that was reviewed in a world where
the deleted file existed. If the surviving reference is in an auth or input-validation path,
that domain's playbook applies to the fallout.

### Red flags

- CI green. Missing coverage of the lazy import is why this slips through.
- Deleting a module and its test in the same PR with no search evidence in the description.
- A `# noqa` or `# type: ignore` newly added on an import line elsewhere in the same PR.

### Worked example

`utils/legacy_dates.py` is deleted along with its test. Static imports are gone, tests pass.
`rg "legacy_dates"` finds `from utils import legacy_dates` inside a function body in
`reports/export.py`, run only by a monthly job. That's the finding, and it's a blocker.

### ai-review-bot today

The bot cannot search head for the deleted path. It sees the deletion hunk (if not dropped
for budget) and the diff of files the PR touches. A reference in an untouched file is
invisible. What it would need: a ripgrep over head for each deleted path and module name.

### Eval seed

On a PR that deletes a module still imported inside a function in an untouched file, the
review flags that import and names the deleted module.

## DEL-04: Guard or check removed

```yaml
id: DEL-04
name: Guard or check removed
family: deletion
aliases: [validation removed, precondition dropped, early return removed, assert removed]
signals:
  - 'an `if ...: raise` / `return` / `throw` / `continue` removed with no added lines'
  - an `assert`, schema validation call, permission check or null check deleted
  - a decorator or middleware (auth, rate limit, idempotency) removed from a function
  - a removed `try/except` or `try/catch` that was narrowing the failure
  - a description saying "simplify", "clean up" or "remove redundant"
narrows_playbooks: false
escalates_with: [trust-boundary, auth, data-write, money, critical-path, concurrency]
guide_refs:
  - "#review-locally-not-only-in-the-browser"
  - "#readability-and-review"
  - "#fail-fast-on-every-path"
  - "#ai-generated-and-ai-assisted-code"
  - "#least-privilege-and-trust-boundaries"
tools: [lsp-references, lsp-call-hierarchy, ripgrep, blame-C, log-L, ci-results, linked-work-item]
bot_visibility: partial
```

### What it looks like in a diff

The guide's `charge()` example is this operation: five lines removed, a PR titled "simplify
charge", nothing added.

```diff
     def charge(self, invoice: Invoice) -> Payment:
-        if invoice.status is InvoiceStatus.PAID:
-            raise InvoiceAlreadyPaid(invoice.id)
-        if invoice.total.amount_minor <= 0:
-            log.info("zero_invoice_skipped", invoice_id=invoice.id)
-            return Payment.skipped(invoice.id)
         return self._gateway.charge(invoice.customer.payment_method, invoice.total)
```

In TypeScript the same shape is `if (!user.isAdmin) throw new Forbidden()` removed, a Zod
`.parse` call dropped, or `@UseGuards(...)` deleted from a controller method.

### How to recognize it

A hunk with removed lines and no added lines, where the removed lines contain a conditional
whose body raises, returns early, logs-and-skips or aborts. The signature of a guard is that
the code after it is written assuming it ran. Also look for a guard whose *condition* was
weakened or whose *exception type* changed. That's a behavior change ([behavior.md](behavior.md)),
not a deletion, though it starts the same way.

Look-alikes to rule out:

- **The guard moved.** An equivalent check now lives in a caller, a decorator, a validator at
  the boundary, or a type. That's a relocation of protection ([relocation.md](relocation.md)).
- **Genuinely redundant.** The same check runs one frame up on every path.
- **Test-only guard.** A defensive check that existed for a case the type system now rules out.

### Likely intents

1. **Redundancy.** The guard is checked upstream now, and the author is removing the second
   copy.
2. **The case is impossible.** A type or schema now excludes it.
3. **Unblocking something.** The guard got in the way of a feature, and removing it was easier
   than designing around it. This is the dangerous one, and it's rarely written down.
4. **Generated code tidying.** AI-written diffs commonly remove guards and retries with no
   reason given. The guide lists
   [unexplained removals](../../Code-Review-Guide-and-Playbooks.md#ai-generated-and-ai-assisted-code)
   among the characteristic failures.

### Context to gather

This is the guide's six-question sequence, with the agent tool for each.

| Question | Human action | Agent tool |
| --- | --- | --- |
| Was the guard moved or dropped? | Search the branch for the exception, log event or condition | `ripgrep` for `InvoiceAlreadyPaid`, `zero_invoice_skipped` at head |
| Who relied on it? | Go to References / Call Hierarchy on the enclosing function | `lsp-references`, `lsp-call-hierarchy` for retrying jobs, multiple entry points |
| What happens to the input it blocked now? | Follow the call into the next layer | `read-file` on the callee at head, `lsp-definition` |
| What is left orphaned? | References on the exception class, helper or constant it used | `lsp-references` on `Payment.skipped`, `InvoiceAlreadyPaid` |
| Why was it there? | Git blame / Timeline on the removed lines | `blame-C`, `log-L`, `git log -S` to find the commit and its issue |
| Is it tested? | Run the tests for the package | `ci-results`; and does any test fail if the guard is absent? |

### What not to spend review on

Style or naming of the surviving lines. The review is about what is no longer enforced.

### Checklist

- **Find where the guard lives now**, or the reason it isn't needed. "Simplify" doesn't
  answer that. If it moved, point to the line. If a type now rules it out, point to the type.
  If the answer is nowhere, the PR needs a reason in its description.
- **Callers that depended on the exception or skip.** Handlers that caught the removed
  exception are now dead code. Callers that retried, or called twice for the same input, now
  do the thing twice.
- **The downstream rejects what the guard blocked, or it doesn't.** If the next layer errors
  on zero, a skip has become an error. If it accepts it, a no-op has become a real action.
- **A test fails without the guard.** If the suite is green with the guard gone, the behavior
  was untested. The comment asks to restore the guard, or to show where it lives and add a test.
- **Orphans removed**, not stranded: the exception class, its handler, the constant, the log
  event name that dashboards watch.
- **For auth or trust-boundary guards, assume removal is a vulnerability** until a replacement
  is shown. The
  [auth playbook](../../Code-Review-Guide-and-Playbooks.md#authentication-and-authorization)
  and [trust-boundary rules](../../Code-Review-Guide-and-Playbooks.md#least-privilege-and-trust-boundaries)
  set the bar.

### How it combines with domain playbooks

It widens them. The guard existed because of the domain, so the domain's playbook is the
test for whether removal is acceptable: money paths use the
[critical-path](../../Code-Review-Guide-and-Playbooks.md#code-on-the-critical-path)
playbook, user input uses
[input validation](../../Code-Review-Guide-and-Playbooks.md#code-that-validates-user-input),
and permissions use the auth playbook. The removal is judged against what that playbook says
the code must enforce.

### Red flags

- Removed lines with no added lines in a function that moves money, changes permissions or
  writes data.
- A description that says "simplify" and doesn't name where the check went.
- A guard removed in the same PR as a new caller that bypasses the layer it lived in.
- The exception class still raised nowhere, still caught in several places.
- A deleted `assert` used as input validation. Asserts are stripped under `python -O`, so
  check whether production ran with it. If so the guard never protected anything and the real
  finding is that validation was missing.

### Worked example

The `charge()` diff above. A good review:

1. Searches `InvoiceAlreadyPaid`: nothing raises it, and `api/errors.py` still maps it to a
   409. Dead handler.
2. Checks references on `charge`: `retry_failed_invoices()` calls it again after a timeout.
   Without the paid-check, a charge that succeeded but timed out is charged twice.
3. Follows `_gateway.charge` and finds the provider rejects zero amounts, so the skip is now
   an exception.
4. Marks the comment a blocker: restore both guards, or show where they went and add a test
   for double payment.

### ai-review-bot today

This is the case `packDiff()` handles specially. Deletion-only hunks are shown when the whole
diff fits, so a change that only removes a guard is reviewed. When the diff is over budget, all
deletion-only hunks are dropped and counted in a note under each file header, so the
removal can disappear from the prompt. Even when it's visible, the agents can't search for the
exception, the callers, or the blame. They can only reason from the removed lines and the
context lines around them, which is often enough to ask "where did this check go?" but not to
answer it. What it would need: reference and string search, and the history of the removed
lines.

### Eval seed

On a diff that removes a paid-invoice check and a zero-amount skip with no added lines, the
review asks where each guard now lives and names the retry caller that would double-charge.

## DEL-05: Retry, fallback, timeout or error handling removed

```yaml
id: DEL-05
name: Retry, fallback, timeout or error handling removed
family: deletion
aliases: [remove retry, remove try/except, drop fallback, remove timeout]
signals:
  - a retry decorator or loop deleted
  - a `try/except` or `try/catch` removed, leaving the call bare
  - a `timeout=` argument, `AbortSignal`, circuit breaker or backoff removed
  - a fallback value or default branch deleted
  - a description saying the retry was "pointless" or "masking errors"
narrows_playbooks: false
escalates_with: [critical-path, concurrency, data-write, money]
guide_refs:
  - "#fail-fast-on-every-path"
  - "#readability-and-review"
  - "#code-on-the-critical-path"
  - "#background-jobs-queues-and-events"
  - "#logging-and-error-logging"
tools: [blame-C, log-L, lsp-call-hierarchy, ripgrep, ci-results, linked-work-item]
bot_visibility: partial
```

### What it looks like in a diff

`@retry(stop=stop_after_attempt(3))` removed from a function, a `for attempt in range(3)` loop
flattened to one call, an `await fetch(url, { signal: AbortSignal.timeout(5000) })` becoming
`await fetch(url)`, or a `try: ... except TimeoutError: return cached` reduced to the call.

### How to recognize it

The surviving call is the same, and what disappeared is the machinery around it: attempts,
waits, caps, a catch, a default. Compare to [DEL-04](#del-04-guard-or-check-removed):
a guard rejects input, while this machinery handles failures of the thing being called.

This operation cuts both ways. The guide's Fail Fast rule objects to retries and broad
catches that turn failures into wrong results, so removing a swallowed error can be the right
change. The skill is telling that apart from removing a retry that kept a flaky dependency
tolerable.

### Likely intents

1. **Fail loud.** A broad `except` was hiding errors, and removing it is the fix.
2. **Move retries to a better layer.** The queue retries now, or an HTTP client library does.
3. **Remove double retry.** Two layers retried, multiplying attempts.
4. **Making something work.** A timeout or fallback was removed because it triggered in a
   test, not because it was wrong.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Why was it added? | Git blame / Timeline | `blame-C`, `log-L`, `git log -S`; look for an incident or issue link |
| Is a retry or timeout now provided elsewhere? | Read the caller and the client config | `lsp-call-hierarchy`, `ripgrep` for `retry`, `timeout`, `backoff`; `read-file` on client setup |
| What are the callers' expectations on failure? | Go to References | `lsp-references`: do they catch what is now raised? |
| Is the call idempotent? | Read the called API | `read-file`, `linked-work-item` |
| Does CI exercise the failure path? | Check tests | `ci-results` |

### What not to spend review on

The shape of the surviving call.

### Checklist

- **Where does failure go now?** A removed `except` means the exception reaches the caller,
  which may not handle it, which may crash a worker, return a 500 or abort a batch halfway.
- **A removed retry has a replacement or a justification.** Check the layer above and below
  (queue redelivery, client library, load balancer). If none, a transient error is now
  permanent.
- **A removed timeout is not a hang.** Calls with no timeout wait as long as the peer
  chooses. Python's `requests` has no default timeout, so removing the argument means waiting
  indefinitely. Check the client's defaults for other libraries.
- **A removed fallback changes what the user sees.** Cached or default values hid an outage; now
  there's an error page.
- **Log lines and metrics that fired on the removed path** are gone too. Alerts keyed to them
  go silent. See [logging](../../Code-Review-Guide-and-Playbooks.md#logging-and-error-logging).
- **Idempotency.** Removing a retry is safe for correctness; removing a *dedupe* around a
  retry is not.

### How it combines with domain playbooks

It widens the critical-path and background-job playbooks. On a critical path, tolerance for
failure was a requirement, so removal needs the same justification as adding code would.
In job handlers, the
[retry rules](../../Code-Review-Guide-and-Playbooks.md#background-jobs-queues-and-events)
(backoff, maximum, dead letter, transient vs. permanent) say what must remain true after the
change.

### Red flags

- A removal justified only by "the test was flaky".
- A bare `except:` or `catch {}` removed and nothing changed in the handler above it, which
  presumably also swallows.
- A circuit breaker removed from a call to a service with known outages.
- A timeout removed from a call made inside a request handler.

### Worked example

`@retry` is removed from `fetch_rates()` with the description "retries mask real failures".
Call hierarchy shows `fetch_rates` runs in a Celery task with `autoretry_for=(Exception,)`
and `max_retries=5`, so retry moved a layer up and the removal is fine. The review says so in
one line and checks that the task's retry is idempotent. Had the caller been a request
handler, the finding would be a user-facing error on any blip.

### ai-review-bot today

Visible if the diff fits. The silent-failure-hunter agent is well placed to judge a removed
`except`, but none of the agents can look at what retries above or below the call. What it
would need: caller lookup and the blame message for the removed lines.

### Eval seed

On a removed retry decorator in a function called from a request handler, the review asks what
retries now and names the user-visible failure.

## DEL-06: Deprecation shim added

```yaml
id: DEL-06
name: Deprecation shim added
family: deletion
aliases: [deprecation alias, re-export, compatibility layer, deprecated wrapper]
signals:
  - old name kept as an alias or thin wrapper around the new one
  - '`warnings.warn(..., DeprecationWarning, stacklevel=2)` added'
  - '`@deprecated` (JSDoc) or `typing_extensions.deprecated` on an old symbol'
  - an old import path kept as a re-export
  - an old env var or config key still read, with a warning
narrows_playbooks: neutral
escalates_with: [public-api]
guide_refs:
  - "#compatibility-hyrums-law"
  - "#endpoint-schema-changes-versioning-and-deprecation"
  - "#configuration-files"
tools: [lsp-references, ripgrep, read-file, linked-work-item]
bot_visibility: partial
```

### What it looks like in a diff

The new symbol is defined and the old one becomes a stub:

```python
def parse_invoice(raw): ...

def parse_line_items(raw, strict=False):  # old name
    warnings.warn("parse_line_items is deprecated; use parse_invoice",
                  DeprecationWarning, stacklevel=2)
    return parse_invoice(raw)
```

In TypeScript, a `/** @deprecated use parseInvoice */` tag on a function that forwards to its
replacement, or `export { parseInvoice as parseLineItems }` in an index file.

### How to recognize it

An old public name that still exists but does no work of its own, alongside a new name that
does. A warning or deprecation tag is the usual marker; a bare alias with no warning is a
shim that nobody is told about.

### Likely intents

This is the careful half of a rename or removal: the author is following the guide's
"deprecate for at least one release before removing". It pairs with the interface change that
made the shim necessary (a rename in [IFC-01](interface.md#ifc-01-function-signature-changed)
or [IFC-05](interface.md#ifc-05-env-var-or-config-key-renamed)).

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Who still uses the old name? | Go to References | `lsp-references`; `ripgrep` across other repos if available |
| Does the shim forward exactly? | Compare the two | `read-file` |
| Is there a removal plan? | Read description and ticket | `linked-work-item` |

### What not to spend review on

The forwarding body, if it's one line.

### Checklist

- **The shim is behavior-identical to the old code**, including defaults, exceptions and
  return type. A shim that differs without saying so is a change disguised as compatibility.
- **The warning is useful.** `stacklevel=2` so it points at the caller; a message naming the
  replacement; a category that surfaces (`DeprecationWarning` is hidden by default outside
  `__main__` and test runners, so libraries sometimes use `FutureWarning` for end users).
- **There's an end.** A removal release or date, written in the shim's comment, docstring or
  ticket. Shims without one live for years.
- **Internal callers moved to the new name**, so the shim has only outside users and the
  warning isn't fired by the code's own tests.
- **Type checkers see the deprecation** where possible, so callers get a diagnostic in the
  editor.

### How it combines with domain playbooks

Neutral. For HTTP endpoints, the
[endpoint deprecation steps](../../Code-Review-Guide-and-Playbooks.md#endpoint-schema-changes-versioning-and-deprecation)
(`Deprecation` and `Sunset` headers, usage metering) are the domain version of this.

### Red flags

- A shim that adds behavior.
- A deprecation warning fired on a hot path with no rate limit.
- A shim added for a symbol that had no outside users, which is code the project didn't need.
- Internal code still importing the deprecated name.

### Worked example

`parse_line_items` is renamed to `parse_invoice` with a forwarding shim. The shim forwards
`raw` but the old function's second parameter `strict=False` is dropped, so keyword callers
now get `TypeError`. That's the finding: the shim isn't compatible.

### ai-review-bot today

The agents see the shim as new code and may judge it as redundant indirection. They can't
see who calls the old name. What it would need: the call count of the old name and a link to
the removal plan.

### Eval seed

On a rename with a forwarding shim that drops a keyword parameter, the review flags the
dropped parameter and does not call the shim unnecessary.

## DEL-07: Deprecation shim removed

```yaml
id: DEL-07
name: Deprecation shim removed
family: deletion
aliases: [remove deprecated alias, finish deprecation, drop compat layer]
signals:
  - a function, class or re-export carrying `DeprecationWarning` or `@deprecated` deleted
  - an old config key, env var or import path no longer accepted
  - a description saying "remove deprecated X" or "remove after N releases"
  - a major version bump or changelog "Removed" entry
narrows_playbooks: neutral
escalates_with: [public-api]
guide_refs:
  - "#compatibility-hyrums-law"
  - "#endpoint-schema-changes-versioning-and-deprecation"
tools: [lsp-references, ripgrep, linked-work-item, read-file]
bot_visibility: partial
```

### What it looks like in a diff

The red lines include a deprecation warning or tag. The old name is gone, and nothing else
in the diff changes, unless an internal caller was still on the old name.

### How to recognize it

The deleted symbol has a deprecation marker at base. That marker is the author's own promise,
so the review checks whether it has been kept.

### Likely intents

The planned last step of a deprecation: usage reached zero or the announced window ended. If
the marker says "removed in 3.0", this is that release.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| What did the deprecation promise? | Read the warning text and docstring | `read-file` at base |
| When was it deprecated? | Blame the marker | `blame-C`, `log-L`, `git log -S "DeprecationWarning"` |
| Is anything still on the old name? | Go to References | `lsp-references`, `ripgrep` in repo and docs |
| Is this a release that allows removal? | Check version and changelog | `read-file` on `pyproject.toml` / `package.json` and the changelog |
| Is there evidence of usage? | Check metrics or logs | `linked-work-item` |

### What not to spend review on

The shim body.

### Checklist

- **The promised window has passed.** At least one release since the deprecation, longer if
  the library has outside users.
- **Internal callers are on the new name**, including tests, docs and examples.
- **The version bump and changelog match.** A removal in a patch release is a break labelled
  as a fix.
- **Related deprecations are consistent.** If one alias is removed and its sibling stays, ask
  whether that is intended.
- **Error behavior for users still on the old name is helpful.** `AttributeError: module has
  no attribute 'x'` is worse than a short `ImportError` naming the replacement when the
  project can afford one.

### How it combines with domain playbooks

Neutral. If the shim was for an endpoint field or path, the endpoint playbook's "remove last"
step applies: usage at zero, or the sunset date passed with notice given.

### Red flags

- Removal in the same PR that adds the deprecation.
- A removed alias with active callers in the repo's own tests or docs.
- No changelog entry.

### Worked example

`parse_line_items` was deprecated eleven days ago per blame, and the changelog says "to be
removed in 3.0". The PR removes it in a 2.4.1 patch branch. The comment cites the promise and
the version.

### ai-review-bot today

The bot sees only the deleted lines, and may read the deprecation warning text in the hunk. It
can't see when the marker was added, how many callers remain, or the release plan.

### Eval seed

On a removal of a function deprecated in the previous release, shipped in a patch version, the
review flags the version and changelog, not the deleted body.

## DEL-08: Last member of a file removed

```yaml
id: DEL-08
name: Last member of a file removed
family: deletion
aliases: [empty the file, close out module, remove module]
signals:
  - a file deleted after its last remaining symbol is deleted or moved in the same PR
  - a file reduced to imports, a docstring or `pass`
  - a package `__init__.py` or barrel entry removed
  - the surviving file's last definition moved elsewhere
narrows_playbooks: true
escalates_with: [public-api]
guide_refs:
  - "#single-responsibility-and-cohesion"
  - "#review-locally-not-only-in-the-browser"
tools: [pr-files-api, lsp-references, ripgrep, module-graph, color-moved]
bot_visibility: none
```

### What it looks like in a diff

A file is deleted, and the contents of its definitions went to a different file (a move) or
nowhere (a deletion). The origin notes describe this case. The moved function was the last thing in its file, so the file is gone.

### How to recognize it

The file's status is `removed`. Match its removed definitions against added ones elsewhere
in the PR. Each one is either moved ([REL-01](relocation.md#rel-01-function-or-class-moved-between-files)),
deleted ([DEL-01](#del-01-dead-code-removed)), or rewritten. The file deletion adds only the
housekeeping on top.

### Likely intents

The cohesion move or dead-code cleanup that emptied the file. The deletion itself follows from
that.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Where did each symbol go? | Compare removed and added blocks | `color-moved`, `ripgrep` for each symbol name |
| Does anything still reference the file path? | Search | `ripgrep` for the module path, `lsp-references` |
| Does the package structure change? | Check `__init__`, barrels | `read-file`, `module-graph` |

### What not to spend review on

The content that moved or was deleted.

### Checklist

- **Every symbol is accounted for**: moved, deleted on purpose, or a miss. Make a list of the
  file's definitions at base and tick each.
- **Housekeeping went with the file.** Its test file, `__init__` / barrel line, docs, coverage
  and lint config entries, `CODEOWNERS`.
- **References resolve** to the new location, per [DEL-03](#del-03-file-deleted).
- **A directory left empty** is removed, or kept deliberately.
- **No leftover single-file package** (`pkg/__init__.py` re-exporting from one module) that
  now serves no purpose.

### How it combines with domain playbooks

It narrows them, as the relocation entry does. Any symbol that was *deleted* rather than moved
is reviewed per DEL-01 and DEL-04.

### Red flags

- A file deletion where one of its definitions appears in no added hunk and has callers.
- The test file for the deleted module left behind, importing nothing and testing nothing.

### Worked example

`orders/helpers.py` has three functions at base. Two appear in `orders/service.py`. The third,
`normalize_sku`, appears nowhere, and `rg normalize_sku` finds a caller in `import_csv.py`.
That's the finding.

### ai-review-bot today

The bot sees a file deletion and some added code, with no link between them, so it reviews the
moved code as new. See [REL-01](relocation.md#rel-01-function-or-class-moved-between-files).
What it would need: per-symbol move detection and a search for what became of each definition.

### Eval seed

On a PR that empties a three-function module, moving two functions and dropping the third,
the review identifies the third as unaccounted for and names its caller.

## DEL-09: Feature flag cleaned up

```yaml
id: DEL-09
name: Feature flag cleaned up
family: deletion
aliases: [flag removal, rollout complete, remove experiment]
signals:
  - an `if flags.enabled("x")` / `if (isEnabled("x"))` conditional removed, one branch kept
  - a flag definition deleted from config or the flag service
  - the "off" branch deleted
  - description says "flag fully rolled out" or "experiment concluded"
narrows_playbooks: true
escalates_with: [critical-path, data-write]
guide_refs:
  - "#configuration-files"
  - "#compatibility-hyrums-law"
  - "#readability-and-review"
tools: [ripgrep, lsp-references, blame-C, linked-work-item, read-file]
bot_visibility: partial
```

### What it looks like in a diff

A conditional on a flag disappears and one of its two branches stays in place, un-indented.
The other branch is deleted. The flag's definition is removed from config.

### How to recognize it

Compare the surviving code to the branch it replaced. The lines of the kept branch are
unchanged apart from indentation (the diff with whitespace ignored shows nothing but the
conditional's removal). The flag name appears in the deleted conditional and in the config
deletion.

### Likely intents

The guide notes that "stale flags are dead code with a switch". This is the removal of one:
the rollout finished or the experiment ended.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Which branch is live in production? | Check the flag's production value | `linked-work-item`; the flag service if reachable; `read-file` on config defaults |
| Is the kept branch the one production runs? | Compare to the flag state | same as above |
| Does the flag appear anywhere else? | Search | `ripgrep` for the flag name, in all languages, tests, docs, dashboards |
| Is the flag read by other services? | Check flag consumers | `ripgrep` in other repos if available |

### What not to spend review on

The kept branch, if it's unchanged.

### Checklist

- **The kept branch is the live one.** Keeping the "on" branch when production runs "off" (or
  the reverse) is a behavior change dressed as cleanup. Check this one first.
- **Every read of the flag is gone.** Other files, other services, frontend and backend both.
  An orphaned reader falls back to the flag service's default, which may be the wrong one.
- **Config and defaults deleted.** Flag definitions in code, YAML, and the flag service itself.
- **Tests only exercise the kept path now**, and tests of the removed path are removed.
- **Per-user or per-tenant overrides** are considered. A flag at 100% by default may be off for
  a few accounts on purpose.
- **Data written by the removed branch** is still readable by the kept one.

### How it combines with domain playbooks

It narrows them to the verification of which branch is live. If the flag guarded a migration
or a write path, the
[migrations playbook's](../../Code-Review-Guide-and-Playbooks.md#migrations-and-deployment-sequencing)
expand and contract sequence says whether the old path can go yet.

### Red flags

- Cleanup of a flag still at less than 100% rollout.
- Both branches changed in the same PR.
- Flag removed from code but not from the flag service, or the other way around.

### Worked example

`if flags.enabled("new_checkout")` is removed and the new branch kept. The config default is
`false` and the production flag state, per the ticket, was rolled back last week. The kept
branch is the one production isn't running. That's the finding.

### ai-review-bot today

The bot sees the conditional vanish and the branch remain. It can't see the flag's state, so
it can't tell which branch should have won. What it would need: flag state from the linked
ticket or config, and a search for other readers.

### Eval seed

On a flag cleanup that keeps the branch the config default disables, the review flags the
mismatch and doesn't comment on the kept code.

## DEL-10: Schema element dropped

```yaml
id: DEL-10
name: Schema element dropped
family: deletion
aliases: [drop column, drop table, drop index, drop constraint]
signals:
  - a migration containing `DROP COLUMN`, `DROP TABLE`, `drop_column`, `op.drop_table`, `dropIndex`
  - a model field or class deleted together with its migration
  - an ORM attribute removed
narrows_playbooks: false
escalates_with: [migration, data-write, critical-path]
guide_refs:
  - "#migrations-and-deployment-sequencing"
  - "#data-modeling-tables-relationships-and-domain-objects"
  - "#readability-and-review"
tools: [ripgrep, lsp-references, blame-C, linked-work-item, read-file]
bot_visibility: partial
```

### What it looks like in a diff

A migration file with a drop statement, usually alongside the model change, in a path
`classifyTier()` already treats as complex (`migration`, `schema`, `/db/`).

### How to recognize it

A drop in a migration, or a model attribute removed that maps to a column. Deleting the model
attribute in code without a migration leaves the column in place, which is safe; the reverse
(migration without code change) breaks the app at once.

### Likely intents

The contract step of expand and contract, or a cleanup after a feature removal
([DEL-02](#del-02-feature-removed)).

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Does any code, at head or in a running old version, read the column? | Search for the name | `ripgrep` for the column name in code, SQL, templates, analytics jobs |
| Do other services or reports read it? | Ask or search other repos | `ripgrep` where possible, `linked-work-item` |
| Which migration step is this? | Read the description | `linked-work-item` |
| Why did it exist? | Blame the column's creation | `blame-C` on the original migration |

### What not to spend review on

The shape of the migration file, which the guide's migration playbook already covers.

### Checklist

The checks for drops are in the guide and aren't repeated here. The operation-specific ones:

- **The code removal shipped first.** Drops happen in a later release than the last read or
  write, per [expand, migrate, contract](../../Code-Review-Guide-and-Playbooks.md#migrations-and-deployment-sequencing).
  A drop in the same PR as the code change breaks any still-running old instance.
- **Chesterton's Fence for drops.** The guide's own line: confirm nothing reads it, including
  other services, reports, analytics jobs and old app versions.
- **Data is archived or provably disposable**, and the downgrade says honestly what it can't
  restore.

### How it combines with domain playbooks

It hands over to the migrations playbook, which owns the review. This entry only adds the
deletion-specific question of who still reads it.

### Red flags

- Column dropped and the code that stopped using it is in the same PR.
- A `DROP TABLE` with no archive step.
- A migration that drops and re-adds a column to "rename" it, losing data.

### Worked example

`legacy_notes` is dropped from `invoices`. `rg legacy_notes` finds a nightly export SQL file
under `reports/`. The comment names the file and asks for the export to change first.

### ai-review-bot today

Migration paths push the PR to the `complex` tier. The bot can read the drop but cannot search
for readers. What it would need: a column-name search over the repo and ideally over sibling
repos.

### Eval seed

On a column drop whose name appears in a report SQL file, the review flags that file and
notes the release ordering.

## DEL-11: Dependency removed

```yaml
id: DEL-11
name: Dependency removed
family: deletion
aliases: [drop package, uninstall, remove import of library]
signals:
  - a package removed from `pyproject.toml`, `requirements*.txt`, `package.json` or a lockfile
  - lockfile diff showing a package and its transitive packages disappearing
  - the last import of a library removed in the same PR
narrows_playbooks: neutral
escalates_with: [critical-path, public-api]
guide_refs:
  - "#new-dependencies"
  - "#configuration-files"
tools: [ripgrep, lsp-references, module-graph, ci-results, read-file]
bot_visibility: partial
```

### What it looks like in a diff

A manifest line goes, and with it a block in the lockfile, which can be thousands of lines. A
good PR also removes the last import of the library in code.

### How to recognize it

A removed entry in a manifest, with a matching removal in the lockfile. The guide's line:
"Dropping a dependency is reviewed for anything that still imports it indirectly, including
plugins, entry points and scripts."

### Likely intents

The library's last use went away, a standard library or existing dependency replaced it, or a
security or license concern.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Is there still an import? | Search | `ripgrep` for the package's import name (which may differ from its distribution name) |
| Does another dependency need it? | Check the lockfile | `read-file` on the lockfile: removed packages that remain as transitive |
| Do scripts, plugins or entry points use it? | Search config | `ripgrep` in `pyproject.toml` scripts, `package.json` `bin`, Dockerfiles, CI |
| Do the builds still pass? | Check CI | `ci-results` |

### What not to spend review on

Lockfile contents in detail, except for surprises. Unexpected transitive removals are worth one
question; the rest is generated.

### Checklist

- **No import left**, directly or by plugin. Packages are imported by names that differ from
  their install names (`PyYAML` is `yaml`; `@types/x` is a type-only dependency).
- **A removed package wasn't providing something implicitly.** A pytest plugin, a type stub, a
  transitive dependency that other code relied on (a phantom dependency: code importing a
  package it never declared, which worked because something else installed it).
- **Dev, build, test and runtime groups.** Removing a dev dependency used by a CI script
  breaks CI. Removing a runtime dependency used only by a script breaks that script.
- **Lockfile updated with the manifest.** A manifest change with no lockfile change is
  incomplete.
- **Replacement does what the library did**, including edge cases the old library handled.

### How it combines with domain playbooks

Neutral. The
[new dependencies playbook](../../Code-Review-Guide-and-Playbooks.md#new-dependencies) covers
adding; this is its removal clause.

### Red flags

- Manifest edited but lockfile not.
- Removal of a package that a plugin system loads by name.
- Removing a dependency and adding a hand-rolled version of it in the same PR (review that
  as new code).

### Worked example

`python-dateutil` is removed from `pyproject.toml`. `rg "dateutil"` finds no import, but
`pandas` in the lockfile depends on it, so it stays installed transitively. A script that loads
it by a built string, `importlib.import_module("date" + "util.parser")`, which the search can't
match, now relies on a package the project doesn't declare. The comment asks to
either declare it or remove the import.

### ai-review-bot today

The manifest change is visible if the file is not classified as generated. Lockfiles are
sorted last by `packDiff()`. The bot can't search for remaining imports or read the lockfile
graph. What it would need: an import search for the package name and transitive info from the
lockfile.

### Eval seed

On removal of a package whose import remains in a script, the review flags that import and
doesn't comment on the lockfile bulk.
