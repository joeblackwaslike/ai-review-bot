# Behavior operations

Code that does something different after the change than before it. Relocation and mechanical
operations narrow review, because the logic was already reviewed and the question is what the
change broke. Behavior operations do the opposite. The changed lines are new logic, so they get
a full review, and the interesting question is which parts of the guide to pull in.

An entry here mostly does three jobs the guide can't do on its own. It names the shape of the
change so the reviewer picks the right domain playbook. It says what context to fetch that the
diff doesn't carry (the failing test, the other callers, the production numbers). And it says
what the author should have supplied and didn't. The domain checklists stay in the guide, and
these entries link to them by anchor.

Behavior changes also show up inside other families. A move with a changed condition is
[REL-10](relocation.md#rel-10-move-plus-modify). A removed guard is a deletion
([deletion.md](deletion.md)). A changed signature or default is an interface change
([interface.md](interface.md)). When a PR mixes behavior with mechanical work, see
[composite.md](composite.md).

## BEH-01: New logic or feature code

```yaml
id: BEH-01
name: New logic or feature code
family: behavior
aliases: [new feature, new function, new code path, add handler]
signals:
  - added lines with no matching removed lines, in a function, class or route that did not exist at base
  - a new file under src/, app/ or a package directory, with a new test file beside it
  - a new branch (if/elif, match, switch case) in an existing function that handles a case it used to ignore
  - a new entry in a registry, router, command table or dependency container
narrows_playbooks: false
escalates_with: [public-api, trust-boundary, auth, data-write, money, critical-path]
guide_refs:
  - "#reviewing-code-against-its-spec"
  - "#size-the-change-before-reading-it"
  - "#review-in-the-order-of-make-it-work-make-it-right-make-it-fast"
  - "#building-for-needs-you-dont-have"
  - "#fail-fast-on-every-path"
  - "#tests-levels-coverage-gaps-and-tdd"
tools: [linked-work-item, read-file, lsp-references, workspace-symbols, ripgrep, ci-results, agent-instructions]
bot_visibility: partial
```

### What it looks like in a diff

Mostly green lines. In Python, a new `def` or `class` with a docstring and a matching
`test_*.py`. In TypeScript, a new exported function or route handler and a `*.test.ts`. Existing
files change at the edges: an import, a registration line, a new enum member.

### How to recognize it

There is no removed counterpart. Before calling it new, check that it is not a move from
elsewhere in the PR ([REL-01](relocation.md#rel-01-function-or-class-moved-between-files)) or a
reimplementation of something the codebase already has. A new helper whose body resembles an
existing one is a duplicate, and the guide's scope rules apply.

### Likely intents

1. The feature or ticket the PR names.
2. A supporting piece for a feature that lands in a later PR. Check that something calls it.
3. A speculative addition ("while I was here"). That is the guide's
   [building for needs you don't have](../../Code-Review-Guide-and-Playbooks.md#building-for-needs-you-dont-have).

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| What was it meant to do? | Read the ticket and spec before the diff | `linked-work-item` |
| Does the codebase already do this? | Search by name and by behavior | `workspace-symbols`, `ripgrep` |
| Who calls it? | Go to References on the new symbol | `lsp-references` |
| What conventions apply on this path? | Read the repo's instruction files | `agent-instructions` |
| Did CI exercise the new code? | Check the coverage and test results | `ci-results` |

### What not to spend review on

Lines the PR did not touch. Code next to the addition is not under review just because it shows
up as context.

### Checklist

- Every behavior in the spec maps to code, and every added behavior maps to the spec. Extras
  are a finding; so are gaps.
- The change is as small as the intent allows, and a split along a seam was considered when it
  runs past a few hundred lines.
- The domain of the new code decides the playbook: an endpoint pulls in
  [new API endpoints](../../Code-Review-Guide-and-Playbooks.md#new-api-endpoints), a validator
  pulls in [input validation](../../Code-Review-Guide-and-Playbooks.md#code-that-validates-user-input),
  a table pulls in [data modeling](../../Code-Review-Guide-and-Playbooks.md#data-modeling-tables-relationships-and-domain-objects).
  Name the playbook in the review so the author knows which standard applied.
- Nothing is added that no caller and no test uses.
- The new code is exercised by a test that would fail if its main branch were flipped.

### How it combines with domain playbooks

It widens them. This is the default case, where the full domain playbook applies to every added
line. The behavior entry's only contribution is to make sure the domain was identified.

### Red flags

- A new public name (route, export, config key, event) that the description doesn't mention.
- A new dependency pulled in for one call.
- Fallback branches and `try`/`except` that no requirement asked for, a common shape in
  AI-assisted code.
- Tests that only cover the happy path of a function whose risk is its failure path.

### Worked example

A PR adds `POST /exports` with a handler, a Pydantic model and one test posting a valid body.
The review names the endpoint and input-validation playbooks, then notes that the handler reads
`request.tenant_id` from the body, not from the session, which is the finding. It makes no
comments on the test's fixture setup, which follows the existing pattern.

### ai-review-bot today

This is the case the bot handles best, because new code is fully visible in the patch. It
cannot see the ticket, so it cannot check the change against the spec, and it cannot search for
an existing implementation. `classifyTier()` picks the tier from path keywords and line counts,
not from the kind of new code.

### Eval seed

On a new endpoint that trusts a client-supplied tenant id, the review flags the trust problem
and names the code as new surface, without asking for a spec the PR did not link.

## BEH-02: Bug fix

```yaml
id: BEH-02
name: Bug fix
family: behavior
aliases: [fix, hotfix, regression fix, patch]
signals:
  - PR title or branch starts with fix/ or "fix:", or the description links an issue labeled bug
  - a small change in production code plus a new test in the same PR
  - a new guard, a corrected comparison, a changed default, or a moved line inside an existing function
  - a regression test named after an issue number or a symptom
narrows_playbooks: false
escalates_with: [critical-path, data-write, money, concurrency, auth]
guide_refs:
  - "#tests-levels-coverage-gaps-and-tdd"
  - "#fail-fast-on-every-path"
  - "#review-locally-not-only-in-the-browser"
  - "#readability-and-review"
tools: [linked-work-item, ci-results, read-file, lsp-call-hierarchy, lsp-references, log-L, blame-C]
bot_visibility: partial
```

### What it looks like in a diff

A few changed lines in a function that has been there a while, and a test added or extended.
The test usually sets up the failing input in its first lines. In a TypeScript repo it may be an
`it("does not ...")` block, in Python a `test_..._regression` function.

### How to recognize it

The description or branch name says so. Without that, look for a test whose setup recreates a
specific bad input, and a production change that handles exactly that input. A bug fix that
"also" tidies the surrounding code is a mixed change
([CMP-01](composite.md#cmp-01-refactor-mixed-with-a-behavior-change)).

### Likely intents

1. Fix the reported symptom at the reported site.
2. Fix the root cause shared by several callers. The guide's order puts correctness first, so
   the second is better when callers are many.
3. Suppress a symptom (a catch, a default, a retry) without finding the cause.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| What was the failure? | Read the issue, the stack trace, the incident note | `linked-work-item` |
| Does the new test fail without the fix? | Check out the branch, revert the fix, run the test | `ci-results` for a base-commit run; otherwise a local run |
| Who else calls the changed function? | Show Call Hierarchy | `lsp-call-hierarchy`, `lsp-references` |
| Is the same mistake elsewhere? | Search for the same pattern | `ripgrep` |
| Why was the code written this way? | Timeline on the changed lines | `log-L`, `blame-C` |

### What not to spend review on

The rest of the function. Only the fixed path and its callers are in question.

### Checklist

- **The test fails without the fix.** The guide says the fix comes with a test that fails
  without it and says to revert the fix locally to check
  ([tests: bug fixes](../../Code-Review-Guide-and-Playbooks.md#tests-levels-coverage-gaps-and-tdd)).
  A test that passes on both sides proves nothing, and it is the commonest gap in a fix PR.
- The test reproduces the reported input, not a simplified one that avoids the trigger.
- The fix is at the cause. If the bug was a missing check in a shared function, patching one
  caller leaves the others broken.
- Sibling code with the same pattern is fixed, or named as a follow-up.
- The fix doesn't change an observable behavior other callers depend on
  ([Hyrum's Law](../../Code-Review-Guide-and-Playbooks.md#compatibility-hyrums-law)).
- Data already damaged by the bug is addressed, or the PR says it isn't. A fix to a write path
  does not repair the rows written wrongly last month.

### How it combines with domain playbooks

It widens them for the changed path: the fix to a retry loop gets the concurrency and
idempotency checks, the fix to a price calculation gets the money checks. The unchanged rest
of the function stays out of scope.

### Red flags

- No test, or a test that only asserts "does not raise".
- A fix that adds a broad `except` or a default value, hiding the symptom.
- A fix whose description names a root cause the diff doesn't touch.
- A hotfix that also reformats, renames or refactors.

### Worked example

Issue: "Invoices dated 31 January roll to 3 March." The PR changes `add_month(d)` to clamp the
day and adds `test_add_month_from_31st`. The review checks out the branch, reverts the clamp,
and confirms the new test fails with the old output. Then it searches for other date arithmetic
with the same `replace(month=...)` pattern and finds `next_billing_date`, which still has it.

### ai-review-bot today

Agents see the fix and the test as new lines. They cannot run the test, cannot see the issue,
and have no base-commit CI result, so "fails without the fix" is not checkable. `pr-test-analyzer`
can say whether a test was added; it can't say whether it would have caught the bug. What it
would need: the linked issue text in the prompt, and a base-commit test run for the new test.

### Eval seed

On a fix PR whose regression test passes against the unfixed code, the review says the test does
not reproduce the bug.

## BEH-03: Conditional or boundary change

```yaml
id: BEH-03
name: Conditional or boundary change
family: behavior
aliases: [off-by-one fix, comparison change, threshold change, flipped condition]
signals:
  - a comparison operator changed (< to <=, > to >=, == to ===, is to ==)
  - a literal threshold, limit or index changed
  - a condition negated, or and/or swapped, or a guard clause added or removed
  - a regex, a slice bound or a range() / for loop bound edited
narrows_playbooks: false
escalates_with: [money, auth, data-write, critical-path, public-api]
guide_refs:
  - "#fail-fast-on-every-path"
  - "#tests-levels-coverage-gaps-and-tdd"
  - "#constants-for-self-explanatory-literals"
tools: [read-file, lsp-references, ripgrep, linked-work-item, ci-results]
bot_visibility: full
```

### What it looks like in a diff

One or two changed lines, which makes them easy to skim. `if amount <= 0` becomes
`if amount < 0`. `items[:limit]` becomes `items[:limit + 1]`. A timeout of `30` becomes `300`.

### How to recognize it

Compare the removed and added line token by token. If the only difference is an operator, a
literal or a boolean connective, this is a boundary change. The size of the diff says nothing
about the size of the change.

### Likely intents

1. An off-by-one fix.
2. A policy change in a business rule (a limit raised, an age cutoff moved).
3. A mistake. A flipped operator is a typical way for a refactor to break something.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| What rule is this meant to implement? | Read the spec or ticket for the value | `linked-work-item` |
| What are the values at the boundary? | Work out the cases at n-1, n, n+1 | `read-file` on the function and its callers |
| Who depends on the old boundary? | Go to References, search for the literal | `lsp-references`, `ripgrep` |
| Does a test sit on the boundary? | Look for tests at exactly the threshold | `read-file` on the test file |

### What not to spend review on

The code around the changed condition, unless the condition's meaning moved.

### Checklist

- Write out the old and new behavior at the boundary itself and one step either side. The
  review comment should say which inputs now behave differently.
- A test pins each side of the boundary. The guide's "empty, one, max, max + 1" list applies
  ([fail fast](../../Code-Review-Guide-and-Playbooks.md#fail-fast-on-every-path)).
- Other places encode the same rule (a UI validation, a DB constraint, another service). They
  change together or the PR says why not.
- A changed literal is a named constant when the number carries meaning, but not when it is
  [self-explanatory](../../Code-Review-Guide-and-Playbooks.md#constants-for-self-explanatory-literals).
- Which side is the author's intent? A fix to an off-by-one should say which side was wrong.

### How it combines with domain playbooks

It widens them sharply for tiny diffs. In a payment, permission or quota check, a one-character
change is a change to the rule, and the money or auth playbook applies in full.

### Red flags

- A comparison changed inside a moved block (see [REL-10](relocation.md#rel-10-move-plus-modify)).
- A security limit or rate limit raised with no explanation.
- A boundary change with no test change.

### Worked example

`if len(password) < 8` becomes `if len(password) <= 8`. The description says "tighten password
rule". The review points out that eight-character passwords are now rejected, so the real rule
is "more than eight", which doesn't match the stated policy of "at least eight". It asks which
is intended and for tests at 7, 8 and 9.

### ai-review-bot today

The change is fully visible and the agents read it well when the line is anchored in the diff.
What is missing is the rule it should match, since the ticket isn't in the prompt, and the
other places that encode the same rule.

### Eval seed

On a PR that flips `<=` to `<` on a zero-amount check, the review states which inputs now pass
and asks for a test at the boundary.

## BEH-04: Error-handling change

```yaml
id: BEH-04
name: Error-handling change
family: behavior
aliases: [exception handling change, catch change, error path change, fallback added]
signals:
  - a try/except or try/catch added, widened, narrowed or removed
  - an exception type changed, or `raise` replaced by `return None` / a default (or the reverse)
  - '`.catch(() => {})`, `except Exception: pass`, `except: continue`, an empty catch block'
  - a status code, error message or error class changed in a handler
  - '`raise ... from err` replaced with a bare `raise`, or chaining dropped'
narrows_playbooks: false
escalates_with: [public-api, critical-path, data-write, money, concurrency]
guide_refs:
  - "#fail-fast-on-every-path"
  - "#logging-and-error-logging"
  - "#compatibility-hyrums-law"
  - "#parse-at-the-boundary-trust-the-types-inside"
tools: [lsp-call-hierarchy, lsp-references, ripgrep, read-file, ci-results]
bot_visibility: full
```

### What it looks like in a diff

New `try` blocks wrapping existing calls, `except` clauses with a changed type list, or a
function that used to raise now returning a sentinel. In TypeScript, a `catch` that logs and
returns a default, a Promise chain gaining `.catch`, or an `async` function that used to throw
now resolving to `undefined`.

### How to recognize it

Look at what the function does on failure before and after. Moving from
silent to loud is usually a fix. Moving from loud to silent is the dangerous direction, and it
rarely announces itself.

### Likely intents

1. Handle a specific, expected failure where something sensible can be done.
2. Stop a noisy error in production by swallowing it.
3. Translate a low-level error into a domain error at a boundary.
4. Make a function total, so callers no longer need to guard.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Who catches this exception today? | Call Hierarchy upward until a handler | `lsp-call-hierarchy` |
| Did callers rely on the exception? | References, look for `except X` around the call | `lsp-references`, `ripgrep` |
| What did the old failure look like to users or clients? | Status code, message, log line | `read-file` on the handler and tests |
| Is the swallowed error visible anywhere? | Search for the log or metric the catch emits | `ripgrep` |

### What not to spend review on

The success path through the same function.

### Checklist

- The catch is as narrow as the failure it expects. `except Exception` and `catch (e)` around a
  whole function body are findings under the guide's swallowed-errors rule.
- State after failure is consistent: nothing half-written, resources released, no partial
  transaction ([partial failure](../../Code-Review-Guide-and-Playbooks.md#fail-fast-on-every-path)).
- Absence and failure stay distinct. A `None` that now means both "not found" and "the call
  failed" is a regression in meaning.
- The error is logged once, at the boundary, with context, and not logged and rethrown at every
  layer ([logging](../../Code-Review-Guide-and-Playbooks.md#logging-and-error-logging)).
- A changed status code or error body on a public endpoint is a contract change
  ([Hyrum's Law](../../Code-Review-Guide-and-Playbooks.md#compatibility-hyrums-law)); clients
  parse these.
- Callers that used to see the exception still get a signal they can act on.

### How it combines with domain playbooks

It widens the critical-path and data-write playbooks, since failure paths are where partial
writes and retries live. It also pairs with the endpoint playbook when the error reaches a
response.

### Red flags

- A fallback value returned from a failed money, auth or permission call.
- A catch added to make a flaky test pass.
- Error text matched by string somewhere downstream.
- `finally` or cleanup removed along with the `try`.

### Worked example

`charge()` wraps `gateway.charge(...)` in `except Exception: return Payment.failed(invoice.id)`.
The review notes that a gateway timeout is now recorded as a failed payment, though the charge
may have succeeded on the provider's side, so the retry job will charge twice. It asks for a
narrow catch on the gateway's decline error and an explicit unknown-outcome state.

### ai-review-bot today

`silent-failure-hunter` exists for this operation, and the patch shows the catch clearly. It
can't follow the call chain upward to see who relied on the exception, so "this error used to
reach the retry handler" is out of reach.

### Eval seed

On a PR that wraps a payment call in a broad `except` returning a failed result, the review
flags the swallowed timeout and the double-charge path.

## BEH-05: Async or concurrency change

```yaml
id: BEH-05
name: Async or concurrency change
family: behavior
aliases: [sync to async, add await, parallelize, locking change, threading change]
signals:
  - '`def` becoming `async def` (or the reverse), `await` added or removed, `.then` chains converted'
  - '`asyncio.gather`, `TaskGroup`, `Promise.all`, `asyncio.create_task`, a worker pool or a thread pool introduced'
  - locks, semaphores, `SELECT ... FOR UPDATE`, version columns or `unique` constraints added or removed
  - a blocking call (`requests`, `time.sleep`, sync DB driver) inside or outside an async function
  - a module-level variable, cache or singleton mutated from more than one task
narrows_playbooks: false
escalates_with: [concurrency, data-write, money, critical-path, public-api]
guide_refs:
  - "#concurrency-and-io-made-explicit"
  - "#fail-fast-on-every-path"
  - "#background-jobs-queues-and-events"
  - "#code-on-the-critical-path"
tools: [lsp-call-hierarchy, lsp-references, read-file, ripgrep, ci-results]
bot_visibility: partial
```

### What it looks like in a diff

A one-keyword change that alters every caller. Making a function `async` makes every call site
need `await`, and a missing one produces a coroutine or Promise that is never run. Parallelizing
a loop with `gather` changes the order of side effects and the number of simultaneous
connections.

### How to recognize it

Look for the keywords above, and for any change in what runs concurrently with what. A read of
shared state next to a write in code that now runs on more than one task is the pattern to
find.

### Likely intents

1. Remove a blocking call from the event loop.
2. Speed up independent I/O by running it concurrently.
3. Fix a race the team already saw.
4. Match the surrounding code, which was converted earlier.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Which callers now need to await? | Show Call Hierarchy upward | `lsp-call-hierarchy`, `lsp-references` |
| What state is shared? | Read the module and class for mutable attributes | `read-file`, `ripgrep` for the variable's writes |
| What is the concurrency limit? | Pool sizes, semaphore values, DB connection limit | `read-file` on config |
| Is this running under load in production? | Dashboards, queue depth | not available to an agent from the diff |
| What do tests cover? | Is there any test that runs two operations at once? | `read-file`, `ci-results` |

### What not to spend review on

The business logic inside the function body, when only its calling convention changed.

### Checklist

The detailed list lives in the guide's
[concurrency section](../../Code-Review-Guide-and-Playbooks.md#concurrency-and-io-made-explicit).
The checks that come from the change itself:

- Every call site of a converted function is converted. Search for callers outside the diff,
  including tests, scripts, CLI entry points and plugins.
- Order dependence is gone, or kept on purpose. Work that used to run in sequence and now runs
  together must not share an assumption about order.
- The concurrency has a cap. An unbounded `gather` over a user-sized list opens as many
  connections as there are items.
- Partial failure is handled: what happens when one of five tasks raises, and are the other
  four cancelled or awaited?
- A new lock is acquired in the same order everywhere, and not held across a network call.
- A read-modify-write moved from the database into Python, or the reverse, is atomic on the
  side where it now lives.

### How it combines with domain playbooks

It widens the concurrency material in the correctness section and pulls in
[background jobs](../../Code-Review-Guide-and-Playbooks.md#background-jobs-queues-and-events)
when the changed code is a consumer, and
[critical path](../../Code-Review-Guide-and-Playbooks.md#code-on-the-critical-path) when it is
in a request.

### Red flags

- `asyncio.run()` or `.result()` called inside running async code.
- A fire-and-forget task with no stored reference.
- A race "fixed" with `sleep` or a retry.
- A test that passes only because the await was dropped on both sides.

### Worked example

`def send_receipt(order)` becomes `async def send_receipt(order)`, and the handler adds
`await`. A grep finds `worker.py` still calling `send_receipt(order)` without `await`, so
receipts silently stop for queued orders. The finding is that call site, not the handler change.

### ai-review-bot today

The agents see the keyword change, but not the callers outside the patch, and a missing `await`
elsewhere is invisible to them. Race analysis from the diff alone is weak.

### Eval seed

On a PR converting a function to `async` that leaves one un-awaited caller outside the diff,
the review asks whether all callers were updated, and does not claim the missing caller itself
unless it was shown.

## BEH-06: Caching added or changed

```yaml
id: BEH-06
name: Caching added or changed
family: behavior
aliases: [memoize, add cache, TTL change, cache key change, invalidation change]
signals:
  - '`functools.lru_cache`, `functools.cache`, `cachetools`, `@cached`, `useMemo` / `React.cache` / `unstable_cache`, a Redis / KV `get` before a compute and `set` after it'
  - a TTL, `max_age`, `stale-while-revalidate` or `Cache-Control` value added or changed
  - a cache key built from a subset of the function's arguments
  - an invalidation call added, moved or removed
narrows_playbooks: false
escalates_with: [critical-path, auth, trust-boundary, data-write, money, concurrency]
guide_refs:
  - "#code-on-the-critical-path"
  - "#performance-and-observability"
  - "#concurrency-and-io-made-explicit"
  - "#least-privilege-and-trust-boundaries"
tools: [lsp-references, ripgrep, read-file, ci-results, linked-work-item]
bot_visibility: full
```

### What it looks like in a diff

A wrapper around an existing function, or a new `get`/`set` pair around a database or network
call, with a key string and a TTL.

### How to recognize it

Any stored result that is reused for a later call. Include the implicit ones: a module-level
dict, a class attribute filled on first use, an HTTP response header that tells a CDN or
browser to keep a response.

### Likely intents

1. Cut latency or load on a slow or expensive call.
2. Stay under a third-party rate limit.
3. A fix for a symptom elsewhere, such as hot-key pressure on the database.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| What does the cached value depend on? | Read the function and everything it reads | `read-file` |
| What invalidates it? | Search for every write to the underlying data | `ripgrep`, `lsp-references` on the writer functions |
| Is the value per-user or per-tenant? | Check the arguments, the session, the permissions | `read-file` |
| Why is the cache needed? | Look for the measurement or the incident | `linked-work-item` |

### What not to spend review on

The computation being cached, if unchanged.

### Checklist

The guide's
[caching bullet](../../Code-Review-Guide-and-Playbooks.md#code-on-the-critical-path) covers key
contents, expiry, hot keys and cache-down behavior. The checks that follow from the operation:

- **The key holds every input.** A key built from `user_id` for a value that also depends on
  locale, feature flags or permissions serves the wrong data. A value served across a
  permission boundary is a security bug.
- **Writers invalidate it.** Find every code path that changes the underlying data. One that
  doesn't is a staleness bug that shows up weeks later.
- **Mutable results are not shared.** A cached list or dict returned to callers who mutate it
  corrupts the cache. `lru_cache` on a method also pins `self` in memory.
- **Failures aren't cached**, unless that's deliberate and short-lived. A cached `None` from a
  timeout becomes a long outage.
- **Staleness is acceptable here.** The PR names how stale is tolerable, and this isn't a price,
  balance, permission or inventory read.
- **A measurement exists** that the miss was the problem. The guide asks for a benchmark or
  profile with a claimed speedup.
- **The path works with an empty or unavailable cache.**

### How it combines with domain playbooks

It widens critical-path and trust-boundary checks. A cache in front of an auth decision or a
per-tenant query is reviewed as an access-control change.

### Red flags

- A shared cache key with no tenant in it.
- `Cache-Control: public` on a response that depends on the caller.
- A TTL raised to hide a slow query.
- Cache added and invalidation "to follow".

### Worked example

`get_plan_limits(user_id)` gets `@lru_cache(maxsize=1024)`. The review points out that the
function reads from a table that the billing webhook updates, with no invalidation, so a plan
upgrade is ignored until process restart, and that each worker process has its own copy.

### ai-review-bot today

The diff shows the decorator and the key. What the bot can't see is who writes the underlying
data, so staleness and invalidation gaps are out of reach unless the writer is in the PR.

### Eval seed

On a PR adding an in-process cache around a function that reads a webhook-updated table, the
review asks for invalidation and notes the per-process copies.

## BEH-07: Retry or timeout change

```yaml
id: BEH-07
name: Retry or timeout change
family: behavior
aliases: [add retry, backoff change, timeout bump, circuit breaker, resilience change]
signals:
  - a retry decorator or loop added (`tenacity`, `backoff`, `p-retry`, `axios-retry`, a `while attempts < N`)
  - '`timeout=`, `AbortSignal.timeout`, `request_timeout`, `connect_timeout` added, raised, lowered or removed'
  - a max-attempt, backoff-base or jitter value changed
  - a client's `http`/`fetch` wrapper gaining or losing a default timeout
narrows_playbooks: false
escalates_with: [critical-path, money, data-write, concurrency, public-api]
guide_refs:
  - "#code-on-the-critical-path"
  - "#background-jobs-queues-and-events"
  - "#concurrency-and-io-made-explicit"
  - "#fail-fast-on-every-path"
tools: [lsp-call-hierarchy, lsp-references, read-file, ripgrep, ci-results]
bot_visibility: full
```

### What it looks like in a diff

A small change to a decorator argument or a constant, with large effects. A timeout going from
10 to 60 seconds multiplies the time a request can hold a worker. A retry added to a
non-idempotent call multiplies its side effects.

### How to recognize it

Any change to how long the code waits or how often it tries again. Include the ones inside
configuration (client settings, queue visibility timeouts).

### Likely intents

1. Ride out a transient failure a dependency is known for.
2. Raise a timeout that fires too early on a slow but healthy call.
3. Lower a timeout to protect a latency budget.
4. Cover an incident with a retry.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Is the call safe to repeat? | Read what it writes or triggers on the other side | `read-file`, `linked-work-item` |
| What is the caller's own timeout? | Follow the call upward to the request or job limit | `lsp-call-hierarchy` |
| How many layers retry? | Search for retry settings in the client, the SDK and the caller | `ripgrep` |
| What do the numbers multiply to? | Attempts times timeout plus backoff | arithmetic, from the values |

### What not to spend review on

The code that makes the call, if unchanged.

### Checklist

- **Idempotency.** A retried call that charges, sends, creates or enqueues needs an idempotency
  key or a safe design ([idempotency](../../Code-Review-Guide-and-Playbooks.md#concurrency-and-io-made-explicit)).
- **The total time fits the budget.** Attempts times per-try timeout plus backoff stays inside
  the path's limit, as the guide asks for critical-path code
  ([timeouts and budgets](../../Code-Review-Guide-and-Playbooks.md#code-on-the-critical-path)).
- **Retries are bounded, backed off and jittered**, and only for errors that can be transient.
  A 4xx or a validation failure isn't retried.
- **No stacking.** A retry inside a client that is called by a retrying job multiplies
  attempts. Three layers of three tries is 27 calls.
- **Exhaustion is handled.** After the last attempt, the error reaches a place that logs it and
  decides.
- **A raised timeout has a reason**, and the number is checked against the caller's limit. A
  timeout longer than its caller's makes the inner limit meaningless.
- **A removed timeout is a finding** unless replaced by a stricter one at another layer.

### How it combines with domain playbooks

It widens critical-path and background-job checks, and it pulls in the money and data-write
playbooks when the retried call has side effects.

### Red flags

- Retry on a POST with no idempotency key.
- A timeout of `None`, `0` or a very large value.
- Retry on all exceptions.
- A change to the retry policy in the same PR as the incident fix, with no test for the failure.

### Worked example

`@retry(stop=stop_after_attempt(5))` is added to `send_payout()`, which calls a bank API.
The review asks whether the API accepts an idempotency key. It does not appear anywhere in the
PR, so a timeout after a successful payout would send up to five payouts. The finding is the
missing key, and it is a blocker.

### ai-review-bot today

The values are visible. The bot can't follow the call chain to count retry layers or learn the
caller's timeout, and it can't tell whether the remote call is idempotent.

### Eval seed

On a retry added to a non-idempotent payment call, the review flags duplicate side effects and
asks for an idempotency key.

## BEH-08: Performance optimization

```yaml
id: BEH-08
name: Performance optimization
family: behavior
aliases: [speed-up, optimize, hot path rewrite, batching, N+1 fix, index addition]
signals:
  - a loop of queries or calls replaced by a batch, a join or `selectinload` / `IN (...)`
  - a hand-rolled data structure, precomputed table, manual buffering or inlined helper in a hot function
  - an algorithm swap, a lazy evaluation, a generator in place of a list, a pagination or streaming change
  - an index added, or a query rewritten
  - the words "faster", "perf", "optimize" or "latency" in the title, or a benchmark file in the diff
narrows_playbooks: false
escalates_with: [critical-path, data-write, concurrency, public-api]
guide_refs:
  - "#performance-and-observability"
  - "#code-on-the-critical-path"
  - "#queries-and-indexes"
  - "#complexity-in-both-directions"
  - "#review-in-the-order-of-make-it-work-make-it-right-make-it-fast"
tools: [linked-work-item, ci-results, read-file, lsp-references, ripgrep]
bot_visibility: full
```

### What it looks like in a diff

Code that gets longer, more specialized or less obvious in exchange for speed. The same inputs
and outputs, a different path to them.

### How to recognize it

The description claims a speed-up, or the diff replaces a straightforward implementation with
one that avoids repeated work. Whether it is faster is a separate question from whether it
looks faster.

### Likely intents

1. A measured bottleneck from a profile or an incident.
2. A guess at one, which Knuth's rule in the guide says to question.
3. A cleanup in disguise (removing a repeated query), which is a bug fix for an N+1.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| What was measured? | Ask for the benchmark or profile, check the numbers | `linked-work-item`, `ci-results` |
| Is the optimized code on a hot path? | Check call frequency and where it runs | `lsp-references`, `read-file` |
| Do the outputs match exactly? | Compare results on edge inputs | existing tests, `ci-results` |
| What did the speed-up cost? | Memory, staleness, complexity | `read-file` |

### What not to spend review on

Micro-details of the faster algorithm that tests pin down, once equivalence is shown.

### Checklist

- **A measurement exists**, and it is on realistic data. The guide says to ask for one before
  accepting an optimization that costs readability
  ([performance and observability](../../Code-Review-Guide-and-Playbooks.md#performance-and-observability)).
- **Behavior is unchanged.** Ordering, ties, null handling, rounding and error cases match the
  old code, and tests cover the edge inputs. An optimization that changes output is a behavior
  change.
- **The cost moved somewhere visible.** Batch size is bounded, memory is bounded, and a
  query's new plan holds up at production size
  ([queries and indexes](../../Code-Review-Guide-and-Playbooks.md#queries-and-indexes)).
- **It needed to be done.** The code is on a path that matters; if not, the guide's
  [complexity in both directions](../../Code-Review-Guide-and-Playbooks.md#complexity-in-both-directions)
  applies, and the simple version wins.
- A new index is justified by a query that uses it and weighed against write cost.
- It can be rolled back or toggled when it sits on a critical path.

### How it combines with domain playbooks

It widens the performance material and the queries playbook, and widens critical-path checks
when the optimized code is in a request. It leaves the business rules alone, provided
equivalence holds.

### Red flags

- No numbers, or numbers from a toy input.
- A cache or precomputation where a query fix would do (see
  [BEH-06](#beh-06-caching-added-or-changed)).
- A faster path that skips validation or a permission check.
- Unbounded batching.

### Worked example

A loop calling `get_user(id)` per order becomes `get_users(ids)` with `WHERE id IN (...)`. The
description claims "10x faster" with no numbers. The review asks for the before/after timing,
notes that the new query has no cap on `ids` (a 50,000-order export builds a 50,000-item `IN`),
and confirms the result order is rebuilt from the input order, since `IN` returns arbitrary
order.

### ai-review-bot today

The bot reads the code but can't run a benchmark or read a profile, and doesn't know which
code is hot. It tends to either accept the claim or flag micro-details. What it would need: the
benchmark output from CI, and call-frequency context.

### Eval seed

On a PR claiming a speed-up with no measurement and an unbounded `IN` list, the review asks for
the numbers and flags the unbounded batch.

## BEH-09: Dependency or runtime version changed

```yaml
id: BEH-09
name: Dependency or runtime version changed
family: behavior
aliases: [version bump, dependency upgrade, runtime upgrade, Node bump, Python bump, major upgrade]
signals:
  - a version range changed in package.json, pyproject.toml, requirements.txt or Cargo.toml
  - 'a runtime pin changed: `engines.node`, `requires-python`, `.nvmrc`, `.python-version`, a Dockerfile `FROM` tag, a CI `node-version` or `python-version` matrix'
  - a lockfile diff that moves a package across a major version, or adds and removes transitive packages
  - application code edited in the same PR to fit the new version (renamed import, new option, removed call)
  - a peer dependency, native extension or build tool (`node-gyp`, a wheel for a specific platform) changed
narrows_playbooks: false
escalates_with: [public-api, critical-path, data-write, auth, migration]
guide_refs:
  - "#new-dependencies"
  - "#compatibility-hyrums-law"
  - "#configuration-files"
  - "#migrations-and-deployment-sequencing"
tools: [read-file, ci-results, ripgrep, linked-work-item, lsp-references, pr-files-api]
bot_visibility: partial
```

### What it looks like in a diff

A manifest edit of one or two lines, often with a large lockfile diff beside it. The manifest
line looks like `"zod": "^4.0.0"` where it was `^3.23.0`, or `requires-python = ">=3.12"`
where it was `>=3.10`. Sometimes the only change is a Docker base image tag or a CI matrix
entry. When the author had to adapt, a handful of source edits follow: a changed import path, a
new constructor argument, a removed keyword.

### How to recognize it

The version token changed and the dependency itself did not appear or disappear. A brand new
package is [DOM-17](../domains.md#dom-17-new-dependencies). A lockfile that moved with no
manifest change is [MEC-08](mechanical.md#mec-08-lockfile-only-churn). This entry covers a
manifest, runtime or image pin that moved, on its own or with the lockfile. A major version bump
with no source edits at all is not proof of compatibility. It usually means the tests passed, which says nothing about code they don't reach.

### Likely intents

1. Take a security fix. The advisory or CVE should be in the description.
2. Get a feature or bug fix the new version ships.
3. Keep up with a runtime that is about to lose support.
4. A bot (Dependabot, Renovate) opened it. The author may not have read the changelog.
5. Unblock another upgrade that needs a newer peer.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| What changed between the versions? | Read the changelog and the breaking-changes or migration guide for every major in the range | `read-file` on the package's changelog if vendored; otherwise not in the diff |
| Which code uses the changed API? | Search for imports and calls of the package | `lsp-references`, `ripgrep` |
| Which version combinations does the project claim to support? | Read the engines, peer and CI matrix entries together | `read-file` |
| Does a fresh install resolve the same as the lockfile? | Install clean in a scratch directory, with the frozen or locked flag the repo uses | `ci-results` for the install job |
| Do native or platform-specific pieces still build? | Check wheels, prebuilt binaries and the Docker build on the target platform | `ci-results` |
| Why is the bump here? | Read the ticket or advisory | `linked-work-item` |

### What not to spend review on

The lockfile body. Hundreds of transitive lines are generated output. Read the top-level
packages that moved major versions and any newly added transitive package with an install
script. Unchanged application code that happens to import the package is only in scope where
the changelog says its behavior changed.

### Checklist

The adoption questions for a package are in the guide's
[new dependencies](../../Code-Review-Guide-and-Playbooks.md#new-dependencies) section. The
checks that come from the version moving:

- The changelog was read for every major version crossed, including those before the target. Breaking changes
  between 2.x and 4.x include the ones in 3.0.
- Defaults that changed are found by search, not by hoping. A new default for a timeout,
  encoding, strictness or validation mode changes behavior in code that never touches the
  option. This is [Hyrum's Law](../../Code-Review-Guide-and-Playbooks.md#compatibility-hyrums-law)
  applied to a dependency.
- The supported combinations still hold together: runtime version, peer dependencies, the CI
  matrix and the deploy image. If `requires-python` rose, the CI matrix and the Docker tag
  rose with it. A stdlib module removed in a newer Python (distutils went in 3.12) breaks
  code that still imports it.
- A fresh install and an existing install both work. A cached `node_modules` or virtualenv can
  hide a missing dependency that a clean checkout exposes.
- Native and build-time parts still resolve on every platform the project ships to, including
  the architecture of the production image.
- Rollback is possible. If the new version writes data, a cache format or a serialized shape the
  old one can't read, reverting the PR leaves broken state
  ([migrations](../../Code-Review-Guide-and-Playbooks.md#migrations-and-deployment-sequencing)).
- The PR says what was tested beyond the unit suite: the happy path that uses the changed API,
  once, by hand or in an integration test.

### How it combines with domain playbooks

It pulls in the domain of the code that calls the dependency. An ORM upgrade brings the
[queries](../../Code-Review-Guide-and-Playbooks.md#queries-and-indexes) and migration material, a
web framework upgrade brings [authentication](../../Code-Review-Guide-and-Playbooks.md#authentication-and-authorization)
and [input validation](../../Code-Review-Guide-and-Playbooks.md#code-that-validates-user-input)
if middleware order or request parsing changed. A runtime bump brings
[configuration files](../../Code-Review-Guide-and-Playbooks.md#configuration-files).

### Red flags

- A major bump with a one-line description ("update deps") and no mention of the changelog.
- `--force`, `--legacy-peer-deps`, `overrides` or `resolutions` added to make the install pass.
- A version range widened to `*` or `latest`, or an upper bound deleted.
- Tests changed to pass under the new version (an expected string, a snapshot, a timeout)
  without explanation.
- The CI matrix still tests only the old runtime while `engines` says the new one.
- Source edits in the PR that match nothing the changelog describes.

### Worked example

A Dependabot PR moves `pydantic` from 1.10 to 2.x and edits three imports. Tests pass. The
review reads the migration guide and searches for `.dict()`, `parse_obj` and `@validator`,
which still work in 2.x with deprecation warnings but whose validation behavior differs. It finds
a `@validator` with `pre=True` in `schemas/order.py` that was not touched. The finding names that
validator and asks which of its inputs the tests exercise. It does not comment on the lockfile.

### ai-review-bot today

The agents see the manifest and the lockfile patch. They can read the version change and know
the package from training data, which is a stale source for anything released recently. They
cannot read the changelog, cannot see the call sites outside the diff, and cannot run an
install. `classifyTier()` does not look at manifests, so a runtime major bump gets `normal`
unless its path happens to match a keyword. Lockfiles such as `pnpm-lock.yaml` are listed in
`src/diff-pack.ts` as generated, so they are packed last. What it would need: the changelog text for the version
range, and a search for the package's imports.

### Eval seed

On a PR that bumps a library across a major version with no source change, the review asks what
changed in the major and names one default or removed API to check, and does not comment on
lockfile contents.

## BEH-10: Execution order or transaction boundary changed

```yaml
id: BEH-10
name: Execution order or transaction boundary changed
family: behavior
aliases: [reorder calls, move commit, transaction scope change, move side effect, validate later, publish before save]
signals:
  - two or more statements swapped in a function with no change to what each does
  - 'a side effect (send email, publish event, call a payment API, write a file, enqueue a job) moved above or below a commit, save or validation'
  - 'a transaction opened wider or narrower: `with session.begin()`, `transaction.atomic()`, `db.$transaction([...])`, `BEGIN` and `COMMIT` moved'
  - a `commit()`, `flush()` or `save()` moved, split in two, or added inside a loop
  - validation or authorization moved after work that used to follow it
  - 'an early `return` or `raise` moved relative to a write'
narrows_playbooks: false
escalates_with: [data-write, money, critical-path, concurrency, trust-boundary, auth]
guide_refs:
  - "#fail-fast-on-every-path"
  - "#concurrency-and-io-made-explicit"
  - "#background-jobs-queues-and-events"
  - "#code-on-the-critical-path"
  - "#data-models-that-cant-hold-illegal-states"
tools: [read-file, lsp-call-hierarchy, lsp-references, log-L, blame-C, ripgrep, linked-work-item]
bot_visibility: partial
```

### What it looks like in a diff

A small diff that looks like tidying: the same lines removed in one place and added in another,
or a block indented one level deeper into a `with` or `try`. Nothing in the moved lines is new,
so a line-by-line read finds nothing wrong. The change is in what now happens first. An
`await send_receipt(order)` that came after `await session.commit()` now comes before it. A
check against `user.can_edit(doc)` now runs after the `doc` was already updated.

### How to recognize it

Compare the order of effects in the base and in the head, not the lines. List every call that
touches something outside the function (database, queue, network, filesystem, cache) and write
its position relative to the commit and to the checks. If the list differs, this is the
operation. Pure reordering of lines that only compute values is a no-op unless one of them can
raise. If the whole block moved to another file, see
[REL-01](relocation.md#rel-01-function-or-class-moved-between-files) first.

### Likely intents

1. Fix a bug where the effect happened and the write then failed, or the reverse.
2. Hold a lock or transaction for less time.
3. Make several writes atomic that used to commit separately.
4. Run validation earlier, to fail fast.
5. A cleanup that reordered for readability and did not notice the effect.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| What did the order look like before? | Compare base and head side by side | `read-file` at base and head |
| Who calls this function, and what do they assume has happened when it returns? | Show Call Hierarchy upward | `lsp-call-hierarchy`, `lsp-references` |
| What is inside the transaction now? | Read from the begin to the commit and list every call | `read-file` |
| Does anything outside the database run in the transaction? | Look for network calls, queue publishes and emails between begin and commit | `ripgrep` for the client names |
| Why was it in this order? | Timeline on the moved lines | `log-L`, `blame-C` |
| What do the tests prove about order? | Look for a test that fails the second step and asserts on the first | `read-file`, `ci-results` |

### What not to spend review on

The bodies of the calls that moved. They are unchanged. Spend the review on the sequence, the
commit point, and the failure cases between two steps.

### Checklist

- For each step, name what has already happened when it fails. If step 3 raises, which effects of
  steps 1 and 2 are visible to other people or systems, and is that acceptable?
- Effects outside the database happen after the commit, or are made safe to repeat or undo. An
  email sent before a commit that then rolls back tells a customer about an order that doesn't
  exist. The reverse, committing first, risks a committed order with no email, which is
  usually the better failure, and a retry path (see
  [background jobs](../../Code-Review-Guide-and-Playbooks.md#background-jobs-queues-and-events))
  closes it.
- Validation and authorization still come before the first write. A check moved after a write
  means rejected requests have already changed state unless the transaction rolls back.
- Rollback covers what the author thinks it covers. A database transaction does not undo a
  network call, a file write, a cache set or a message already published.
- A widened transaction does not now include slow or external work. Holding a connection and
  row locks across an HTTP call is a latency and deadlock risk on the
  [critical path](../../Code-Review-Guide-and-Playbooks.md#code-on-the-critical-path).
- A narrowed or split transaction leaves no state that violates an invariant between the two
  commits. Check what a concurrent reader sees in the gap
  ([concurrency](../../Code-Review-Guide-and-Playbooks.md#concurrency-and-io-made-explicit)).
- Every early exit still leaves a consistent state, including the exception path
  ([fail fast on every path](../../Code-Review-Guide-and-Playbooks.md#fail-fast-on-every-path)).

### How it combines with domain playbooks

It widens the correctness and concurrency material on the changed sequence only. It pulls in
[background jobs](../../Code-Review-Guide-and-Playbooks.md#background-jobs-queues-and-events)
when the moved effect is a publish or enqueue, and
[data modeling](../../Code-Review-Guide-and-Playbooks.md#data-models-that-cant-hold-illegal-states)
when the gap between two commits can hold a state the model should not allow. Where money or
inventory is written, the full domain checks apply to the new sequence.

### Red flags

- A publish, enqueue, email or external API call between begin and commit.
- A `commit()` inside a loop that used to commit once at the end, with no thought for a failure
  halfway through.
- A swallowed exception in a `try` whose body now contains a write and an effect together.
- Authorization or validation running after the first mutation.
- A test updated to match the new order without saying why the order changed.
- Description says "no behavior change" for a PR that moved a commit.

### Worked example

`create_order` used to validate stock, save the order, commit, then call `charge_card`. A
cleanup PR moves `charge_card` above the commit "so the order is only saved if payment works."
The review lists the effects in order: payment is now taken before the order exists, so a crash
between the charge and the commit charges the customer for nothing, and there is no retry that
finds the orphaned charge. The finding names that gap and asks for an idempotency key on the
charge and a reconciliation path. It makes no comment on the stock validation, which didn't
move.

### ai-review-bot today

The agents see the moved lines as additions and deletions in the same function, usually inside
one hunk, and can reason about order when both sides are in that hunk. They cannot see the
commit point if it is outside the patch, cannot see the callers, and cannot tell which calls
reach outside the process. A reorder spread across two hunks or two files is hard for them to
notice. `silent-failure-hunter` looks at swallowed errors and may catch the `try` shape but not
the ordering.

### Eval seed

On a PR that moves an external call from after a database commit to before it, the review names
the window in which the call has happened and the commit has not, and says what a failure inside
that window leaves behind.

## BEH-11: Feature rollout or experiment changed

```yaml
id: BEH-11
name: Feature rollout or experiment changed
family: behavior
aliases: [flag added, flag rollout, percentage rollout, targeting rule change, A/B test, canary, kill switch, experiment]
signals:
  - 'a new flag read in code: `flags.is_enabled(...)`, `useFlag(...)`, a LaunchDarkly, Unleash or Statsig client call, `process.env.FEATURE_...`, `os.getenv("ENABLE_...")`'
  - a flag config file or dashboard export changed (rollout percentage, segment, rule order, default value)
  - code split into a flag-on path and a flag-off path that both stay
  - a percentage, hash bucket or allowlist constant changed
  - experiment or variant names added, with a metric or exposure event beside them
narrows_playbooks: false
escalates_with: [public-api, data-write, money, auth, critical-path, migration]
guide_refs:
  - "#migrations-and-deployment-sequencing"
  - "#configuration-files"
  - "#compatibility-hyrums-law"
  - "#fail-fast-on-every-path"
  - "#building-for-needs-you-dont-have"
tools: [read-file, ripgrep, linked-work-item, lsp-references, ci-results, pr-files-api]
bot_visibility: partial
```

### What it looks like in a diff

Either a new branch around existing behavior (`if flags.enabled("new_checkout", user): ...
else: ...`) or a config edit that changes who gets an existing flag (a percentage from 5 to 50,
a new segment, a rule moved above another). The code half and the config half can be in
different repositories or in a dashboard the diff never shows. Cleanup of a finished flag is
[DEL-09](deletion.md#del-09-feature-flag-cleaned-up). A changed default value for a
settings key that isn't a flag is [IFC-04](interface.md#ifc-04-default-value-changed).

### How to recognize it

Look for a call that asks an outside source whether something is on, and for two code paths
that can both run in production at once. Config-only PRs are easy to miss because they contain
no code. A rollout percentage change, an added targeting rule or a swapped default is this
operation even if no source file moved.

### Likely intents

1. Ship new behavior to a small group first.
2. Widen an existing rollout (5%, 25%, 100%).
3. Add a kill switch around risky code.
4. Run an experiment and compare two variants.
5. Turn a feature on for one customer by name.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| What does the flag service return when it is down or the key is missing? | Read the client setup and each call's fallback argument | `read-file`, `ripgrep` for the flag key |
| How is a user assigned to a variant? | Read the bucketing key (user id, session id, request id) and the hash | `read-file` |
| What is the rule order? | Read the flag config or dashboard export top to bottom | `read-file`, `pr-files-api` |
| Where else is the flag read? | Search for the key across services and frontends | `ripgrep`, `lsp-references` |
| Can both branches run against the same data? | Read what each path writes and reads | `read-file` |
| What is the plan to widen, and to remove it? | Read the ticket or rollout note | `linked-work-item` |

### What not to spend review on

The internals of the new feature when it is behind the flag and the flag is off for everyone.
They get a normal review when the flag turns on, or in the PR that adds them, but a rule-only
change doesn't reopen them.

### Checklist

- Assignment is stable. The same user gets the same variant on every request, and across
  services. Bucketing on a random number per request, or on a session id when the experiment
  is about accounts, flips people between variants.
- Targeting precedence is what the author says. Rules are evaluated in order, so an allowlist
  under a percentage rule, or a block rule under an allow rule, can reverse the intent.
- The fallback is deliberate. What the code does when the flag service errors, times out or has
  no such key is decided at each call site, and the safe side is chosen for risky features.
- A kill switch actually kills. Turning the flag off reaches every path that reads it,
  including background jobs and caches, takes effect without a deploy, and doesn't leave the
  system in a half-converted state.
- Both branches work while the flag is live. They agree on the data shape, and the new path
  doesn't write something the old path can't read, which is the
  [migration sequencing](../../Code-Review-Guide-and-Playbooks.md#migrations-and-deployment-sequencing)
  problem in disguise.
- Widening is safe. Going from 5% to 100% sends full load to the new path, so the capacity,
  rate limits and downstream timeouts were considered.
- Every branch is tested, including flag-off and the fallback.
- There is a plan to remove the flag. A permanent flag is a configuration setting that was not
  designed as one.
- Experiment exposure is logged when the variant is shown, not when the page loads, and the
  metric can tell the groups apart.

### How it combines with domain playbooks

It widens them for each branch. The new branch gets whatever the domain playbook says for the
code in it, and the flag adds its own list above. Where the flag guards a schema or data change,
[migrations and deployment sequencing](../../Code-Review-Guide-and-Playbooks.md#migrations-and-deployment-sequencing)
applies in full. Where it guards auth or pricing, the trust-boundary and money checks apply to the
flag-on and flag-off paths separately. Flag keys in files belong with
[configuration](../../Code-Review-Guide-and-Playbooks.md#configuration-files).

### Red flags

- The flag-off path was edited in the same PR as the flag-on path.
- A flag read inside a loop or a hot path with no local caching, hitting the flag service per item.
- The fallback is `True`.
- The same flag key read with different defaults in different files.
- Rollout widened in a PR with no mention of metrics from the previous stage.
- A flag whose branches differ only in the name of a constant.
- Targeting by an email domain or user-supplied field.

### Worked example

A PR adds `if flags.is_enabled("new_pricing", user_id=request.session_id)` around a new price
calculation and sets the rollout to 20%. The review notes that `session_id` changes at each
login, so a customer can see two prices in one week, and the order history will show both. The
finding asks for the account id as the bucketing key. It does not review the new price
calculation, which is a separate reading of [BEH-01](#beh-01-new-logic-or-feature-code).

### ai-review-bot today

The agents see code that reads a flag and can reason about the two branches when both are in
the patch. They cannot see the flag service, the dashboard, the other repositories that read
the key, or the current rollout percentage. A config-file diff is visible only if it is in the
repository. They have no way to tell whether a flag is in use elsewhere or how it is targeted.

### Eval seed

On a PR that gates a change on a flag bucketed by a per-request random value, the review says
the same user can get different variants, and does not ask for flag service setup details it
cannot see.

## BEH-12: State transition or workflow changed

```yaml
id: BEH-12
name: State transition or workflow changed
family: behavior
aliases: [state machine change, status change, lifecycle change, workflow change, new status, new transition, order lifecycle]
signals:
  - 'a status enum or union gaining, losing or renaming a member: `class Status(Enum)`, `type Status = "draft" | "paid"`'
  - a transitions table, guard function or state-machine config edited (XState, python-statemachine, the `transitions` library, a hand-written dict of allowed moves)
  - 'assignments to a `status`, `state` or `stage` field in more than one place, or a new `UPDATE ... SET status =`'
  - a new step added between two existing steps of a flow, or a step made optional
  - a webhook, job or consumer that moves a record from one state to another
narrows_playbooks: false
escalates_with: [data-write, money, critical-path, concurrency, auth, migration]
guide_refs:
  - "#data-models-that-cant-hold-illegal-states"
  - "#fail-fast-on-every-path"
  - "#background-jobs-queues-and-events"
  - "#migrations-and-deployment-sequencing"
  - "#compatibility-hyrums-law"
tools: [read-file, lsp-references, lsp-call-hierarchy, ripgrep, ci-results, linked-work-item, log-L]
bot_visibility: partial
```

### What it looks like in a diff

A new member in an enum and a new `case` or branch to handle it. A transitions dictionary with
one more key. A function `can_transition(from_, to)` with a changed condition. A handler that
used to set `status = "paid"` now sets `status = "authorized"`, with a second handler added
later in the PR to move it to `paid`. The change is spread over several files, and the one that
matters is often a consumer that was not edited.

### How to recognize it

Find the field that holds the state and every place that writes it. If the set of values, the
set of allowed moves, or the code that performs a move changed, this is the operation. A
single changed comparison in a guard is also
[BEH-03](#beh-03-conditional-or-boundary-change); treat it as this entry when the condition
decides whether a record may change state. The change is bigger than it looks when the field is
a database column, because old rows keep their old values.

### Likely intents

1. Add a state for a real case the old model could not express (partial refund, pending review).
2. Split one state into two to get an intermediate point (authorized, then captured).
3. Forbid a transition that led to bad data.
4. Allow a transition support needed (reopen a closed ticket).
5. Rename states for clarity.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| What are all the states and allowed moves, before and after? | Draw the graph from the transitions table or from every assignment | `read-file`, `ripgrep` for the field name |
| Who reads the state and branches on it? | Show References on the enum and on the column | `lsp-references`, `ripgrep` |
| What values exist in stored data today? | Query distinct values in the table or field | not available to an agent from the diff |
| Which events or commands can arrive in each state? | List endpoints, webhooks, jobs and UI actions that cause a move | `lsp-call-hierarchy`, `ripgrep` |
| What do the tests cover? | Look for a test per forbidden transition | `read-file`, `ci-results` |
| What did the ticket want? | Read the lifecycle in the spec | `linked-work-item` |

### What not to spend review on

The code that handles a state the PR didn't touch. Review the new and changed states, the moves
into and out of them, and the consumers that branch on the field. Unchanged states with
unchanged handlers stay out of scope.

### Checklist

- The reachable set is intended. Draw the transitions after the change. Every state has a way
  in, and every non-terminal state has a way out. A new state with no exit is a place for
  records to get stuck.
- Forbidden transitions are enforced where state is written, not only in the UI. Jumping from
  `draft` to `shipped` by calling the API directly must fail
  ([illegal states](../../Code-Review-Guide-and-Playbooks.md#data-models-that-cant-hold-illegal-states)).
- Terminal states stay terminal, or reopening is explicit and tested.
- Duplicate and out-of-order commands are safe. A webhook delivered twice, or a "paid" event
  arriving after "refunded", leaves the record in a sensible state
  ([background jobs](../../Code-Review-Guide-and-Playbooks.md#background-jobs-queues-and-events)).
- Records already stored remain valid. Old rows with a removed or renamed value are migrated,
  or the code still reads them, in the right order of deploy and backfill
  ([sequencing](../../Code-Review-Guide-and-Playbooks.md#migrations-and-deployment-sequencing)).
- Every consumer of the state field handles each new value. A `switch` or `if/elif` chain with
  a default that treats an unknown state as an old one is a finding. The type checker
  helps when the language has exhaustive matching (`assert_never` in Python, `never` in
  TypeScript).
- A failure between two transitions can be recovered. If a step is made of two moves and the
  process dies after the first, something retries or repairs the record.
- Two actors moving the same record at once can't both win, which needs a conditional update or
  a version check ([concurrency](../../Code-Review-Guide-and-Playbooks.md#concurrency-and-io-made-explicit)).
- Anything outside the service that stores or displays the old names (analytics, exports,
  external APIs) is checked ([Hyrum's Law](../../Code-Review-Guide-and-Playbooks.md#compatibility-hyrums-law)).

### How it combines with domain playbooks

It widens the data modeling and background jobs material for the changed lifecycle, and pulls
in migrations when the state is stored. When the state is exposed in an API response, the
[schema change and versioning](../../Code-Review-Guide-and-Playbooks.md#endpoint-schema-changes-versioning-and-deprecation)
playbook applies, because a new enum value is a breaking change for a client with a closed set.
Where the state gates payment or access, the money and auth checks apply to each transition.

### Red flags

- A new enum member and no change to any consumer.
- `status` written by direct assignment in several files instead of one transition function.
- A default branch that handles unknown states as if they were a known one.
- A migration that renames values in the database in the same deploy as the code that reads them.
- A transition guarded only in the frontend.
- A test that sets the state directly in the fixture and never exercises a transition.
- A "retry" that moves a record back to an earlier state without checking where it is now.

### Worked example

A PR splits order status `paid` into `authorized` and `captured`, with a job that captures after
fulfilment. The review lists the consumers of `paid` with a search: the invoice generator and the
refund endpoint test for `status == "paid"`, so orders in `authorized` get no invoice and can't
be refunded. It also finds no path from `authorized` back to `cancelled` when capture fails. The
findings name those two sites and the missing transition. It makes no comment on the capture
job's retry settings, which were not in the diff.

### ai-review-bot today

The agents see the enum change and the handlers in the patch, and can notice a missing `case`
when the switch is in the same hunk. They cannot search for other readers of the field, cannot
see stored data, and have no model of the full transition graph unless the table is in the diff.
A consumer left unedited is exactly what they miss. `pr-test-analyzer` can report that no test
covers a new transition but cannot tell which transitions are forbidden.

### Eval seed

On a PR that adds a new status value and updates only the writer, the review asks which readers
branch on the field and names the ones that would mis-handle the new value, without claiming
code it was not shown.
