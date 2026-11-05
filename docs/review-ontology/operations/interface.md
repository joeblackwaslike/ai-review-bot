# Interface operations

Something other code depends on now looks different: a function's signature, what it returns
or raises, a type, a default, a config key, a message's fields. The body behind the interface
may not have changed at all. The reviewer's first job is to find who is on the other side of
the interface and whether they still work after the deploy. The guide's
[Hyrum's Law section](../../Code-Review-Guide-and-Playbooks.md#compatibility-hyrums-law) is the
rule: once behavior is observable, someone depends on it.

The guide already has a full playbook for one interface, the HTTP endpoint, with a table that
classifies each kind of schema change as safe or breaking. These entries generalize that table
to every other kind of interface, and send endpoint changes to
[the endpoint playbook](../../Code-Review-Guide-and-Playbooks.md#endpoint-schema-changes-versioning-and-deprecation).
The questions it asks carry over: is the change additive or breaking, do old callers keep
working during a rolling deploy, and is the break announced? What differs is how callers are
found. An endpoint's clients are outside the repo, while a function's callers can be found
with a references search. Behavior changes that leave the interface alone are in
[behavior.md](behavior.md). A rename with the same shape everywhere is
[REL-03](relocation.md#rel-03-symbol-renamed-in-place) until it reaches a serialized name,
where it becomes an interface change here. Interface changes bundled with other work are
covered in [composite.md](composite.md), and pure formatting or lint churn in
[mechanical.md](mechanical.md). A removal of a public symbol is also a deletion: see
[deletion.md](deletion.md).

## IFC-01: Function signature changed

```yaml
id: IFC-01
name: Function signature changed
family: interface
aliases: [parameter added, parameter removed, parameter reordered, argument change]
signals:
  - a `def` / `function` / method line changed in the diff, with its body mostly intact
  - a parameter added in the middle of a positional list, removed, renamed or retyped
  - a keyword-only marker (`*`) added or removed, or `*args` / `**kwargs` introduced
  - call sites changing in the same PR, or not changing when they should
  - an overload or type-annotation change on a public function
narrows_playbooks: neutral
escalates_with: [public-api, trust-boundary, auth, money]
guide_refs:
  - "#signatures-and-command-query-separation"
  - "#compatibility-hyrums-law"
  - "#constructors-that-take-too-many-arguments"
  - "#review-locally-not-only-in-the-browser"
tools: [lsp-references, lsp-call-hierarchy, lsp-implementations, ripgrep, file-outline, read-file, ci-results]
bot_visibility: partial
```

### What it looks like in a diff

One or two changed lines at a definition, and a scatter of one-line edits at call sites, or
none. Python: `def send(msg, retries=3)` becomes `def send(msg, *, retries=3, timeout=10)`.
TypeScript: `function send(msg: string, retries?: number)` becomes
`function send(msg: string, opts: SendOptions)`.

### How to recognize it

The definition's parameter list, parameter types or return annotation differ between base and
head. Classify by what an existing caller experiences:

| Change | Existing callers |
| --- | --- |
| Add a parameter with a default, at the end | Keep working |
| Add a required parameter | Break |
| Add a parameter in the middle of positional parameters | Break silently if the types match |
| Remove or rename a parameter | Break; keyword callers fail loudly, positional callers may not notice a rename |
| Make positional parameters keyword-only | Break positional callers |
| Narrow a parameter type | Break callers passing the wider type |
| Widen a parameter type | Keep working |
| Change a parameter's meaning at the same name and type | Break silently |

The last two rows are the dangerous ones: the type checker stays quiet and the runtime keeps
running.

Look-alikes to rule out:

- **Internal function.** Private by name or location, with all callers in the diff. The change
  is routine, and the check is that every caller was updated.
- **Overridden method.** A method signature changed on a base class or Protocol also changes
  every implementation. See `lsp-implementations`.
- **Constructor.** Same rules, plus the guide's warning about
  [too many arguments](../../Code-Review-Guide-and-Playbooks.md#constructors-that-take-too-many-arguments).

### Likely intents

1. **New capability.** An option added for a feature this PR builds.
2. **Cleaning up.** A boolean mode flag split into two functions, per the guide's signature
   rules.
3. **Type tightening.** A looser type narrowed to what the function uses.
4. **Making a hidden dependency explicit**, passing in what used to be read from global state.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Who calls it? | Go to References, Call Hierarchy | `lsp-references`, `lsp-call-hierarchy` |
| Are all callers in the diff updated? | Compare references to changed files | `lsp-references` against `pr-files-api` |
| Who overrides or implements it? | Go to Implementation | `lsp-implementations` |
| Is it public? | Check exports and `__all__` | `read-file`, `file-outline` |
| Do callers pass it dynamically? | Search for `**kwargs` forwarding, `getattr`, decorators | `ripgrep` |
| Do callers outside the repo exist? | Check packages, docs | `linked-work-item` |
| Does CI type-check the callers? | Check results | `ci-results` |

### What not to spend review on

The function body, if only the signature changed, and call sites whose only edit is the
mechanical argument update.

### Checklist

- **Every caller is updated or still valid.** Count references at base against the changed
  call sites. A caller the PR didn't touch is either still valid or a bug.
- **Positional vs. keyword.** A reordered or inserted positional parameter breaks callers
  without a type error when the types match. Prefer adding at the end, or keyword-only.
- **A new required parameter has a path for existing callers.** A default, an overload, or
  all callers changed.
- **The change is additive when it can be.** The guide's endpoint advice applies to functions
  with outside callers: add alongside, deprecate the old form
  ([DEL-06](deletion.md#del-06-deprecation-shim-added)), remove later.
- **Subclasses and implementations match.** Overrides keep the Liskov-compatible signature.
- **Dynamic callers.** Forwarded `**kwargs`, decorators that wrap and re-expose the signature,
  `functools.partial`, and callbacks passed by name.
- **Mocks and fakes updated.** A mock with its own signature still accepts the old call and
  hides the break. `autospec=True` (Python) or a typed mock catches it.
- **Docstring and type stubs agree.** `.pyi` files and generated clients are a second copy.

### How it combines with domain playbooks

Neutral for private functions. For functions at a trust boundary (a validator, a permission
check), a parameter change that makes a check optional is a security change, so the
[input-validation](../../Code-Review-Guide-and-Playbooks.md#code-that-validates-user-input)
or [auth](../../Code-Review-Guide-and-Playbooks.md#authentication-and-authorization) playbook
applies to the new shape.

### Red flags

- A new parameter with a default that preserves old behavior only on some paths.
- A parameter inserted before existing ones with the same type.
- `*args, **kwargs` added to "keep compatibility", hiding the real contract.
- A changed signature on a method with overrides, and a PR that didn't touch any.
- A security-relevant flag defaulting to the unsafe value (`verify=False`, `check_perms=False`).

### Worked example

```diff
-def send(msg: Message, retries: int = 3) -> Receipt:
+def send(msg: Message, timeout: float = 10.0, retries: int = 3) -> Receipt:
```

`lsp-references` finds nine callers; two pass `retries` positionally (`send(m, 5)`) and
neither is in the diff. Both now set `timeout=5` and silently get the default retries. The
types are `float` and `int`, so the checker is quiet only because `5` is a valid float. The
comment asks to put `timeout` last or make both keyword-only.

### ai-review-bot today

The agents see the changed definition and whichever call sites are in the diff. They can't
list callers, so a caller the PR missed is invisible. Positional-shift bugs are catchable in
principle from the hunk alone, which is the one case the bot can reason about without a
search. What it would need: references at base for the changed symbol, and the override list.

### Eval seed

On a parameter inserted in the middle of a positional list, with an untouched caller passing
positionally, the review names the caller and the silent shift.

## IFC-02: Return value or exception contract changed

```yaml
id: IFC-02
name: Return value or exception contract changed
family: interface
aliases: [return type change, new exception, raises instead of returns None, error shape change]
signals:
  - a return annotation changed (`-> X` to `-> X | None`, `Promise<T>` to `T`)
  - '`return None` replaced by `raise`, or the reverse'
  - a new exception type raised, or an existing one's class hierarchy changed
  - a sentinel, tuple shape or dict key set changed
  - '`Result` / `Option` style wrapper introduced or removed'
narrows_playbooks: neutral
escalates_with: [public-api, critical-path, data-write, money]
guide_refs:
  - "#signatures-and-command-query-separation"
  - "#fail-fast-on-every-path"
  - "#compatibility-hyrums-law"
  - "#least-astonishment"
tools: [lsp-references, lsp-call-hierarchy, ripgrep, read-file, ci-results]
bot_visibility: partial
```

### What it looks like in a diff

The change is where the function ends, or in its annotation. Python: `return user` followed
by a new `raise UserNotFound(id)` where it used to be `return None`. TypeScript:
`getUser(id): User | undefined` becomes `getUser(id): Promise<User>`.

### How to recognize it

Compare the set of outcomes a caller can observe before and after: values returned, values
that mean "nothing", exceptions raised, and their types. A diff that changes the outcome set
changes the interface, even with the same parameters.

| Change | Existing callers |
| --- | --- |
| `None` becomes an exception | Callers that test for `None` never reach their handler; the exception propagates |
| Exception becomes `None` | Callers that catch it stop catching; a later attribute access fails far from the cause |
| New exception type raised | Callers catching specific types miss it |
| Exception base class changed | `except Base` clauses start or stop matching subclasses |
| Return type widened (`X` to `X \| None`) | Callers that used the value unguarded now fail |
| Return type narrowed | Safe for callers; check the docs and stubs |
| Sync becomes async (returns `Promise`/coroutine) | Every caller now holds a promise, not a value |
| Same type, different meaning (units, ordering, empty vs. missing) | Callers fail silently |

### Likely intents

1. **Fail fast.** The guide prefers raising to returning a sentinel that gets ignored.
2. **Clearer contract.** A tuple with differing meanings becomes a named type.
3. **Supporting new behavior** that needs a new outcome.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| How do callers handle the old outcomes? | Open each reference | `lsp-references`, then `read-file` on a window around each |
| Who catches the old exception? | Search for it | `ripgrep` for the exception name; `lsp-references` on the class |
| Is there a framework mapping errors to responses? | Check error handlers | `ripgrep` for exception handlers, middleware |
| Are there sibling functions with the same convention? | Look at neighbors | `file-outline`; keep the repo's convention |
| What do the tests assert? | Read test diffs | `read-file`, `ci-results` |

### What not to spend review on

The internals that produce the new outcome, unless they changed too.

### Checklist

- **Every caller handles every outcome of the new contract.** Not just the new one: the old
  ones may still occur.
- **Handlers for removed outcomes are removed.** A `catch` for an exception nothing raises
  anymore is dead code with a false implication.
- **An error mapping covers the new exception.** A framework that turns `NotFound` into a 404
  turns an unmapped exception into a 500. Whether a new exception becomes an HTTP error
  hands over to the endpoint playbook.
- **Error message text and error codes are part of the contract** when users or clients match
  on them (Hyrum's Law). Changing them is a change here, even if the exception type stays.
- **Async boundary.** A function changed from returning a value to returning a promise breaks
  every un-awaited caller silently in JavaScript, which will compare or use a `Promise`.
  Python coroutines left un-awaited emit a warning but not an error. Check every call site for
  `await`.
- **Transaction behavior.** A new exception inside a transaction changes what rolls back.
- **Docs, stubs and type annotations updated.**

### How it combines with domain playbooks

Neutral by default. A new exception path in a handler is judged by the
[fail fast](../../Code-Review-Guide-and-Playbooks.md#fail-fast-on-every-path) rules, and in
queue consumers by the
[transient vs. permanent](../../Code-Review-Guide-and-Playbooks.md#background-jobs-queues-and-events)
error rules: an exception that used to be a skipped message may now retry forever.

### Red flags

- A function changed from returning `None` to raising, with callers that do `if not result:`.
- A new broad exception class that subclasses `Exception` directly, not the project's base.
- A coroutine or promise returned where the caller treats it as a value.
- A tuple return gaining a field, unpacked at callers with a fixed arity.
- Error message text changed while tests or clients match on it.

### Worked example

`find_account(id)` used to return `None` for a missing account and now raises
`AccountNotFound`. Of eleven callers, ten were updated. The eleventh is `webhook.py`'s
`if find_account(id) is None: return 200`, which now raises and returns 500, so the
provider retries the webhook indefinitely. That's the finding.

### ai-review-bot today

The agents can reason about the changed function and the call sites in the diff. They can't
enumerate the untouched callers, which is where this goes wrong. The silent-failure-hunter
agent can flag a new swallowed exception inside the diff but not one at an untouched caller.
What it would need: callers of the function, with a window of code around each.

### Eval seed

On a change from `return None` to `raise`, with an untouched caller testing for `None`, the
review names that caller and what it does now.

## IFC-03: Exported type changed

```yaml
id: IFC-03
name: Exported type changed
family: interface
aliases: [model change, schema type change, dataclass field change, interface change, DTO change]
signals:
  - a field added to, removed from, renamed or retyped in a class, dataclass, Pydantic model, TypedDict or TypeScript `interface` / `type`
  - an optional field made required, or the reverse
  - a union widened or narrowed
  - a type's `extra` / strictness config changed
  - a class's base class or generic parameters changed
narrows_playbooks: neutral
escalates_with: [public-api, trust-boundary, data-write, migration]
guide_refs:
  - "#data-models-that-cant-hold-illegal-states"
  - "#compatibility-hyrums-law"
  - "#endpoint-schema-changes-versioning-and-deprecation"
  - "#parse-at-the-boundary-trust-the-types-inside"
  - "#data-modeling-tables-relationships-and-domain-objects"
tools: [lsp-references, lsp-implementations, workspace-symbols, ripgrep, module-graph, read-file, ci-results]
bot_visibility: partial
```

### What it looks like in a diff

A field list changes. Python: a Pydantic `BaseModel` gains `currency: str`, or loses
`legacy_id`. TypeScript: `interface Order { id: string }` becomes `{ id: number }`, or a
property turns from `name?: string` into `name: string`.

### How to recognize it

A type used across modules (imported in more than one place) has a changed member set,
optionality or member type. Work out three audiences, since a type often has all of them:

1. **Producers** build the type. A new required field breaks every constructor call.
2. **Consumers** read it. A removed field breaks every reader.
3. **Serialization.** If the type is parsed from or dumped to JSON, a database row, a cache
   entry or a message, the field name is also a wire or storage name, and old data in that
   shape persists after the deploy.

Look-alikes to rule out:

- **A type used by one module.** Treat as an ordinary change. All consumers are in the diff.
- **A type mapped to a response model.** Its change is an endpoint schema change:
  use the [endpoint playbook's table](../../Code-Review-Guide-and-Playbooks.md#endpoint-schema-changes-versioning-and-deprecation).
- **A type mapped to a table.** A column change follows in a migration.
  See [migrations](../../Code-Review-Guide-and-Playbooks.md#migrations-and-deployment-sequencing).

### Likely intents

Modeling a new concept, making an illegal state unrepresentable (per the guide), aligning with
an upstream schema, or removing a field after a feature went.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Who constructs it? | Go to References on the type and constructor | `lsp-references` |
| Who reads each changed field? | References on the field | `lsp-references` on the member |
| Where is it serialized or persisted? | Search for the type name and its field names | `ripgrep` for field names in JSON fixtures, SQL, caches, queue payloads |
| Who subclasses or implements it? | Go to Implementation | `lsp-implementations` |
| Is it re-exported from the package root? | Check barrels | `read-file`, `module-graph` |

### What not to spend review on

Each construct and read site that merely follows from the new shape.

### Checklist

- **Producers and consumers are both covered.** Field added: who constructs it, and with what?
  Field removed: who reads it?
- **Optional vs. required is deliberate.** Making a field required breaks producers, including
  tests and fixtures. Making it optional breaks consumers that assumed presence, and in
  TypeScript `strictNullChecks` surfaces it only where the types are followed.
- **Stored and in-flight data still parses.** Old rows, cached values and queued messages in
  the old shape arrive after the deploy. A required field with no default fails on every
  one of them.
- **Strictness settings.** Pydantic's `extra="forbid"` or a closed TypeScript type makes any
  added field a break for strict clients.
- **A field's type change is a break even when it looks wider.** `int` to `str` ids, `Decimal`
  to `float`, naive to aware datetimes, `null` vs. absent.
- **Generated artifacts regenerated.** OpenAPI schema, JSON Schema, GraphQL schema, generated
  clients and `.pyi` files.
- **Illegal states.** New field combinations that the type permits but the code doesn't
  handle. Apply the guide's rules on
  [data models](../../Code-Review-Guide-and-Playbooks.md#data-models-that-cant-hold-illegal-states).

### How it combines with domain playbooks

It hands off by where the type goes: wire types to the endpoint playbook, stored types to the
migrations playbook, event types to [IFC-06](#ifc-06-event-or-message-payload-changed). For an
internal-only type the guide's design sections apply and nothing else.

### Red flags

- A new required field on a type that is deserialized from stored data, with no default.
- A field removed from a type that appears in a published client package.
- Serialization aliases changed along with the attribute name.
- A union member removed while stored values still hold it.

### Worked example

`Order.currency` is added as a required `str` on a Pydantic model that is also the response
model. `rg "Order("` finds three constructors in tests and one in `import_legacy.py`, which
isn't in the diff and fails at runtime for every imported order. Separately, the model is
the response model, so clients with a closed generated type reject the new field. Two
comments.

### ai-review-bot today

The agents see the model change and constructors in the diff. They can't find other
producers, consumers or stored data, nor tell that the type is a response model unless that
shows up in the same hunk or an import. The type-design-analyzer (Tier 2) judges the model's
design but not its compatibility. What it would need: references to the type and each changed
field, and a search for serialized uses.

### Eval seed

On a new required field on a type constructed in an untouched file, the review names that
constructor and asks for a default or an update.

## IFC-04: Default value changed

```yaml
id: IFC-04
name: Default value changed
family: interface
aliases: [new default, changed default, flipped default, default argument change]
signals:
  - a default argument value edited (`retries=3` to `retries=1`, `verbose=False` to `True`)
  - a default in a settings model, `Field(default=...)`, or `.env.example` changed
  - an `Optional` that used to fall back to one value now falls back to another
  - a constant used as a default edited
  - sort order, pagination size, timeout or limit constants edited
narrows_playbooks: false
escalates_with: [public-api, auth, trust-boundary, money, critical-path, concurrency]
guide_refs:
  - "#compatibility-hyrums-law"
  - "#configuration-files"
  - "#endpoint-schema-changes-versioning-and-deprecation"
  - "#least-astonishment"
tools: [lsp-references, ripgrep, blame-C, log-L, read-file, linked-work-item]
bot_visibility: partial
```

### What it looks like in a diff

One changed literal. It's often the smallest diff in the PR and the most consequential:
`timeout=30` becomes `timeout=5`; `verify_ssl=True` becomes `False`; `PAGE_SIZE = 50`
becomes `100`; `enabled: false` becomes `true` in a default config.

### How to recognize it

A literal that sits in a parameter default, a settings field, a module constant used as one,
or a config default changed. Every caller that doesn't pass the value
explicitly just got different behavior, without any edit on their side.

The guide's endpoint table lists this as breaking: "Change a default, sort order, status code
or error shape: behavior change even if the schema is identical."

### Likely intents

A tuning change, a safer default, a fix for a symptom that was seen in one place, or a change
for one caller made at the shared default.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Which callers rely on the default? | References; look for calls that omit the argument | `lsp-references`, then `read-file` windows around each |
| Which pass it explicitly? | Same search | `ripgrep` for the keyword at call sites |
| Why did it have this value? | Blame the line | `blame-C`, `log-L`, `git log -S` on the literal |
| Is it overridden in deployment config? | Search config and manifests | `ripgrep` in YAML, `.env*`, Helm values, docs |
| What problem is the change solving? | Read the PR | `linked-work-item` |

### What not to spend review on

Whether the new number is good in the abstract. Ask what changes for whom.

### Checklist

- **Say who gets different behavior.** Every caller using the default, in this repo and others.
  If only one caller needed the change, the fix belongs at that call site, not at the shared
  default.
- **Is the old value there for a reason?** Blame it. A timeout of 30 may be matched to an
  upstream's behavior.
- **Safe direction.** A default moving toward less safe (auth off, validation looser, TLS
  verification off, larger limits) needs a reason in the PR, per the guide's rule that
  defaults are safe.
- **Deployments that rely on the old default still work.** Config that omits a key inherits
  the new value on next deploy. If that matters, set the old value explicitly in their config
  first.
- **Mutable defaults.** In Python a default of `[]` or `{}` is shared across calls (a bug,
  not just a change).
- **Docs and `.env.example` updated**, so the written default matches the real one.
- **Tests that pinned the old default** changed deliberately, with the reason visible, rather
  than adjusted to pass.

### How it combines with domain playbooks

It widens them. A default is a behavior change on every unspecified path, so the domain
playbook for the code it controls applies to the new value: auth defaults to the auth
playbook, timeouts to the critical-path playbook, validation limits to the input-validation
playbook, and pagination or ordering on an endpoint to the endpoint schema table.

### Red flags

- A default flipped from safe to unsafe with a description about convenience.
- A limit raised on a path an untrusted caller can hit.
- A timeout shortened with no look at the slowest legitimate call.
- A shared default changed to fix one caller.
- A test changed in the same PR to match the new default.

### Worked example

`def fetch(url, timeout=30)` becomes `timeout=5` to fix a hung request in `sync_job.py`. There
are 14 other callers, and `rg` shows 3 are calls to the report generator that routinely
takes 12 seconds. The comment asks to pass `timeout=5` at `sync_job.py` and leave the default.

### ai-review-bot today

A changed literal is in the diff, so the bot can see it. It can't see which callers rely on
the default, or why the old value was chosen, and a one-line change is easy to treat as
trivial. A diff this small is classified trivial only when every file is documentation, so it
gets the normal tier, and nothing raises it. What it would need: callers
that omit the argument, and the blame message.

### Eval seed

On a shortened default timeout with an untouched caller that needs longer, the review names
that caller and asks for the change at the call site.

## IFC-05: Env var or config key renamed

```yaml
id: IFC-05
name: Env var or config key renamed
family: interface
aliases: [rename setting, rename env var, config migration, settings key change]
signals:
  - a string in `os.environ[...]`, `os.getenv(...)`, `process.env.X` or a settings field name changed
  - '`.env.example`, `docker-compose.yml`, Helm values, CI workflows or docs changed in the same way'
  - a pydantic-settings field renamed, or its `env_prefix` / `alias` changed
  - a YAML or TOML key renamed in a config loader
  - a required variable added
narrows_playbooks: false
escalates_with: [critical-path, auth, trust-boundary]
guide_refs:
  - "#configuration-files"
  - "#compatibility-hyrums-law"
  - "#fail-fast-on-every-path"
  - "#least-privilege-and-trust-boundaries"
tools: [ripgrep, read-file, blame-C, linked-work-item, ci-results]
bot_visibility: partial
```

### What it looks like in a diff

The code reads `PAYMENTS_API_KEY` where it used to read `PAYMENT_API_KEY`, and the example
file and docs are updated to match. The deployed environment is not in the diff.

### How to recognize it

A name that is looked up at runtime from outside the code changed. This is the interface
whose other side is always outside the repo: deployment config, secrets stores, CI settings,
developer machines. Nothing in the repo fails when the deployed name is stale; the process
starts, reads nothing, and either crashes or falls back to a default.

### Likely intents

A naming convention, an `env_prefix` introduced, a fix for a typo, or a split of one setting
into several.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Where else is the old name? | Search across files | `ripgrep` for old name in code, compose files, Helm, Terraform, CI, Dockerfiles, docs, scripts |
| What happens if the name is missing? | Read the loader | `read-file` on the settings code: does it raise, default or return `None`? |
| What is the default? | Same | `read-file` |
| Where is it set in each environment? | Ask or inspect | `linked-work-item`; deployment config if in the repo |
| Is the old name still read? | Check the loader for a fallback | `read-file` |

### What not to spend review on

The value's format or contents, unless changed.

### Checklist

- **Every writer and reader is updated.** The repo's own: code, `.env.example`, compose,
  manifests, workflows, scripts, docs. The ones outside it: production secrets, staging, CI
  secrets, other developers' machines.
- **A deploy order or a fallback exists.** The safest form reads the new name and falls back
  to the old for a release, with a warning. Without it the PR must say the environments are
  updated first.
- **Missing values fail at startup.** If the new name is absent, the process raises with the
  name in the message (the guide's
  [typed settings, fail fast](../../Code-Review-Guide-and-Playbooks.md#configuration-files)
  rule), rather than falling back to a default that works in dev and is wrong in production.
- **No default that hides the miss.** A rename where the new variable has a silent default
  means production runs on the default until someone notices.
- **Secret names.** A renamed secret is set in the secret store, not in the diff. No secret
  value appears in the PR.
- **Prefix and alias interplay.** In pydantic-settings, `env_prefix` plus a field name forms
  the variable name, so a field rename or prefix change renames the variable.

### How it combines with domain playbooks

The [configuration playbook](../../Code-Review-Guide-and-Playbooks.md#configuration-files)
owns the rest: typed and validated at startup, safe defaults, per-environment differences.
This entry adds the part the playbook lacks, which is the rename's two-sided deploy.

### Red flags

- Variable renamed and the production config not mentioned in the PR.
- A new variable with a default of an empty string or `None` for something required.
- Old and new names both read, with the old one taking precedence.
- A rename in a path that handles auth or keys, where a silent default means a disabled check.

### Worked example

`JWT_SECRET` becomes `AUTH_JWT_SECRET` in `settings.py`, `.env.example` and the README. The
`Settings` field has `default="dev-secret"`. In production the old variable is set, the new
one isn't, and the process starts happily and signs tokens with the dev secret. Two comments:
remove the default so a miss fails startup, and read the old name as a fallback for one release.

### ai-review-bot today

The hosted agents see the code and the files in the diff. They can't see the deployed
environment, and a search for the old name in untouched files isn't possible. A rename in a
file under a path with `secret` or `auth` in it raises the tier to complex. What it would
need: a search for the old name at head, and the loader's missing-value behavior.

### Eval seed

On an env var rename where the new setting has a development default, the review flags the
silent default and asks for a fallback or a startup failure.

## IFC-06: Event or message payload changed

```yaml
id: IFC-06
name: Event or message payload changed
family: interface
aliases: [event schema change, queue message change, webhook payload change, topic schema]
signals:
  - a field added to, removed from, renamed or retyped in a published event, queue message, webhook body or log record consumed elsewhere
  - an event type or topic name changed
  - a producer and a consumer changed in the same PR, or only one of them
  - a schema file (Avro, Protobuf, JSON Schema) changed
  - a version field or envelope changed
narrows_playbooks: false
escalates_with: [public-api, data-write, money, critical-path, migration]
guide_refs:
  - "#background-jobs-queues-and-events"
  - "#compatibility-hyrums-law"
  - "#data-models-that-cant-hold-illegal-states"
tools: [lsp-references, ripgrep, read-file, module-graph, linked-work-item]
bot_visibility: partial
```

### What it looks like in a diff

The producer builds a dict or object with a different shape: `{"order_id": 42}` becomes
`{"order": {"id": 42}}`. Or a consumer's handler reads a field the producer doesn't send yet.
Often only one side is in the PR.

### How to recognize it

A message that crosses a process boundary has a changed field set, name, type or meaning. Two
things make these different from a function signature: the consumers are usually other
services or other deployments of this one, and old messages are still in the queue after the
deploy.

### Likely intents

New data for a consumer, a restructure, a rename for consistency, or removing a field no one
uses.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Who consumes this event? | Search for the event type and handler | `ripgrep` for the topic, type name and field names across repos if available |
| Who produces it? | Same | `ripgrep`, `lsp-references` on the payload type |
| Are there old messages in flight? | Check queue retention and dead letters | `linked-work-item`; deployment docs |
| Is there a schema registry or a contract test? | Look for schema files and tests | `read-file`, `ci-results` |
| What is the deploy order? | Read the description | `linked-work-item` |

### What not to spend review on

The business logic in the handler, if it's unchanged.

### Checklist

The guide states the rule: "Event schemas are versioned like endpoints. Consumers tolerate
unknown fields; adding a required field or changing a meaning is a breaking change." The
operation-specific checks:

- **Consumers first for additions.** A new field can be sent once consumers tolerate it;
  consumers that need the field deploy before producers send it.
- **Producers last for removals.** A field is removed from producers only after every consumer
  has stopped reading it.
- **Old-shape messages parse.** The queue still holds messages from before the deploy, and
  retried or dead-lettered ones arrive for days. The consumer handles both shapes during the
  window.
- **Renames are add, migrate, remove.** A rename in one step is a removal and an addition that
  consumers see as a missing field.
- **Meaning, not just shape.** Units, time zones, id formats and enum values count. A
  `status` string gaining a value breaks exhaustive consumers, as in the guide's response
  enum row.
- **Whole-object payloads.** The guide prefers ids plus a small amount of data. A payload that
  now embeds a serialized domain object will go stale and grow.
- **Ordering and idempotency assumptions** didn't change with the payload.
- **A contract test or schema-registry check exists**, or the PR adds one.

### How it combines with domain playbooks

The
[background jobs, queues and events playbook](../../Code-Review-Guide-and-Playbooks.md#background-jobs-queues-and-events)
owns the review of handlers (idempotency, retries, dead letters, outbox). This entry adds the
cross-deployment compatibility questions. A webhook delivered to customers is a public API and
follows the
[endpoint schema rules](../../Code-Review-Guide-and-Playbooks.md#endpoint-schema-changes-versioning-and-deprecation).

### Red flags

- Producer and consumer changed in one PR with no deploy order stated.
- A required field added to an event consumed by another team.
- A field renamed in place.
- A new event type routed to a consumer with a closed `match` that raises on unknown types.
- A payload shape change with no version field or contract test.

### Worked example

`OrderPaid` changes from `{"order_id": 42}` to `{"order": {"id": 42, "total": 1000}}`. The
billing consumer in the same repo is updated. `rg "OrderPaid"` also finds an analytics
consumer in `jobs/analytics.py` reading `payload["order_id"]`, which now raises `KeyError`
on every message, and the queue's retry policy sends each one back five times before the
dead letter. Comment: send both shapes for a release, or update the analytics consumer first.

### ai-review-bot today

The bot sees the producer's change and any consumers in the diff. It can't find consumers
elsewhere in the repo or in other repos, and can't see the queue's state. A payload change in
a file with `schema` in its path raises the complexity tier. What it would need: a search for
the event name and the fields, and the PR's stated deploy order.

### Eval seed

On a payload field rename where an untouched consumer still reads the old key, the review
names the consumer and asks for a transition.

## IFC-07: Behavior-preserving API reshape

```yaml
id: IFC-07
name: Behavior-preserving API reshape
family: interface
aliases: [API cleanup, facade, adapter introduced, signature cleanup, boolean flag to enum]
signals:
  - a new function or class that wraps the old one, and call sites moving to it
  - a boolean mode flag replaced by an enum or two functions
  - a long parameter list replaced by an options object or dataclass
  - an inheritance hierarchy replaced by a Protocol / interface
  - tests largely unchanged, call sites changing mechanically
narrows_playbooks: true
escalates_with: [public-api]
guide_refs:
  - "#signatures-and-command-query-separation"
  - "#constructors-that-take-too-many-arguments"
  - "#shared-helpers-that-grow-mode-flags"
  - "#abstractions-dependency-inversion-and-interface-segregation"
  - "#building-for-needs-you-dont-have"
tools: [lsp-references, lsp-call-hierarchy, tree-sitter-diff, ripgrep, read-file]
bot_visibility: partial
```

### What it looks like in a diff

The interface looks different and the work done is the same. `render(obj, compact=False)` becomes
`render(obj, mode=RenderMode.COMPACT)`. `connect(host, port, user, password, timeout, retries)`
becomes `connect(config: ConnectionConfig)`. Call sites change shape with a regular pattern, and
the function body mostly moves or forwards.

### How to recognize it

Behavior stays constant across the change, while the way callers ask for it changes. The test
is a mapping: every old call form corresponds to exactly one new call form. If a reviewer can't
write that mapping, behavior probably changed too (see [behavior.md](behavior.md) and
[composite.md](composite.md)).

Look-alikes to rule out:

- **Reshape plus new behavior.** A new option appears among the old ones.
- **Reshape that hides a default change.** The new options object has defaults that differ
  from the old function's.
- **Public reshape with no migration path**, which is a break ([IFC-01](#ifc-01-function-signature-changed)).

### Likely intents

Fixing the shapes the guide warns about: flag arguments, too-long parameter lists, a missing
model. Making the interface harder to misuse.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Does each old call map to one new call? | Compare call sites before and after | `lsp-references` at base, `tree-sitter-diff` on call hunks |
| Are the defaults the same? | Compare the old and new defaults | `read-file` on both |
| Is there a compatibility layer for outside callers? | Check exports | `read-file` on `__all__` / barrels |
| Is the new shape used more than once? | Count callers | `lsp-references` |

### What not to spend review on

The moved or forwarded body and the mechanical call-site edits, once the mapping is confirmed.

### Checklist

- **The mapping holds for every caller.** In particular for callers that passed a non-default
  value for the part that got reshaped, and for callers that passed it dynamically.
- **Defaults are identical** in the new options type. A reshaped signature is the common
  place for a default to change by accident ([IFC-04](#ifc-04-default-value-changed)).
- **The new shape is better by the guide's rules**: two functions instead of a flag; a named
  type instead of a tuple; an enum with room for a third value. A reshape that adds a layer
  with one implementation is [building for needs you don't have](../../Code-Review-Guide-and-Playbooks.md#building-for-needs-you-dont-have).
- **Outside callers are served.** A compatibility form for a release, or a stated break.
- **Tests still pass for the right reasons.** A test updated to the new shape should assert the
  same expectations as before.
- **One reshape per PR.** Mixing it with behavior changes makes the equivalence unreviewable.
  The guide asks for mechanical edits in their own commits.

### How it combines with domain playbooks

It narrows them to the confirmation of equivalence. Domain playbooks apply only to code that
changed meaning, and none should have.

### Red flags

- A reshape PR where a test's expected value changed.
- An options object whose defaults differ from the old function's.
- A boolean replaced by an enum with one member.
- A reshape bundled with a feature.

### Worked example

`render(obj, compact=False, legacy=False)` becomes `render(obj, style=Style.COMPACT)`. The
mapping covers `compact=True` and the default. `legacy=True` has no equivalent: the legacy path
was deleted, and two callers in `export/` that passed `legacy=True` were not updated. The
comment: either these callers need a `Style.LEGACY`, or the PR is removing a mode, which should
be said.

### ai-review-bot today

The agents see both forms in the diff. They can't confirm the mapping holds across all
callers, and may comment on the new options type as new code. What it would need: references
at base to enumerate old call forms, and a way to tell forwarded bodies from new ones.

### Eval seed

On a reshape that silently drops one old mode, the review identifies the mode with no
equivalent and the callers that used it.

## IFC-08: Export surface added or removed

```yaml
id: IFC-08
name: Export surface added or removed
family: interface
aliases: [visibility change, public/private, barrel change, __all__ change, API surface]
signals:
  - an entry added to or removed from `__all__`, a package `__init__.py`, an `index.ts` barrel, or `package.json` `exports`
  - a leading underscore added or removed from a name
  - '`export` added or removed on a TypeScript declaration'
  - a symbol made `public` / `private` / `protected`
  - '`py.typed` or type stubs added or removed'
narrows_playbooks: neutral
escalates_with: [public-api]
guide_refs:
  - "#compatibility-hyrums-law"
  - "#least-privilege-and-trust-boundaries"
  - "#abstractions-dependency-inversion-and-interface-segregation"
tools: [lsp-references, workspace-symbols, ripgrep, module-graph, read-file]
bot_visibility: partial
```

### What it looks like in a diff

A name appears in or disappears from the list that defines what a package offers. Python:
`__all__ = [...]` gains `"retry_policy"`. TypeScript: `export * from "./internal"` in
`index.ts`, or `export` dropped from a function.

### How to recognize it

A change that doesn't alter any code but alters which names outside code can reach. The
guide's library rule: "anything public by naming is public in practice." In Python a name
without a leading underscore, importable from a module, is public unless documented
otherwise; in TypeScript, anything reachable from the package entry point is.

### Likely intents

**Adding** exposes something for a new consumer, or exports it only for a test (a smell).
**Removing** hides an internal that leaked, or finishes a deprecation.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Who imports the symbol from outside its package? | References | `lsp-references`, `ripgrep` across repos |
| Is it documented or in examples? | Search docs | `ripgrep` in docs |
| Why is it being exposed? | Read the description | `linked-work-item` |
| What else becomes reachable through a wildcard re-export? | Read the barrel | `read-file`, `module-graph` |

### What not to spend review on

The symbol's implementation.

### Checklist

- **Adding exposes a contract.** Every exported name needs the same care as an endpoint:
  stable shape, documented, tested. Ask if it's meant to be supported.
- **Exported for a test only.** Tests import from the production module without needing a
  wider export; the guide's test rules apply.
- **A wildcard re-export** (`export *`, `from x import *`) exposes everything in the module,
  including later additions.
- **Removing needs a deprecation cycle or a stated break**, per
  [DEL-07](deletion.md#del-07-deprecation-shim-removed).
- **Names made private still have internal callers updated.**
- **Types follow.** An exported function that returns a non-exported type leaks it.

### How it combines with domain playbooks

Neutral, except where the exposed symbol is security-relevant (an internal auth helper made
public), when the auth playbook's least-privilege rules apply.

### Red flags

- An internal helper added to `__all__` "so the test can import it".
- `export *` from an internals directory.
- A removed export with callers in the repo's own examples or docs.

### Worked example

`index.ts` adds `export * from "./internal/crypto"`, exposing six helpers, one of which takes
a raw key. The comment asks for named exports of what's meant to be supported.

### ai-review-bot today

The agents see the barrel line and can reason about a wildcard. They can't tell who imports
what from outside, or whether the package is published. What it would need: package manifest
context and an outside-importers search.

### Eval seed

On a wildcard re-export of an internals directory, the review flags the leaked surface and
asks for explicit exports.

## IFC-09: Enum or union members changed

```yaml
id: IFC-09
name: Enum or union members changed
family: interface
aliases: [enum value added, enum value removed, status added, literal union change]
signals:
  - a member added to, removed from or renamed in an `Enum`, `Literal[...]`, TypeScript string union or `enum`
  - a new status, role, event type or error code
  - a `match` / `switch` / `if-elif` chain edited to handle a new value, or not
  - a database enum or CHECK constraint changed
narrows_playbooks: false
escalates_with: [public-api, data-write, migration, auth]
guide_refs:
  - "#endpoint-schema-changes-versioning-and-deprecation"
  - "#data-models-that-cant-hold-illegal-states"
  - "#compatibility-hyrums-law"
  - "#migrations-and-deployment-sequencing"
tools: [lsp-references, ripgrep, read-file, module-graph]
bot_visibility: partial
```

### What it looks like in a diff

One line added to a list of members. Python: `class Status(Enum): ... REFUNDED = "refunded"`.
TypeScript: `type Role = "admin" | "member" | "viewer"` gains `"auditor"`.

### How to recognize it

A closed set of values is edited. The direction decides the risk, in the same way as the
guide's endpoint table: an enum value added to a request is safe, while one added to a
response breaks clients with exhaustive handling.

| Change | What breaks |
| --- | --- |
| Value added, in a type the code consumes | Every `match` / `switch` / `if-elif` that doesn't handle it falls through or hits a default |
| Value added, in a type the code emits | Consumers with exhaustive handling fail on the new value |
| Value removed | Stored and in-flight data holding it no longer parses |
| Value renamed | Same as a removal plus an addition, for every stored and serialized copy |
| Value reordered, for an ordinal enum | Stored integers change meaning |

### Likely intents

A new state in a workflow, a new permission level, a new error code.

### Context to gather

| Question | Human action | Agent tool |
| --- | --- | --- |
| Which code branches on this type? | References on the type | `lsp-references`, `ripgrep` for the member names and the string values |
| Is there a default branch, and what does it do? | Read each branch | `read-file` windows |
| Where are values stored or sent? | Search | `ripgrep` for the string literals in SQL, fixtures, other services |
| Is there an exhaustiveness check? | Look for `assert_never` / `never` patterns | `ripgrep` |

### What not to spend review on

The members unaffected by the change.

### Checklist

- **Every branch on the type handles the new value on purpose.** A `default:` or `else:` that
  treats unknown as one of the old values will mishandle the value this PR adds.
- **Exhaustiveness is checked by the compiler or tests**: `assert_never` (Python's `typing`),
  or a `never` assignment in a TypeScript default branch.
- **Stored values.** A database enum needs a migration. PostgreSQL can add enum values but
  has no `DROP VALUE`, so a removed member needs a type rebuild, and rows holding it must be
  rewritten first.
- **Emitted values are documented as open** for external consumers, per the guide.
- **Authorization**: a new role or permission needs an explicit decision at each check, not a
  default that grants or denies by accident.
- **Ordinal values** (integer enums) aren't reordered or renumbered.

### How it combines with domain playbooks

It hands over to the endpoint playbook for response enums, the migrations playbook for
database enums, and the auth playbook for role or permission sets.

### Red flags

- A new member and a `default:` branch that silently treats it as an old member.
- A removed value still present in fixtures, seeds or stored data.
- A renamed enum string used in a database column.
- A new role not mentioned in any permission check.

### Worked example

`OrderStatus.REFUNDED` is added. `rg "OrderStatus"` shows `notify_customer()` has an
`if status == PAID ... else: send_receipt()`, so refunded orders now get a receipt email.
The comment points to that `else`.

### ai-review-bot today

The agents see the added member and the branches in the diff. They can't enumerate the other
branches on the type or see stored values. What it would need: a references search on the
type and on its string values.

### Eval seed

On a new enum member with an untouched `else` branch that mishandles it, the review names the
branch and the wrong behavior.
