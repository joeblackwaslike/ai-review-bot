# Code Review Guide, Playbooks and Language Notes

Joe Black · November 4, 2026

Part 1 is the guide: the principles, the review process, four sections that apply them to every diff, a worked example, the checklist and a PR description template. Part 2 holds the playbooks for specific kinds of change. Part 3 covers what differs between Python, TypeScript, shell and SQL.

## Contents

- [Part 1: Code Review Guide](#part-1-code-review-guide)
    - [Principles](#principles)
    - [How to run a review](#how-to-run-a-review)
    - [1. Simplicity and scope](#1-simplicity-and-scope)
    - [2. Design and structure](#2-design-and-structure)
    - [3. Correctness and safety](#3-correctness-and-safety)
    - [4. Readability and review](#4-readability-and-review)
    - [5. Playbooks for specific kinds of change](#5-playbooks-for-specific-kinds-of-change)
    - [Checklist](#checklist)
    - [Appendix: pull request description template](#appendix-pull-request-description-template)
- [Part 2: Code Review Playbooks](#part-2-code-review-playbooks)
    - [Reviewing code against its spec](#reviewing-code-against-its-spec)
    - [Design specs and plans](#design-specs-and-plans)
    - [New API endpoints](#new-api-endpoints)
    - [Endpoint schema changes, versioning and deprecation](#endpoint-schema-changes-versioning-and-deprecation)
    - [Code that validates user input](#code-that-validates-user-input)
    - [Authentication and authorization](#authentication-and-authorization)
    - [React components (JSX and TSX)](#react-components-jsx-and-tsx)
    - [Next.js](#nextjs)
    - [Accessibility](#accessibility)
    - [CSS and styling](#css-and-styling)
    - [HTML artifacts](#html-artifacts)
    - [Data modeling: tables, relationships and domain objects](#data-modeling-tables-relationships-and-domain-objects)
    - [Queries and indexes](#queries-and-indexes)
    - [SQL files and raw queries](#sql-files-and-raw-queries)
    - [Migrations and deployment sequencing](#migrations-and-deployment-sequencing)
    - [Code on the critical path](#code-on-the-critical-path)
    - [Background jobs, queues and events](#background-jobs-queues-and-events)
    - [Logging and error logging](#logging-and-error-logging)
    - [Shell scripts (Bash and zsh)](#shell-scripts-bash-and-zsh)
    - [Dockerfiles and container images](#dockerfiles-and-container-images)
    - [Infrastructure as code](#infrastructure-as-code)
    - [Configuration files](#configuration-files)
    - [Tests: levels, coverage, gaps and TDD](#tests-levels-coverage-gaps-and-tdd)
    - [Test code itself: helpers, fixtures and fakes](#test-code-itself-helpers-fixtures-and-fakes)
    - [Documentation and Markdown](#documentation-and-markdown)
    - [New dependencies](#new-dependencies)
    - [LLM prompts](#llm-prompts)
    - [Skills and instruction files](#skills-and-instruction-files)
    - [Agent rules files and subagents](#agent-rules-files-and-subagents)
    - [Hooks and commands](#hooks-and-commands)
    - [Agent workflows](#agent-workflows)
    - [AI-generated and AI-assisted code](#ai-generated-and-ai-assisted-code)
- [Part 3: Language Notes](#part-3-language-notes)
    - [Quick map](#quick-map)
    - [Python](#python)
    - [TypeScript and JavaScript](#typescript-and-javascript)
    - [Shell: Bash and zsh](#shell-bash-and-zsh)
    - [SQL](#sql)

---

# Part 1: Code Review Guide

Nov 4, 2026 · @Joe Black

Code review is a small set of principles applied to someone else's change. The guide states the principles once. Sections 1 to 4 each take one group and turn it into what to look for in any diff, what a violation looks like, and what to suggest instead. The principles are language-neutral; the examples are mostly Python, with TypeScript alongside where the two differ. Section 5 points to Part 2, with playbooks for specific kinds of change such as an endpoint, a React component, a migration, a Dockerfile or a skill file. Part 3 covers Python, TypeScript, shell and SQL: tooling, package management, idioms and smells. The checklist at the end condenses all of it.

The review process follows the same rules as the code it checks: confirm the change is what was asked for and as small as it can be, get the design right before the details, and hand anything a rule can state to a tool.

## Principles

The principles fall into four groups. Each one says what it means and how to apply it, both when writing code and when reviewing it.

### Simplicity and scope

**KISS (Keep It Simple, Stupid)**

- **Means:** Minimize moving parts: few concepts, few indirections, and behavior you can predict from reading one place.
- **Apply:** Pick the plain solution first. A 40-line function with one clear path beats a 10-line one that leans on metaclasses or a registry. In review, ask "what's the dumbest thing that would work?" and flag layers, factories, or config that exist only to serve one caller.

**YAGNI (You Ain't Gonna Need It)**

- **Means:** Don't build for requirements you don't have yet.
- **Apply:** No plugin system, extra parameters, or abstract base class "in case." Build it when the second real need shows up. In review, flag speculative hooks, unused flags, and generalization with no current caller, and delete them.

**How they differ:** KISS limits the *complexity of what you build*. YAGNI limits *what you build at all*. Together they point at the same review question: what's the smallest change that solves the problem in front of us?

**DRY (Don't Repeat Yourself)**

- **Means:** Every piece of *knowledge* (a rule, a constant, a schema) has one authoritative home.
- **Apply:** Dedupe business rules, not code that merely looks alike. Two functions that coincidentally match today but change for different reasons are not duplication. In review, flag the same validation or business rule encoded in two places. Don't flag a repeated literal that already explains itself; see section 1, Simplicity and scope.

**Rule of Three (a.k.a. AHA: Avoid Hasty Abstractions)**

- **Means:** Tolerate duplication until the third occurrence, then abstract.
- **Apply:** Two data points can't tell you the right abstraction shape. In review, push back on a shared helper with a pile of boolean flags. That's a wrong abstraction fitted to two cases.

**Premature optimization is the root of all evil (Knuth)**

- **Means:** Don't optimize without a measurement showing where the time goes.
- **Apply:** Write the clear version, profile, then fix the hot path. In review, ask "where's the benchmark?" for any change justified by performance.

**Make it work, make it right, make it fast (Kent Beck)**

- **Means:** The order matters. Correct behavior, then clean structure, then speed.
- **Apply:** Don't refactor before a test proves behavior. Don't tune before the structure is stable.

**Gall's Law**

- **Means:** Working complex systems evolve from working simple ones. Complex systems built from scratch don't work.
- **Apply:** Ship the thin vertical slice first. Be suspicious of designs that need five services before the first request succeeds.

### Design and structure

**SOLID** (five principles, one line each; the design and structure section applies each one in review)

- **SRP (Single Responsibility):** A module has one reason to change. Split a handler that validates, persists, and sends email.
- **OCP (Open/Closed):** Extend behavior without editing existing code. Add a new strategy or handler instead of another `elif`.
- **LSP (Liskov Substitution):** Subtypes must be usable wherever the base type is. A subclass that raises on an inherited method is a violation.
- **ISP (Interface Segregation):** Don't force consumers to depend on methods they don't use. In Python, small `Protocol`s over one fat interface.
- **DIP (Dependency Inversion):** High-level policy depends on abstractions, not concrete details. Inject the repository protocol; don't import the SQLAlchemy session in domain code.

**Separation of Concerns**

- **Means:** Each part of the system addresses one distinct concern (transport, domain logic, persistence).
- **Apply:** No SQL in route handlers, no HTTP types in domain services. In review, flag layer-crossing imports.

**High Cohesion, Low Coupling**

- **Means:** Things that change together live together. Things that don't shouldn't know about each other.
- **Apply:** If a change to one feature touches six modules, coupling is too high. If a module's contents have nothing in common, cohesion is too low.

**Law of Demeter (Principle of Least Knowledge)**

- **Means:** Talk to your direct collaborators, not their internals.
- **Apply:** `order.customer.address.city` chains mean the caller knows too much. Expose `order.shipping_city` or pass what's needed.

**Tell, Don't Ask**

- **Means:** Tell objects what to do instead of pulling their state out and deciding for them.
- **Apply:** Replace `if account.balance >= amt: account.balance -= amt` in the caller with `account.withdraw(amt)`, where the invariant lives.

**Composition over Inheritance**

- **Means:** Assemble behavior from small collaborators instead of deep class hierarchies.
- **Apply:** Reach for injected dependencies or `Protocol`s before a base class. Be wary of any inheritance chain deeper than two.

**Command-Query Separation (CQS)**

- **Means:** A method either changes state or returns data, not both.
- **Apply:** It's the seed of CQRS. In review, flag `get_*` functions with side effects.

### Correctness and safety

**Fail Fast**

- **Means:** Surface errors at the earliest point, close to the cause.
- **Apply:** Validate at boundaries, raise on invalid state, and don't swallow exceptions or return `None` to defer the problem. In review, flag bare `except` and silent fallbacks.

**Parse, Don't Validate / Make Illegal States Unrepresentable**

- **Means:** Convert untrusted input into a type that can only hold valid values, instead of re-checking raw data everywhere.
- **Apply:** Pydantic models at the edge, `Literal`, enums and `NewType`s inside. A `status: str` that can only be three values should be a `StrEnum`.

**Principle of Least Privilege**

- **Means:** Give code, services, and credentials only the access they need.
- **Apply:** Scoped API tokens, read-only DB roles for query paths, and no god-object `Context` passed everywhere.

**Explicit is better than implicit (Zen of Python)**

- **Means:** Behavior should be visible at the call site, not hidden in magic.
- **Apply:** Prefer explicit dependency injection over global registries, and avoid import-time side effects and monkey-patching.

### Readability and review

**Principle of Least Astonishment (POLA)**

- **Means:** Code should behave the way a reader expects from its name and shape.
- **Apply:** A function named `get_user` shouldn't create one. In review, a surprised reviewer is a finding.

**Boy Scout Rule**

- **Means:** Leave the code a bit cleaner than you found it.
- **Apply:** Small adjacent cleanups are fine. Keep them in separate commits from behavior changes so review stays legible.

**Chesterton's Fence**

- **Means:** Don't remove something until you know why it was put there.
- **Apply:** Before deleting a weird guard or "pointless" retry, check `git blame` and the linked issue. This is the counterweight to over-eager simplification.

**Hyrum's Law**

- **Means:** With enough users, every observable behavior of your API becomes something someone depends on.
- **Apply:** Treat output ordering, error message text, and timing as part of the contract once they're public. In review, flag "harmless" behavior changes to widely used interfaces.

**Conway's Law**

- **Means:** System structure mirrors the communication structure of the organization that built it.
- **Apply:** If service boundaries don't match team boundaries, expect friction. Use it deliberately when drawing bounded contexts.

## How to run a review

A review is a small system of its own, and the principles apply to it directly. Gall's Law says to size the change before reading it. Beck's order says what to look at first. Explicit is better than implicit says the mechanical rules belong in tooling, not in a reviewer's head.

### Size the change before reading it

Gall's Law holds for pull requests as much as for systems: a working change grows out of a smaller working change, and a large one built in a single step can't be reviewed or bisected. Before opening the diff:

- **Restate the intent in one sentence.** Read the linked spec, plan or ticket first, so you know what was meant before seeing what was built. If there's no stated intent, the first comment is a question, not a note on line 40.
- **Let CI go first.** Tests, linters and type checks pass before a person spends time on the diff. A red build is the author's to fix, not the reviewer's to read around.
- **Check the size.** Past a few hundred changed lines, review quality drops sharply. Ask for a split along a seam: refactor vs. behavior change, schema vs. code, new module vs. call-site migration.
- **Separate mechanical edits.** The Boy Scout Rule is welcome, but renames, moves and formatting go in their own commits so the behavior change stays legible.
- **Read the tests first.** They are the author's statement of what "it works" means, and they tell you what the code is supposed to promise.
- **List the new public surface.** Names, endpoints, config keys, migrations, events, error messages. By Hyrum's Law each becomes a contract the moment it ships, so these get the closest look.
- **Pick the playbooks.** Note which kinds of change the diff contains (an endpoint, a migration, a config file) and use the matching playbooks in section 5 alongside the general pass.

### Review in the order of make it work, make it right, make it fast

Beck's order for writing code is also the order for reviewing it, weighted by how expensive each kind of problem is to fix after merge:

1. **Scope.** Is this the smallest change that solves the problem? (Simplicity and scope.)
2. **Design.** Are the boundaries, models and contracts right? This is the hardest thing to change later. (Design and structure.)
3. **Correctness.** Does it work, including on failure paths? (Correctness and safety.)
4. **Readability.** Can the next person understand and change it? (Readability and review.)
5. **Speed.** Only with a measurement in hand.

If scope or design is wrong, stop and say so before leaving line-level comments. Detailed feedback on code that is about to be restructured wastes both people's time. A large change can be reviewed in two rounds: scope and design first, then everything else once those are settled.

### Review locally, not only in the browser

The web diff shows changed lines and a few lines of context, and that often isn't the whole story. A diff that removes five lines doesn't show what called them, what they protected, or what else depends on them. Checking the branch out lets you read the change as code, with navigation, search and the test suite.

**Checking out a PR in VS Code**

With the [GitHub Pull Requests extension](https://marketplace.visualstudio.com/items?itemName=GitHub.vscode-pull-request-github) ([docs](https://code.visualstudio.com/docs/sourcecontrol/github)):

1. Commit or stash your own work. Open the **Pull Requests** view and select the PR to open its **Description**.
2. Select **Checkout**. The extension switches to the PR's branch and enters review mode. **Changes in Pull Request** lists the changed files and commits.
3. Select a file there to see its diff and comment on lines, or use **Open File** to open the working copy with full language support.
4. Install the branch's dependencies (`uv sync`), or pnpm install, npm ci or bun install in Node projects, so navigation and tests reflect the PR, not your previous branch. Installing runs code from the PR (package install scripts, build hooks), and so do its tests. For a contributor you don't already trust, do this in a disposable, isolated environment (a dev container or VM) with no host credentials, no sensitive mounts and no privileged access, not in your authenticated workspace.
5. Submit comments and your verdict from the **Description**, then select **Exit Review Mode** to return to the branch you were on.

From a terminal, `gh pr checkout <number>` checks out the same branch for any editor.

**Navigating the change**

Shortcuts are for macOS; on Windows and Linux, Ctrl replaces Cmd. Function keys may need `fn`.

| Action | Shortcut | Use it to |
| --- | --- | --- |
| Go to Definition | Cmd+click, or F12 | Jump from a call to the code it runs |
| Open Definition to the Side | Cmd+Option+click | Read caller and callee side by side |
| Peek Definition | Option+F12 | Check a definition inline without losing your place |
| Go to Implementation | Cmd+F12 | Find the concrete classes behind a `Protocol` or ABC |
| Go to References | Shift+F12 | See every caller of a changed or removed symbol |
| Show Call Hierarchy | Shift+Option+H | Trace callers transitively, up to the entry points |
| Go to Symbol in File / in Workspace | Cmd+Shift+O / Cmd+T | Jump to a class or function by name |
| Search across files | Cmd+Shift+F | Find strings references can't: event names, config keys, SQL, templates |
| Go Back / Go Forward | Ctrl+- / Ctrl+Shift+- | Return after following a chain of definitions |

**Example: five lines removed**

The browser shows this, with a PR description that says "simplify charge":

```diff
     def charge(self, invoice: Invoice) -> Payment:
-        if invoice.status is InvoiceStatus.PAID:
-            raise InvoiceAlreadyPaid(invoice.id)
-        if invoice.total.amount_minor <= 0:
-            log.info("zero_invoice_skipped", invoice_id=invoice.id)
-            return Payment.skipped(invoice.id)
         return self._gateway.charge(invoice.customer.payment_method, invoice.total)
```

Checked out locally, the questions the diff can't answer take a minute each:

1. **Was the guard moved or dropped?** Search the branch for `InvoiceAlreadyPaid` (Cmd+Shift+F). If nothing raises it anymore, find what used to catch it; that handler is now dead code.
2. **Who relied on it?** Go to References on `charge` (Shift+F12). A retrying job that calls `charge` twice for one invoice would now charge the customer twice.
3. **What happens to zero amounts now?** Cmd+click `self._gateway.charge` through to the gateway client. If the provider rejects zero, a skip has become an error.
4. **What's left orphaned?** Go to References on `Payment.skipped`. If this was its only caller, the PR should delete it; if not, other callers still expect skips to exist.
5. **Why was it there?** Chesterton's Fence: open the file's Timeline or Git blame for the removed lines to find the commit and issue that added them.
6. **Is it tested?** Run the billing tests (`uv run pytest tests/billing`). If they still pass, the removed behavior was never tested. The comment is a `blocker`: restore the guards, or show where they now live and add a test for double payment.

**Run things, don't just read them.** Run the tests for the packages the PR touches. Start the app and call the new endpoint. Run the migration's upgrade and downgrade against a local database. Reproduce the bug the PR claims to fix, before and after. When a question is quicker to answer by trying than by asking, try it, and put what you found in the comment.

### Hand the mechanical rules to tools

A rule a linter can state is better made explicit in configuration than enforced by whoever happens to review. Linters, type checkers and formatters apply the standard the same way to everyone, and free human attention for design. If reviewers keep commenting on something a tool could catch, the config is the bug.

| Principle | What the tool catches | Python | TypeScript | Shell |
| --- | --- | --- | --- | --- |
| KISS | Functions that are too complex | Ruff `C901` | ESLint `complexity` | Keep scripts short |
| KISS | Too many branches, statements or nesting | `PLR0912`, `PLR0915` | `max-depth`, `max-statements` | n/a |
| Separation of concerns (a missing model) | Too many parameters | `PLR0913` | `max-params` | n/a |
| Least astonishment | Boolean positional parameters | `FBT001`, `FBT002` | Review by hand | n/a |
| Least astonishment | Mutable default arguments | `B006` | n/a | n/a |
| Fail fast | Swallowed errors and unhandled async failures | `E722`, `BLE001` | `no-empty`, `@typescript-eslint/no-floating-promises` | ShellCheck, `set -euo pipefail` |
| Law of Demeter | Reaching into another object's private members | `SLF001` | `private` and `#private`, enforced by `tsc` | n/a |
| Explicit over implicit | Missing or loose types | `ANN`, `mypy --strict` | `tsc --strict`, `@typescript-eslint/no-explicit-any` | n/a |
| Explicit over implicit | Unquoted expansions | n/a | n/a | ShellCheck `SC2086` |
| Idiomatic code | Non-idiomatic constructs and outdated syntax | `SIM`, `PERF`, `C4`, `PTH`, `UP` | typescript-eslint `strict-type-checked` | ShellCheck |
| Formatting | Layout and style | `ruff format` | Prettier or Biome | `shfmt` |

Leave magic-number rules (`PLR2004`, ESLint `no-magic-numbers`) off or loosely configured. They push self-explanatory literals into constants, which the next section treats as an anti-pattern. Each language's full toolchain and recommended settings are in Part 3. Some rules are preview-only or version-specific, so check them against the versions your project pins.

## 1. Simplicity and scope

The first review question is whether the change should be this big. KISS limits how complex the solution is. YAGNI limits whether it should exist at all. DRY and the Rule of Three decide when repetition should become an abstraction. Over-engineering survives review because the author can usually name a principle they were following, most often reuse or DRY, applied past the point where it helps. This section is about catching that.

### What to check

- **Is this the smallest change that solves the problem?** Ask what the dumbest working version would be, and whether each extra file, layer, type or option earns its place.
- **Does every abstraction have a current second user?** An interface with one implementation, a registry with one entry, or an option nobody sets is YAGNI.
- **Can you predict the behavior from one place?** Each indirection a reader must follow is a cost that has to buy something.
- **Is the duplication knowledge or text?** The same business rule in two places should be deduplicated. Similar-looking code that changes for different reasons should be left alone.
- **Is any optimization measured?** For a change justified by speed, ask where the benchmark is.
- **When simplifying, apply Chesterton's Fence.** Removing a strange guard or retry needs a reason, found with `git blame` and the linked issue, before it goes.

### Reuse and DRY taken too far

DRY is about knowledge: a rule that must stay consistent has one home. It is not about removing every repeated sequence of characters. The Rule of Three says to wait for the third real occurrence, because two cases can't show you the right shape of the abstraction. The anti-patterns below all come from ignoring one or both.

#### Scattering cohesive code for "reuse"

A small feature has its pieces spread across the codebase: the model in `models/`, a helper in `utils/`, a constant in `constants.py`, a type in `types.py`, a formatter in `common/`. Each piece is used in one place, plus the tests. Reviewing one method with a couple of collaborators means opening five or six files in distant corners of the repo just to learn the shape of what it calls.

It usually happens because the author wants the helper to be reusable, or needs it in both production code and tests, and assumes that means it must live somewhere shared. It breaks KISS and high cohesion at once: code that changes together should be read together, and scattering it means reviewers can't see the whole unit and maintainers miss pieces when changing it.

Keep closely related objects, functions and constants in the same module as the code that uses them. Tests import from that module directly; being used by a test is not a reason to move something to `utils`. Move code to a shared place only when a second, unrelated caller exists. In review, if understanding one function means opening more files than the diff touches, ask why each piece lives where it does.

#### Premature decomposition

A working 30-line function gets split into eight 4-line private helpers, each called once, often with names that restate their one line. The reasons given are testability or future reuse, before anyone knows whether the function will stay in the codebase at all.

This is premature optimization of structure. The reader now jumps between definitions to follow logic that used to read top to bottom, and every helper is a boundary that may be in the wrong place. Extract a piece when its name clarifies the caller, when it is used twice, or when it has real logic worth testing alone. Test the public function's behavior instead of splitting it so each fragment can be tested. A longer function that reads linearly beats a short one that reads like a table of contents.

#### Constants for self-explanatory literals

A string appears in a couple of places, so it gets assigned to a variable. It then spreads, so the variable becomes `RECTANGLE = "rectangle"` in a constants file, imported everywhere anyone wants to write the word. The imports pile up, and the reader has to resolve a name to see a value anyone could have typed.

This applies DRY to text instead of knowledge. The literal is often the clearest thing to write, especially for dictionary keys and URLs. Use a named constant when the name says something the value doesn't (`MAX_RETRIES = 5`, `SESSION_TTL = timedelta(hours=12)`), when the value is a configuration choice that may change, or when it belongs to a closed set where a typo would fail silently, in which case use an `Enum` or `Literal`.

#### Route constants instead of readable paths

Every API path is defined in `uris.py`, so `@app.post("/v1/users/client/refresh")` becomes `@app.post(V1UsersClientRefresh)`, and every test of that endpoint imports the same symbol.

The literal path is the most readable thing in the file. It tells you at a glance what the view handles, and you can pattern-match it against logs, docs, curl commands and client code. A constant replaces that with a name you must remember and import into every view and test, and the name is just a mangled copy of the path. The usual justification, "if it changes we only edit one place," saves almost nothing: a public route rarely changes, needs a deprecation plan when it does, and a project-wide search and replace handles the edit in seconds. The indirection, meanwhile, costs readability every day.

Write routes, URLs and similar identifiers inline. When code needs to build a URL, use the framework's reverse lookup (`url_for`, `request.url_for`) rather than a parallel constants file. Tests spell out the path, because that is what a client does.

#### Shared helpers that grow mode flags

Two similar call sites get merged into one helper. A third caller needs something slightly different, so the helper gains a flag, then another: `render(obj, compact=False, legacy=False, admin=None)`. The body becomes a set of `if` blocks reading the flags.

This is the wrong abstraction the Rule of Three warns about, fitted to cases that only looked alike. Each flag doubles the paths to test, and callers must know which combinations are valid. Inline the helper back into its callers, let them diverge, and extract again only what they genuinely share.

### Building for needs you don't have

These are YAGNI violations. Each adds code to read, test and keep consistent, built on guesses about the future that are usually wrong. When the real second case arrives, it rarely fits the abstraction built in advance.

- **Speculative generality.** A plugin registry with one plugin, a `BaseNotifier` ABC with only `EmailNotifier`, hooks and factories added "in case we swap it later." Write the concrete thing. A `Protocol` can be added later without touching callers.
- **Layers that only forward calls.** Controller to service to manager to repository, each passing the same arguments through. A layer earns its place by owning something: a transaction boundary, an authorization rule, a translation between models, a domain invariant. Simple CRUD can go straight from route to repository; keep command and query handlers for operations with real logic.
- **A framework built for one use.** A generic pipeline engine, a homegrown DI container or a YAML DSL serving a single feature. Use the standard library or an established dependency, or write the plain code, and revisit when three features share the shape.
- **Configuration for everything.** Every value is an environment variable, including ones that never differ between environments. Configuration has no tests or types, and each setting multiplies the states the system can be in. Make something configurable only when it actually varies between deployments.
- **The golden hammer.** Every problem gets the familiar tool: everything is a microservice, an event, a Redis key, a CQRS command. Ask what the simplest thing that fits this case would be.

## 2. Design and structure

After scope, design is the most expensive thing to get wrong, because it is the hardest to change once other code depends on it. The design principles all ask the same question from different angles: does each piece have one job, know as little as possible about the others, and offer a contract that a second implementation could satisfy? When new objects, classes or hierarchies appear, review the shape of the model before the code inside it.

### Separation of concerns and the domain model

Each part of the system handles one concern: transport, domain logic, or persistence. Within the domain, the types should come from the problem being solved, not from the database schema or the wire format. A model that mirrors tables leaks storage concerns into every caller.

- **Layer-crossing imports.** SQL or ORM sessions in route handlers, HTTP request types in domain services, settings imported directly by domain code.
- **Construction.** An object is valid as soon as `__init__` returns, with no separate `init()` or `connect()` step. `__init__` does no I/O. Alternate ways to build go in classmethods (`from_row`, `from_env`). Collaborators are passed in, not built inside, because collaborators built internally are hidden dependencies. Lifecycles of connections, sessions and file handles are expressed with context managers, not convention.
- **A missing model.** The most common design finding. Signs:
  - The same three or four parameters travel together through several functions.
  - A `dict` or tuple with an agreed set of keys or positions.
  - A `str` or `int` that carries meaning (`status: str`, or `amount: int` with its currency held somewhere else).
  - The same validation repeated at several call sites.
  - Functions sharing a name prefix (`order_total`, `order_discount`, `order_validate`) that want to be methods on a type.

```python
def apply_discount(amount: int, currency: str, code: str | None) -> int: ...
def format_price(amount: int, currency: str) -> str: ...
```

wants to be:

```python
@dataclass(frozen=True, slots=True)
class Money:
    amount_minor: int
    currency: str

    def apply(self, discount: Discount) -> Self: ...
    def format(self) -> str: ...
```

In TypeScript, the same model is a readonly type with functions that operate on it, or a small class when it has invariants to protect:

```typescript
type Money = Readonly<{ amountMinor: bigint; currency: CurrencyCode }>;

declare function applyDiscount(price: Money, discount: Discount): Money;
declare function formatMoney(price: Money): string;
```

#### Constructors that take too many arguments

The missing model shows up most clearly in constructors. Ten arguments, seven of which are single facets of one thing (`customer_name`, `customer_email`, `customer_street`, and so on), and none of them thought through as a group: which are required, which belong together, which are really configuration. A shared prefix on parameter names is the giveaway. Callers must remember order and meaning, adding a field touches every call site, and validation of the group is repeated or missing.

Group the related arguments into an object and pass that object around instead. A frozen dataclass, or a Pydantic model when the data needs validating, is usually right. Check that the grouping is cohesive: a catch-all `Options` or `Config` holding unrelated settings is the same smell under a new name. Put optional behavior after a `*` so it is keyword-only.

```python
class Invoice:
    def __init__(
        self,
        customer_name: str,
        customer_email: str,
        customer_street: str,
        customer_city: str,
        customer_postal_code: str,
        customer_country: str,
        items: Sequence[LineItem],
        currency: str,
        due_date: date,
        notes: str | None = None,
    ) -> None: ...
```

becomes:

```python
@dataclass(frozen=True, slots=True)
class Address:
    street: str
    city: str
    postal_code: str
    country: str


@dataclass(frozen=True, slots=True)
class Customer:
    name: str
    email: str
    address: Address


class Invoice:
    def __init__(
        self,
        customer: Customer,
        items: Sequence[LineItem],
        due_date: date,
        *,
        notes: str | None = None,
    ) -> None: ...
```

The currency now travels inside each line item's `Money`, so it can no longer disagree with the amounts.

### Single responsibility and cohesion

Things that change together live together, and a class should be describable in one sentence without "and". Low cohesion looks like this:

- **God classes.** Dozens of methods and fields, a name ending in `Manager`, `Service` or `Processor`, touched by unrelated tickets.
- **Dumping-ground modules.** `utils.py`, `helpers.py`, `common.py`. A name that says nothing about purpose means there is no single reason for the module to change.
- **Split personalities.** One group of methods uses one subset of the fields and another group uses the rest. That is two classes.
- **Shotgun surgery and divergent change.** One conceptual change edits many files, or one file is edited for many unrelated reasons.

The boundaries between the parts of a composite matter as much as the composition itself. Sometimes an argument, property or field on one object belongs on another:

- A field that is `None` or unused for many instances belongs to a variant or a different object.
- Fields that always change together belong together in their own part.
- A method that mostly reads another object's attributes (feature envy) should move to that object.
- Data with a different lifecycle, rate of change or owner belongs elsewhere. Subscription state on `User`, or carrier credentials on `Order`, are typical.
- Two objects holding the same fact will drift apart. Pick one owner.

A useful question: if this field changed, which other fields would have to change with it, and which object owns the rule that connects them?

### Coupling: Law of Demeter and Tell, Don't Ask

Things that don't change together shouldn't know about each other. The Law of Demeter limits how much one object knows about another's structure, and Tell, Don't Ask keeps decisions with the object that owns the data. Check which objects know about which, and whether the arrows point the way the architecture says they should.

- **Reach-through chains.** `order.customer.address.city` couples the caller to the whole object graph. Expose `order.shipping_city`, or pass in what's needed.
- **Decisions made outside the owner.** `if account.balance >= amt: account.balance -= amt` in a caller belongs inside `account.withdraw(amt)`, where the invariant lives. If three call sites each check `if order.items:` before calling a method, the method should own that check.
- **Direction and cycles.** Lower-level modules don't import higher-level ones. An import inside a function, or a `TYPE_CHECKING` guard added only to dodge a circular import, hides the cycle without removing it.
- **Temporal coupling.** If method A must be called before method B, the type is hiding a state machine. Make the wrong order impossible: build the valid object in one step, or have A return a new type that has B.
- **Hidden dependencies.** Singletons, module-level mutable state, and a settings object imported directly by domain code. Work at import time (opening connections, reading the environment, registering handlers) is the same problem.
- **Encapsulation.** Everything public is a promise. Default to private (`_name`) and make the author justify each exposure. Attributes that carry an invariant should be changed through a method that enforces it. Don't return internal mutable collections; return a tuple, a copy, or a read-only `Sequence` or `Mapping`. Freeze value objects so equality and hashing stay stable. Keep `__all__` or the package `__init__` in step with the intended surface.

A practical measure: if testing a unit means patching five things, it is coupled to five things.

### Abstractions: dependency inversion and interface segregation

High-level policy should depend on abstractions it owns, and each consumer should depend only on the methods it uses. In Python that means small `Protocol`s defined by the code that consumes them. Reach for an ABC only when you need shared implementation or enforcement at instantiation.

```python
class UserRepository(Protocol):
    async def get(self, user_id: UserId) -> User | None: ...
    async def add(self, user: User) -> None: ...
```

TypeScript interfaces are structural already, so the consumer declares the shape it needs and any implementation that fits satisfies it, with or without `implements`:

```typescript
interface UserRepository {
  get(userId: UserId): Promise<User | null>;
  add(user: User): Promise<void>;
}
```

- **Leaky or sound.** An abstraction leaks when callers must know what's behind it. The test: could you write a second, different implementation without changing the interface or any caller? A repository exposing `get_session() -> AsyncSession` fails it, because every caller now depends on SQLAlchemy. Other leaks are vendor-specific exceptions, required call orders, and parameter names that mention the backend.
- **Fat interfaces.** Implementers stubbing out half the methods, and test doubles needing many attributes, mean the interface should be split.
- **Earned, not speculative.** YAGNI applies here too. An interface with one implementation, no test double and no second consumer is usually ceremony.
- **The missing abstraction.** The opposite failure: callers import a concrete vendor client and use five of its methods directly, so changing vendors touches every file.

### Composition over inheritance and Liskov substitution

Inheritance is the tightest coupling Python offers: a subclass depends on its parent's internals. Assemble behavior from injected collaborators instead, and keep inheritance for true is-a relationships with a base designed for extension, and for framework extension points such as exceptions, `Enum` and Pydantic models.

Signs inheritance is being used for code reuse:

- A subclass created to borrow methods rather than because it is a kind of its parent.
- Overrides that do nothing or raise `NotImplementedError` to switch off inherited behavior. This also breaks Liskov substitution: the subclass can't be used everywhere the base can.
- Callers checking `isinstance` to find out which subclass they were given.
- Names that stack behaviors (`RetryingLoggingEmailSender`), mixins that depend on attributes defined elsewhere, and behavior that depends on MRO order or when `super().__init__()` runs.
- Hierarchies deeper than two levels.

```python
class RetryingClient(HttpClient):
    def get(self, url: str) -> Response:
        for _ in range(3):
            try:
                return super().get(url)
            except TransportError:
                continue
        raise RetriesExhausted(url)
```

The composed version retries any client, including a fake in tests, and the retry policy becomes data:

```python
class RetryingClient:
    def __init__(self, inner: HttpClient, policy: RetryPolicy) -> None: ...

    def get(self, url: str) -> Response: ...
```

### Polymorphism: open/closed and explicit contracts

The open/closed principle says the next variant should be added, not edited in. Implicit polymorphism is the usual obstacle: different objects treated alike because they happen to share method names, or code that branches on what kind of thing it received. Explicit polymorphism names the contract, so both the type checker and the reader can see it.

Look for:

- `isinstance` ladders, or `if kind == "email"` branches on a string tag.
- `hasattr(obj, "send")` or `getattr(obj, "send", None)` probing for a capability.
- Several classes with the same method names and no declared shared contract.
- A parameter typed as a union of concrete classes, with the same branching repeated at more than one call site.
- A dict of callables keyed by a string that mirrors a type name.

```python
def notify(target: Email | Sms | Webhook, body: str) -> None:
    if isinstance(target, Email):
        smtp.send(target.address, body)
    elif isinstance(target, Sms):
        sms.send(target.number, body)
    else:
        http.post(target.url, json={"body": body})
```

becomes:

```python
class Channel(Protocol):
    def send(self, body: str) -> None: ...


def notify(channel: Channel, body: str) -> None:
    channel.send(body)
```

The two explicit forms trade off differently, so pick deliberately:

- **A `Protocol` or ABC** keeps the set of types open and the operations closed. A new channel touches no existing code; a new operation touches every channel.
- **A closed union with `match`**, using `assert_never` in the default branch, keeps the types closed and the operations open. A new operation is one function; a new variant is a type error everywhere it isn't handled. This fits a fixed, domain-defined set of variants.

In TypeScript, the open form is an interface like `Channel`. The closed form is a discriminated union with an exhaustive `switch`; assigning the leftover case to `never` makes the build fail when a variant is added and not handled:

```typescript
type Target =
  | { kind: "email"; address: string }
  | { kind: "sms"; number: string }
  | { kind: "webhook"; url: string };

function describe(target: Target): string {
  switch (target.kind) {
    case "email":
      return `email to ${target.address}`;
    case "sms":
      return `text to ${target.number}`;
    case "webhook":
      return `POST to ${target.url}`;
    default: {
      const unhandled: never = target;
      return unhandled;
    }
  }
}
```

Implicit is fine for two classes in one module with nothing crossing a boundary. Make it explicit when it crosses a module boundary, when a third implementer appears, or when the same branching shows up a second time.

### Signatures and command-query separation

The signature is the part of the design every caller sees, so read each one as if you had never seen the body. Command-query separation is the first test: a method either changes state or returns data, not both, and its name says which. A `get_*` with a side effect is a finding.

| Element | What to check |
| --- | --- |
| Constructors | Only what's needed to be valid; no I/O; dependencies injected; alternate constructors as classmethods. A long list of optional parameters means a missing model. |
| Methods | Commands return nothing meaningful, queries don't mutate. A boolean flag that switches behavior becomes two methods or an enum. |
| Functions | Pure where possible and obviously impure where not. Parameters ordered from most to least significant, with `*` before the options so they're keyword-only. |
| Parameter types | The narrowest type that works: a `Protocol`, `Sequence` or `Mapping` rather than `list` or `dict`. Passing a whole object when one field is used couples the function to that object. |
| Returns | One consistent type per function. `X \| None` and raising are both fine when chosen deliberately to match the codebase. A tuple of differing meanings is a named type waiting to happen. |
| Types | No `Any` without a reason. Every `# type: ignore` explains itself. `*args` and `**kwargs` pass-throughs hide the real contract. Private methods are annotated too. |

### Complexity in both directions

KISS catches designs that are too elaborate. Tell, Don't Ask and cohesion catch designs that are too thin. Reviewers tend to notice only the first.

- **Too complex.** A base class that exists to share three lines. Metaclasses, descriptors or dynamic attribute magic without a concrete need. A constructor with many parameters. Mode flags that turn one class into several.
- **Too simple.** Anemic models: data bags with all the logic in a separate service, so invariants live nowhere. Wrapper classes that only forward calls. A class with `__init__` and one method, which should be a function. Plain `dict` where a `TypedDict`, dataclass or model would make the shape checkable.

## 3. Correctness and safety

Fail Fast and Parse, Don't Validate together say where errors belong: caught once, at the boundary, as early as possible, and then never checked again inside. Least privilege limits the damage when something goes wrong anyway, and explicit is better than implicit keeps I/O and concurrency where a reader can see them. Hyrum's Law reminds the reviewer that "correct" includes not breaking whoever already depends on the current behavior.

### Parse at the boundary, trust the types inside

Untrusted input (request bodies, headers, queue messages, files, environment) is converted at the edge into a type that can only hold valid values. After that, the code relies on the type instead of re-checking.

- **Raw data travelling inward.** `dict[str, Any]` passed through several layers, or the same validation repeated at several call sites.
- **Primitive obsession and stringly typed values.** `str` or `int` standing in for emails, ids, money, durations or states. Use value types (`NewType` or a frozen dataclass) and `StrEnum` or `Literal` for closed sets, so illegal states can't be represented.
- **Defensive checks everywhere.** `if x is not None` on values the type already says can't be `None`, every function re-validating its inputs, or `try`/`except Exception` around code that can't reasonably fail. The noise hides the checks that matter. Validate once at the boundary and trust the types after that.
- **`assert` used for validation.** Asserts are stripped under `-O`. Use `assert` only for internal invariants that can't happen, and `raise` for anything that must hold in production.

In TypeScript the same pattern is a zod (or Valibot) schema parsed at the edge, with data typed `unknown` until then, branded types for ids, and string literal unions for closed sets. A cast such as `JSON.parse(body) as Order` is validation skipped, not done. In shell, arguments and required environment variables are checked at the top of the script, with a usage message and a non-zero exit.

### Fail fast on every path

Check the code against the description, then against the inputs the author didn't think about. Trace one realistic input end to end, including what happens to the data after it leaves this code.

- **Boundaries.** Empty collections, single items, `None`, zero, negatives, very large inputs, duplicate keys, unicode, timezone-naive datetimes, and off-by-one at range ends.
- **Every call that can fail.** Network, disk, parsing, database. Handle the failure where something sensible can be done; otherwise let it propagate to a handler that logs it.
- **Swallowed errors.** No bare `except:` or broad `except Exception:` returning a default. Catch narrowly, translate with `raise ... from err`, and log once at the boundary, not at every layer. A silent fallback turns a crash into a wrong result that is far harder to debug.
- **Absence vs. failure.** Return `X | None` when absence is a normal outcome, and raise a specific, domain-named exception when the caller can't proceed. Don't use exceptions for ordinary branching, don't return Go-style `(ok, error)` tuples, and don't return `None` for both "not found" and "failed".
- **Partial failure.** If step three of five fails, what state is left behind? Look for missing transactions, retries that aren't idempotent, and cleanup that runs only on the happy path. Resources are released on every path via `with` or `async with`.
- **Hidden inputs.** `datetime.now()` or `random` called inside logic makes behavior untestable. Pass in a clock or a seed. Datetimes are timezone-aware, in UTC.

The same rules in TypeScript: no empty `catch`, errors narrowed from `unknown` before use, the original kept with `new Error(message, { cause })`, and no floating promises, since an unawaited rejection fails silently. In shell: strict mode, an explicit check after any command whose failure `set -e` won't catch, and a `trap` for cleanup on every exit path.

### Concurrency and I/O, made explicit

Concurrency bugs are the hardest to reproduce, so look for them on paper. The common thread is implicit behavior: I/O, blocking or shared state that the reader can't see at the call site.

- **Match the codebase.** Don't introduce async into a synchronous path, or the reverse, without a reason. In async code, a blocking call stalls the whole event loop: in Python, a sync HTTP client or DB driver, `time.sleep` or heavy CPU work (use an async library or `asyncio.to_thread`); in Node, synchronous `fs` calls or a CPU-bound loop (use the async API or a worker thread).
- **Every async operation is awaited or deliberately scheduled.** Fire-and-forget tasks keep a reference and have their errors observed: `TaskGroup` in Python, an awaited `Promise.all` or an explicit `.catch` in TypeScript. Independent awaits that could run concurrently aren't run in sequence by accident.
- **Timeouts and cancellation.** Every outbound call has a timeout (`asyncio.timeout`, `AbortSignal.timeout`), and cancellation doesn't leave resources open or work half-done.
- **Shared mutable state.** What is mutated, by whom, under what lock or ownership rule? Module-level caches, class attributes and mutable defaults are the usual culprits.
- **Database races.** A read-modify-write in application code (read the balance, subtract, save) loses updates when two requests run at once. Use an atomic `UPDATE ... SET balance = balance - :amount`, `SELECT ... FOR UPDATE`, or optimistic locking with a version column. "Check, then insert" without a unique constraint creates duplicates; let the constraint reject them and handle the error.
- **Implicit queries.** Lazy loading under async SQLAlchemy either raises `MissingGreenlet` or hides an N+1 query; in Prisma or Drizzle, a relation fetched per row inside a loop does the same. Load explicitly, and keep slow or non-transactional calls out of open transactions.
- **Idempotency.** Anything that can be retried, such as queue consumers, webhooks and client retries, is safe to run twice.
- **I/O at the edges.** Domain logic that opens its own connections or reads environment variables directly is hard to test. Configuration arrives through one typed, validated settings object (`pydantic-settings`, or a zod schema over `process.env`), checked at startup.

### Data models that can't hold illegal states

Parse, Don't Validate applies to the schema as well as to request bodies. Column types, constraints and relationship shapes should make an illegal row impossible, whichever code path writes it, so an invariant enforced only in Python is a finding. The data modeling, queries and migrations playbooks in section 5 cover how to review each in detail.

### Least privilege and trust boundaries

- **Injection.** SQL built from strings, shell commands with interpolated input, templates rendering unescaped input, and deserialization of untrusted data (`pickle`, unsafe YAML).
- **Scope.** API tokens limited to what the code needs, read-only database roles for query paths, a service account per service, and no god-object `Context` that grants access to everything.
- **Secrets and personal data.** None in code, logs, error messages or fixtures. Logs carry ids, not payloads or tokens.
- **Dependencies.** A new package runs with your application's privileges, so it is a security decision as much as a design one.
- **Deeper passes.** Input validation, authentication and authorization, configuration, and new dependencies each have a playbook in section 5.

### Compatibility: Hyrum's Law

Once behavior is observable, someone depends on it. Treat these as contract changes even when the diff looks harmless:

- **Contracts.** Endpoint schemas, event payloads, public function signatures, config keys and database columns. Old callers and old data keep working during a rolling deploy. The schema-change, migrations and background-jobs playbooks give the mechanics.
- **Behavior that isn't in any schema.** Output ordering, default values, error message text, status codes and timing on widely used interfaces.
- **Libraries.** In a package others import, anything public by naming is public in practice. Deprecate with `warnings.warn(..., DeprecationWarning, stacklevel=2)` for at least one release before removing.

Risky changes go behind a flag, and rollback stays possible.

### Performance and observability

Knuth's rule cuts both ways in review. Ask for a measurement before accepting an optimization that costs readability, and still flag work clearly in the wrong place: queries in loops, unbounded result sets without pagination, repeated parsing, large objects held in memory. Fail Fast extends to production too: failures produce a log line or metric someone will see, with enough structured context to diagnose without a debugger.

## 4. Readability and review

The principle of least astonishment is readability in one line: code should behave the way its name and shape suggest. In practice that means writing the idiom a developer in that language expects, keeping behavior visible at the call site, and treating tests as the executable statement of intent. The same principles then govern how the review itself is written.

### Least astonishment

A surprised reviewer is a finding. Say what you expected and why, since the next reader will expect the same thing.

- **Names carry the domain.** A reader should know what a variable holds from its name and type together. Be suspicious of `data`, `result`, `info`, `handle`, `process` and `do_` prefixes.
- **Behavior matches the name.** `get_user` doesn't create a user. A `@property` is cheap and side-effect free; anything that does I/O or can fail is a method.
- **One return type per function.** Not a `str`, a `list` or `None` depending on the input, and not a `None` that means several different things.
- **No boolean traps.** `send(msg, True, False)` tells the reader nothing. Use keyword-only parameters, an enum, or two functions.
- **One level of abstraction per function.** Don't mix high-level steps with byte-level detail. Flatten deep nesting with guard clauses and early returns, and keep cyclomatic complexity at roughly ten or below.
- **Comments explain why, not what.** A comment that restates the code is noise; one that records a constraint, a workaround or a non-obvious decision is valuable. If code needs a comment to be understood, a better name or a smaller function usually fixes it. Commented-out code goes; version control remembers it.
- **Docstrings describe the contract** of public APIs: what it promises, raises and assumes, without repeating the type hints.

The best overall test is to use the package as an unfamiliar developer:

- Can I find the entry point from the layout and `__init__`?
- Can I make a first correct call from names, types and docstrings alone, without reading the source?
- Do similar things behave similarly: naming, argument order, return types, errors?
- Is there a required call order, hidden side effect or surprising default?
- Is there one obvious way to do each thing?
- Do error messages say what went wrong and what to do next?

When unsure, ask for a short usage example. If it is awkward to write, the API is awkward to use.

### Explicit over implicit

Behavior should be visible where it happens, not produced by machinery somewhere else.

- **Dynamic access and patching.** In Python, `getattr`, `setattr`, `__dict__`, `eval` and monkey-patching in production code; in TypeScript, index access by computed string keys on objects that should have a known shape, and modifying prototypes; in shell, `eval` and indirect expansion. Use explicit attributes or a dispatch table.
- **Global registries and import-time side effects** instead of explicit dependency injection.
- **Loose types.** `Any`, `cast` and unexplained `# type: ignore` in Python; `any`, `as` casts, non-null `!` and `@ts-ignore` in TypeScript. Each hides the contract from both the reader and the checker.
- **Implicit polymorphism** crossing a boundary. See the design section for when to make it explicit.

### Idiomatic code

Idioms reduce astonishment because they are what a reader of that language expects to see. Every language offers several ways to do any one thing; some are idiomatic and some are transliterated from another language. Flag code that works but fights its language, such as Java-style getters in Python, `any` and enums in TypeScript, or unquoted variables in shell.

When several idioms are acceptable, the one chosen should reflect how the behavior is meant to be used. A construct picked against its intent tells the reader something false: a list used for membership tests, a property that queries the database, a mutable type for a value that never changes.

Idioms can also be overdone. A comprehension or a chain of array methods stops being idiomatic once it needs re-reading, and a plain loop is clearer.

The idiom tables for each language, including which construct fits which intent, are in Part 3.

### Tests: make it work, provably

Beck's "make it work" means a test proves the behavior before anything is refactored or tuned. Tests are also the most precise statement of intent in the diff, so a reader should be able to learn what the code promises from them alone. Three questions apply to every test:

- **Would it fail if the behavior broke?** A passing suite only proves the tests pass.
- **Does it test behavior, not implementation?** Assertions on private calls and mock interactions break on every refactor and pass when behavior is wrong. Heavy patching of your own modules is a coupling finding, not a testing technique.
- **Is it obviously correct?** Test code has no logic of its own to get wrong, and its expected values are literals.

The two test playbooks in section 5 cover test levels, coverage, TDD, fixtures and helpers.

### Writing the review

The principles apply to the comments too. Keep feedback simple and unambiguous, respect what you don't yet understand, and improve the code without holding it hostage.

Label every comment, so the author knows at once what blocks the merge:

| Label | Meaning | Blocks merge |
| --- | --- | --- |
| `blocker` | Bug, security issue, broken contract, or a design problem that will be expensive later | Yes |
| `issue` | Real problem; expect a fix or a good reason not to | Usually |
| `suggestion` | A better approach, with the reasoning. The author decides. | No |
| `question` | You don't understand something; it may reveal a bug or a missing explanation | Until answered |
| `nit` | Minor preference; skip it if a linter could enforce it | No |
| `praise` | Something done well, so the author keeps doing it | No |

- **Chesterton's Fence applies to your own suggestions.** Ask before asserting when you may lack context: "What happens if `items` is empty here?" lands better than "This breaks on empty input," and is right more often.
- **Name the principle and the cost.** "This couples billing to the HTTP client, so changing vendors touches every call site" is actionable; "too coupled" is not.
- **Offer a concrete alternative** for design comments, ideally a short snippet.
- **Critique the code, not the person.** Say "this function" and "we", not "you".
- **Group findings.** One comment on a pattern with the other occurrences listed, not the same remark eight times.
- **Take design disagreements out of the thread.** A short call settles in minutes what a comment chain can't in days. Conway's Law is a hint here: disputes about where a boundary goes are often about which team owns it, so involve the owners.
- **Approve improvements, not perfection.** Approve when the change makes the codebase better and has no open blockers, even if you'd have written it differently. Request changes only for blockers and issues, and say which ones. Cleanups the Boy Scout Rule suggests can become a follow-up ticket.
- **Respond promptly.** A review within a few hours is worth more than a more thorough one a day later.

Authors apply the same principles before asking for review: re-read your own diff, keep the change small, write a description that states intent and what you chose not to do, and point reviewers at the parts you're least sure about.

### Worked example

A PR adds refunds: `POST /v1/orders/{order_id}/refunds`, a `refunds` table and its migration. The linked spec says support staff can issue full or partial refunds, never more than was paid, with an audit trail of who refunded what and why. An abridged excerpt:

```python
@router.post("/v1/orders/{order_id}/refunds", status_code=201)
async def create_refund(
    order_id: int,
    body: dict,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(current_user),
) -> dict:
    order = await session.get(Order, order_id)
    if body["amount"] > order.total - order.refunded_total:
        raise HTTPException(400, "too much")
    refund = Refund(
        order_id=order_id,
        amount=body["amount"],
        reason=body.get("reason"),
        notify_customer=body.get("notify_customer", True),
    )
    session.add(refund)
    order.refunded_total += body["amount"]
    await session.commit()
    await payments.refund(order.payment_id, body["amount"])
    return refund.__dict__
```

```python
def upgrade() -> None:
    op.create_table(
        "refunds",
        sa.Column("id", sa.BigInteger, primary_key=True),
        sa.Column("order_id", sa.BigInteger, sa.ForeignKey("orders.id")),
        sa.Column("amount", sa.Float, nullable=False),
        sa.Column("reason", sa.Text),
        sa.Column("notify_customer", sa.Boolean),
        sa.Column("created_at", sa.DateTime),
    )
```

The review follows the guide's order: intent, scope and design, then correctness, then the rest. It opens with a summary, so the author knows what matters before reading individual comments.

**Summary comment**

> The happy path matches the spec, and the migration being its own commit made this easy to follow. Three blockers before this can merge: there's no authorization check, money is stored as a float, and the payment call runs after the commit, so a gateway failure leaves a refund recorded that never happened. Two spec gaps (audit trail, input validation) are marked `issue`. The `notify_customer` question is about scope. Happy to pair on the transaction part.

**Line comments**

- `blocker` on `user: User = Depends(current_user)`: Any logged-in user can refund any order. The spec limits refunds to support staff, and the order lookup isn't scoped to the caller's tenant. Suggest `Depends(require_role(Role.SUPPORT))` and a tenant-scoped query, plus tests for a customer, a support user from another tenant, and an anonymous caller.
- `blocker` on `order.refunded_total += ...` through `payments.refund(...)`: If the gateway call fails, the database already says the order was refunded. Two concurrent refunds can also both pass the limit check, because the read-modify-write isn't atomic. Suggest: accept an `Idempotency-Key` header and store it on the refund under a unique constraint, so a client or proxy retry returns the existing refund instead of creating a second one. Then reserve the amount in one transaction, inserting the refund as `pending` and applying the total with a guarded update (`UPDATE orders SET refunded_total = refunded_total + :amount WHERE id = :id AND refunded_total + :amount <= total`), and stop if no row was updated. Only then call the gateway, with an idempotency key derived from that stored refund. On success mark the refund `succeeded` and record the gateway's refund id; on a definite failure mark it `failed` and release the reservation; on an uncertain outcome such as a timeout, leave it `pending` and resolve it later by retrying the gateway call with the same idempotency key, which returns the original result instead of refunding twice.
- `blocker` on `sa.Column("amount", sa.Float, ...)`: Money as a float will accumulate rounding errors. `orders.total` uses `Numeric(12, 2)`; this column should match.
- `issue` on `body: dict`: A missing `amount` raises `KeyError` and returns a 500, and a negative amount passes the limit check. Suggest a `RefundRequest` model with a positive `Money` amount, a length-limited `reason`, and `extra="forbid"`.
- `issue` on `await session.get(Order, order_id)`: A missing order raises `AttributeError` on the next line. Return a 404 (or 404 for other tenants' orders too, so ids can't be probed).
- `issue` on the migration's `order_id` and `created_at`: `order_id` should be `nullable=False` and indexed, since PostgreSQL doesn't index the referencing side and every "refunds for this order" query will scan. `created_at` should be `DateTime(timezone=True)` with `server_default=sa.func.now()`.
- `issue` on the PR as a whole: The spec requires an audit trail of who issued each refund and why. I can't find one in the diff. A non-null `created_by` column and a required `reason` would cover it.
- `question` on `notify_customer`: The spec doesn't mention customer notifications. Is this needed for this release? If not, please leave it for a separate PR so this one matches the spec, no more and no less.
- `issue` on `return refund.__dict__`: This exposes every column plus SQLAlchemy's internal `_sa_instance_state`. Suggest a `RefundResponse` model declared as the route's `response_model`.
- `praise` on the migration's `downgrade`: Clean and complete, thanks.

**Verdict:** Request changes, naming the three blockers and the five issues as required. Everything else is the author's call.

Notice what the review doesn't contain: no comments on formatting or import order (the linter owns those), no rewrite of working code into the reviewer's style, and nothing about lines the PR didn't change.

## 5. Playbooks for specific kinds of change

Sections 1 to 4 apply to every diff. Some kinds of change also have their own failure modes and get a dedicated pass, using the playbooks in Part 2. They cover intent (code against its spec, design specs and plans), APIs (endpoints, schema changes and versioning, input validation, authentication and authorization), frontend (React components, Next.js, accessibility, CSS, HTML artifacts), data (modeling, queries and indexes, SQL files, migrations), runtime (the critical path, background jobs and events, logging), infrastructure (shell scripts, Dockerfiles, infrastructure as code, configuration), tests (levels, coverage and TDD, test code itself), supporting changes (documentation and Markdown, new dependencies), and agent and AI tooling (LLM prompts, skills and instruction files, rules files and subagents, hooks and commands, agent workflows, AI-generated code). Part 2 opens with an index of which playbook to use when. Use every playbook that matches the diff, on top of the general review.

## Checklist

The short version, in the same four groups and in review order.

**Simplicity and scope** (KISS, YAGNI, DRY, Rule of Three, Gall's Law)

- [ ] I can state the intent in one sentence, and the change implements its spec: every requirement covered, nothing extra.
- [ ] CI is green, the change is small enough to review, and mechanical edits are in separate commits.
- [ ] Every abstraction, layer, option and hook has a current user.
- [ ] Related code lives together; nothing moved to `utils` or a constants file only for reuse.
- [ ] Deduplication targets shared knowledge, readable literals stay literal, and no shared helper carries mode flags.
- [ ] Any optimization comes with a measurement.

**Design and structure** (SOLID, separation of concerns, cohesion and coupling, Demeter, Tell Don't Ask, composition, CQS)

- [ ] Each layer handles one concern, and the model comes from the domain, not the schema.
- [ ] No missing model is hiding in an argument cluster, a dict, or a meaningful primitive.
- [ ] Objects are valid once constructed, with collaborators injected.
- [ ] Dependencies point the right way, with no cycles and no reach-through chains.
- [ ] Objects enforce their own invariants, and the public surface is minimal.
- [ ] Interfaces are narrow, owned by their consumers, and don't leak.
- [ ] Inheritance is a true is-a, and subclasses substitute cleanly.
- [ ] Branching on type or tag that crosses a boundary is an explicit contract.
- [ ] Each method is a command or a query, and signatures are narrow and typed.

**Correctness and safety** (Fail Fast, Parse Don't Validate, least privilege, explicit over implicit, Hyrum's Law)

- [ ] Input is parsed into typed models at the boundary and trusted inside.
- [ ] Edge cases, failure paths and partial failure are handled; exceptions are caught narrowly.
- [ ] Async code doesn't block, tasks are owned, outbound calls have timeouts, and retries are idempotent.
- [ ] Concurrent writes can't lose updates or create duplicates.
- [ ] Schema types and relationship shapes match the data and its dominant queries.
- [ ] Access is scoped, and no secrets reach code or logs.
- [ ] Changes to observable behavior are intended and backward compatible.

**Readability and review** (least astonishment, explicit over implicit, Chesterton's Fence, Boy Scout Rule)

- [ ] Names and behavior match, and a newcomer could use the API from its signatures.
- [ ] The code is idiomatic for its language, with constructs chosen to fit the intended use.
- [ ] The tests would fail if the behavior broke.
- [ ] Docs, config and migrations changed along with the code that needs them.
- [ ] I've used the section 5 playbook for each kind of change in the diff.
- [ ] I know why anything I'm suggesting to remove was there.
- [ ] Every comment is labeled, and I've said which ones block.

## Appendix: pull request description template

Authors fill this in; reviewers use it as the map for the review. Delete the sections that don't apply. The requirements table is what makes reviewing against the spec quick.

```markdown
## What and why

One or two sentences: the problem, and how this change solves it.

Spec / ticket: <link>

## Requirements → implementation → tests

| Requirement (from the spec) | Where it's implemented | Test that proves it |
| --- | --- | --- |
| Support staff can refund up to the amount paid | `refunds/service.py::issue_refund` | `tests/refunds/test_service.py::test_refund_capped_at_paid` |

## Out of scope

What this PR deliberately doesn't do, and where that work is tracked.

## Public surface changes

New or changed endpoints, schemas, events, config keys and CLI flags.
Breaking change: no / yes (plan: ...)

## Data and migrations

Step: expand / backfill / read new / contract
Runtime and locks on production-sized data:
Rollback:

## Rollout

Feature flag, metrics to watch, and how to turn it off.

## How to review

Where to start, what I'm least sure about, and how to run it locally.

## Checklist

- [ ] Tests added or updated, and they fail without this change
- [ ] Docs and config updated
- [ ] New dependencies justified above, or none added
- [ ] Written with AI assistance: yes / no (I've reviewed every line)
```

---

# Part 2: Code Review Playbooks

These playbooks are the companion to the code review guide in Part 1. The guide's principles and its four groups apply to every diff; some kinds of change also have their own failure modes and deserve a dedicated pass. Each playbook names the principles it leans on most, then lists what to check. Use every playbook that matches the diff: a pull request that adds an endpoint, a table and a migration gets three passes on top of the general review.

| Group | Playbooks | Use when the diff |
| --- | --- | --- |
| Intent | Reviewing code against its spec · Design specs and plans | Implements a spec, plan or ticket (nearly always), or is itself a spec |
| APIs | New API endpoints · Endpoint schema changes, versioning and deprecation · Code that validates user input · Authentication and authorization | Adds or changes an endpoint, a request or response model, a validator, or anything touching identity and permissions |
| Frontend | React components (JSX and TSX) · Next.js · Accessibility · CSS and styling · HTML artifacts | Adds or changes UI components, pages, styles, or standalone HTML files |
| Data | Data modeling · Queries and indexes · SQL files and raw queries · Migrations and deployment sequencing | Adds or changes tables, ORM models, queries, `.sql` files, indexes or migrations |
| Runtime | Code on the critical path · Background jobs, queues and events · Logging and error logging | Touches a hot or business-critical path, asynchronous work, or what gets logged |
| Infrastructure | Shell scripts (Bash and zsh) · Dockerfiles and container images · Infrastructure as code · Configuration files | Changes scripts, container images, Terraform, Kubernetes, Compose, CI or application config |
| Tests | Tests: levels, coverage, gaps and TDD · Test code itself | Adds or changes tests, fixtures or test helpers |
| Supporting changes | Documentation and Markdown · New dependencies | Changes docs or Markdown files, `package.json`, `pyproject.toml` or a lockfile |
| Agent and AI tooling | LLM prompts · Skills and instruction files · Agent rules files and subagents · Hooks and commands · Agent workflows · AI-generated and AI-assisted code | Changes prompts, `SKILL.md` files, `AGENTS.md` or `CLAUDE.md`, subagent definitions, hooks, commands or agent orchestration, or was largely written with an AI tool |

## Reviewing code against its spec

*Leans on: YAGNI and KISS (no more), Fail Fast (no less), Chesterton's Fence, least astonishment.*

The diff shows what was built; the spec, plan, ticket or design doc shows what was meant. A review without the spec can check that code is well written, but not that it is the right code. The standard is that what was specified is what was written: no more and no less.

**Use the spec to understand the code**

- **Read it before the diff.** The PR description should link the spec, ADR, design doc or ticket. If it doesn't, ask for it before reviewing in depth. Code with no stated intent can only be reviewed for style.
- **Learn the vocabulary.** Domain terms, states and rules in the spec should appear in the code as names, types and transitions. When the code uses different words for the same thing, that is a least-astonishment finding and often a sign of a misunderstanding.
- **Find the intended use.** The spec says who calls this, how often, with what data, and what matters most. That decides which review concerns dominate: an internal batch job and a public endpoint deserve different scrutiny.
- **Find what was deliberately left out.** Non-goals and out-of-scope sections matter as much as requirements. They tell you which missing features are not gaps.

**Check conformance: no less**

- **Trace each requirement.** Go through the spec's requirements or acceptance criteria and find, for each, the code that implements it and the test that proves it. The requirements table in the guide's PR description template makes this quick for both author and reviewer.
- **Edge cases and errors the spec names.** Specs often state behavior for invalid input, limits, permissions and failure. These are the easiest parts to skip in implementation.
- **Non-functional requirements.** Latency targets, data retention, audit logging, rate limits and access rules are requirements too.

**Check conformance: no more**

- **Everything in the diff traces to the spec.** Extra endpoints, fields, options, flags, configuration or abstractions not in the spec are YAGNI by definition, however reasonable they look. Either the spec should change to include them, or they come out.
- **Scope creep from the author's judgment.** "While I was in here" changes, a broader refactor, or a generalization for future features belong in a separate PR, or a spec update, with their own review.
- **No silent reinterpretation.** If the code does something different from the spec because the author found a better way, that may be right, but it must be stated, agreed and written back into the spec.

**Watch for drift**

Drift is when the spec and the code disagree and nobody decided they should. It accumulates quietly and makes the spec useless as a reference.

- **When code and spec disagree, decide which is right**, then fix the other in the same PR or with a linked follow-up. Don't leave both standing.
- **Specs are versioned with the code** where possible (ADRs and design docs in the repository), so a PR that changes behavior also shows the spec change in the same diff.
- **Check earlier decisions before reversing them.** Chesterton's Fence: if the code contradicts an ADR or a documented decision, find out whether the decision was superseded or the code is wrong.
- **Generated contracts help.** An OpenAPI schema, a database schema dump or a JSON schema checked into the repository turns some drift into a visible diff, and contract tests turn it into a failing build.

## Design specs and plans

*Leans on: Gall's Law, YAGNI, KISS, Conway's Law, Chesterton's Fence.*

Reviewing a spec before code exists is the cheapest review there is: a wrong boundary costs a comment instead of a rewrite. Apply the same four groups, one level up.

- **The problem before the solution.** Can you state the problem and who has it in one sentence? Are there measurable success criteria? A spec that opens with the solution often solves the wrong problem.
- **Goals and non-goals.** Explicit non-goals prevent scope creep in the implementation and give the code reviewer a way to say "no more" later.
- **Alternatives considered.** At least one simpler alternative, including "do nothing" or "use what we have", with a reason it was rejected. A spec that considers no alternatives hasn't been designed, just described.
- **Smallest working version.** Gall's Law: is there a thin vertical slice that delivers value first? Plans that need several new services, queues or databases before the first request works are a red flag.
- **Interfaces and data first.** The API contracts, data model and events are spelled out, since they are the expensive parts to change. Internal implementation detail can stay loose.
- **Failure and operations.** What happens when each dependency fails, how it is deployed and rolled back, how migrations are sequenced, what is monitored and who is paged.
- **Security and data.** Who can access what, what personal data is stored and for how long, and where trust boundaries are.
- **Ownership and boundaries.** Conway's Law: do the proposed service and module boundaries match the teams that will own them?
- **Earlier decisions.** Does it contradict an existing ADR or established pattern? If so, it should say so and why.
- **Testable requirements.** Each requirement can be checked by a test or a measurement. "Fast" and "scalable" aren't requirements; "p95 under 200 ms at 500 requests per second" is.
- **Open questions listed.** Unknowns are named with an owner, rather than hidden in confident prose.

Plans for a sequence of PRs get one more check: each step should leave the system working and deployable, as in expand and contract.

## New API endpoints

*Leans on: Hyrum's Law, least astonishment, separation of concerns, Parse Don't Validate, least privilege.*

An endpoint is a contract the moment a client calls it, so review it as an interface first and as code second. Start from the request and response schemas, not the handler body.

- **Resource and method.** The path names a resource, not an action (`POST /v1/orders/{id}/cancellations` or `POST /v1/orders/{id}:cancel`, consistently with the rest of the API, rather than `POST /cancelOrder`). `GET` is safe, `PUT` and `DELETE` are idempotent, `POST` is neither unless made so.
- **Status codes and errors.** Codes match outcomes: `201` with a `Location` header for creation, `204` for no body, `404` vs. `403` chosen deliberately, `409` for conflicts, `422` for valid JSON with invalid content. Errors use one shape across the API, ideally [RFC 9457 Problem Details](https://www.rfc-editor.org/rfc/rfc9457), and never leak stack traces or SQL.
- **Explicit input and output models.** Separate request and response models, never the ORM entity. The request model forbids unknown fields (`extra="forbid"`, or .strict() on a zod object) so clients can't mass-assign `is_admin` or `owner_id`. The response model lists exactly what is exposed, so a new column doesn't leak by default.
- **Thin handler.** The route parses input, checks authorization, calls one command or query, and maps the result to a response. Business rules in the handler are a separation-of-concerns finding.
- **Collections.** Every list endpoint is paginated with a maximum page size. Prefer keyset (cursor) pagination for large or growing tables, because `OFFSET` gets slower with every page. Filters and sort fields are allowlisted, never passed through to SQL.
- **Idempotency for writes.** A `POST` that creates or charges something accepts an idempotency key, or is otherwise safe to retry, because clients and proxies will retry it.
- **Authentication and authorization** on every route, including the ones "only the frontend calls" (see the auth playbook).
- **Limits.** Request body size, rate limits on expensive or sensitive operations, and timeouts on everything the handler calls.
- **Consistency with the rest of the API.** Field naming (`snake_case` vs. `camelCase`), timestamp format (ISO 8601 with offset), id format, envelope or no envelope. A new endpoint that is locally sensible but different from its neighbors is a least-astonishment finding.
- **Documentation and tests.** The generated OpenAPI schema reflects reality (response models declared, error responses listed). Tests cover the happy path, each error code, unauthenticated and unauthorized callers, and pagination edges.

## Endpoint schema changes, versioning and deprecation

*Leans on: Hyrum's Law above all, then least astonishment and Chesterton's Fence.*

The question for any change to an existing endpoint's request or response is: does every client that works today still work after deploy, without changing? Classify the change first, then review accordingly.

| Change | Usually safe? | Notes |
| --- | --- | --- |
| Add an optional request field | Yes | Must have a default that preserves old behavior |
| Add a response field | Mostly | Breaks clients that validate strictly or deserialize into closed types; Hyrum's Law says someone does |
| Add a new endpoint or a new enum value in a request | Yes |  |
| Add a new enum value in a response | No | Clients with exhaustive `match` or switch statements break; document enums as open from the start |
| Make an optional request field required | No | Breaking |
| Remove or rename a field, or change its type or format | No | Includes `int` to `str` ids, changing date formats, `null` vs. absent |
| Change a default, sort order, status code or error shape | No | Behavior change even if the schema is identical |
| Tighten validation (shorter max length, stricter regex) | No | Previously accepted requests now fail |
| Loosen validation | Usually | Check downstream consumers can handle the new values |

**Additive changes** need a check that the new field has a sensible default, that it appears in the response model and the OpenAPI schema, and that the database can supply it for existing rows.

**Breaking changes** need a plan in the PR description, not just code:

- **Prefer not to break.** Often the breaking change can be made additive: add `full_name` alongside `name`, populate both, and deprecate `name`.
- **Version deliberately.** A new path version (`/v2/...`) or a version header, following whatever the API already does. Don't version a single field change if expand-and-contract can avoid it; don't fork the whole API for one endpoint either.
- **Run both versions from one implementation.** The old version becomes an adapter over the new domain logic, not a copy of it, so fixes land once.
- **Announce and measure.** Mark the old endpoint or field deprecated in the OpenAPI schema and send `Deprecation` and `Sunset` response headers ([RFC 9745](https://www.rfc-editor.org/rfc/rfc9745), [RFC 8594](https://www.rfc-editor.org/rfc/rfc8594)). The `Sunset` date can't be earlier than the `Deprecation` date. Log or meter usage of the deprecated path per client, so removal is based on data, not on a date someone guessed.
- **Remove last.** Removal is its own PR, after usage has reached zero or the sunset date has passed with notice given.

For internal-only endpoints the same rules apply, with a shorter window: the frontend and the backend usually deploy separately, so for some minutes both versions of each are live at once.

## Code that validates user input

*Leans on: Parse Don't Validate, Fail Fast, least privilege, KISS.*

Validation code should run once, at the boundary, and produce a type the rest of the code can trust. Review where it happens as much as what it checks.

- **Parse into a type, don't return a boolean.** `is_valid_email(s) -> bool` leaves every later caller holding an unchecked `str`. A Pydantic model, `EmailStr`, or a `NewType` built by a parsing function carries the proof with the value. In TypeScript, a zod schema and a branded type do the same.
- **Allowlist, don't denylist.** Accept known-good shapes (enums, `Literal`, constrained types) rather than rejecting known-bad ones. Denylists of characters or keywords are always incomplete.
- **Bound everything.** Maximum lengths on strings, maximum sizes on lists and request bodies, ranges on numbers, limits on nesting depth. Unbounded input is a denial-of-service vector.
- **Normalize, then validate.** Trim, Unicode-normalize (NFKC where appropriate) and case-fold before checking and storing, so two spellings of the same value can't bypass a uniqueness check.
- **Strictness.** Decide whether `"42"` should be accepted as `42`. Pydantic's lax mode coerces; strict mode at API boundaries avoids surprises. In zod, coercion is opt-in (z.coerce), which is the safer default.
- **Regexes.** Anchored (`fullmatch`, not `match` or `search`), and free of nested quantifiers that allow catastrophic backtracking (ReDoS). Prefer a parser or a library over a hand-written regex for emails, URLs and dates.
- **Cross-field rules.** "End date after start date" belongs in a model validator, so it is enforced wherever the model is built.
- **Context-specific encoding is separate.** Validation doesn't make data safe for SQL, HTML or shell. That is done at output: parameterized queries, template autoescaping, `subprocess` with a list of arguments.
- **Files and URLs.** Check uploaded files by content, not extension. Size-limit them and store them outside the web root under generated names. Fetching a user-supplied URL needs SSRF protection: an allowlist of schemes and hosts, and blocking private and metadata addresses after DNS resolution.
- **Error messages.** Say what was wrong with which field, without echoing back large or sensitive input.
- **Tests.** Each rule has a test at its boundary: the longest valid value and one longer, the empty value, wrong types, extra fields.

## Authentication and authorization

*Leans on: least privilege, Fail Fast (fail closed), explicit over implicit, KISS.*

Authentication proves who the caller is; authorization decides what they may do with a specific resource. Most real incidents are authorization bugs, so review that half hardest.

**Authorization**

- **Deny by default.** A new route without an explicit permission requirement should fail a test or a lint, not quietly be public. Prefer a dependency or decorator that every router applies, with an explicit opt-out for public routes.
- **Object-level checks.** "Logged in" is not "allowed". Every access by id checks that the caller owns or may access *that* object. Broken object-level authorization is the most common API vulnerability (first on the [OWASP API Security Top 10](https://owasp.org/API-Security/editions/2023/en/0x11-t10/)). Scoping the query itself (`WHERE id = :id AND tenant_id = :tenant`) is safer than fetching and then checking.
- **Function-level checks.** Admin and internal operations check the role on the server, not by hiding a button.
- **Tenant isolation.** In multi-tenant code, the tenant filter is applied centrally (a repository base, a session-level filter, or row-level security), not remembered at each query.
- **One place for policy.** Permission logic lives in a policy module or service the handlers call, not scattered `if user.role == "admin"` checks.
- **Not found vs. forbidden.** Return `404` for objects the caller isn't allowed to know exist, so ids can't be enumerated.

**Authentication**

- **Don't roll your own.** Use the framework's or an established library's primitives for sessions, OAuth/OIDC and password hashing.
- **Tokens.** JWT verification pins the algorithm (never accepts `none`), checks signature, `exp`, `aud` and `iss`, and fetches keys from a trusted JWKS with caching. Tokens are short-lived, with refresh tokens rotated and revocable.
- **Passwords and secrets.** Hashed with Argon2id or bcrypt, never a plain or fast hash. Secret comparisons use `hmac.compare_digest` (crypto.timingSafeEqual in Node). Login, reset and verification endpoints are rate-limited and return the same response whether or not the account exists.
- **Sessions and cookies.** `HttpOnly`, `Secure`, `SameSite`; session id rotated on login and privilege change; CSRF protection for cookie-authenticated state changes.
- **Nothing sensitive in logs or URLs.** Tokens, passwords, reset links and session ids never appear in log lines or query strings.

**Tests.** Every protected endpoint has negative tests: unauthenticated, authenticated but wrong role, authenticated but another tenant's or user's object. These are the tests that catch real bugs and the ones most often missing.

## React components (JSX and TSX)

*Leans on: separation of concerns, make illegal states unrepresentable, least astonishment, KISS.*

A component is a function from props and state to UI. Most component bugs come from state that lives in the wrong place, effects that shouldn't exist, and props that promise more than the component needs.

- **One job per component.** Fetching, state management and presentation are separated once a component grows. A 400-line component with five `useState` calls and three effects is a god class.
- **Props are an interface.** Typed, narrow (pass the fields rendered, not the whole record), with required and optional chosen deliberately. A pile of boolean props (`primary`, `secondary`, `danger`) becomes one `variant: "primary" | "danger"`. Composition with `children` beats a growing list of configuration props.
- **State in the right place.** Derive what can be derived during render instead of storing it, and don't copy props into state. Lift state only as far as the nearest common owner. Server data belongs in a data-fetching cache (TanStack Query, SWR) or a Server Component, not a hand-rolled `useEffect` plus `useState`. Filters, tabs and pagination belong in the URL.
- **Illegal states.** Independent `isLoading`, `isError` and `data` flags allow "loading and failed" at once; a discriminated union on `status` doesn't.
- **Effects only synchronize with external systems.** Effects that compute derived values, respond to user events, or chain state updates are findings ([You Might Not Need an Effect](https://react.dev/learn/you-might-not-need-an-effect)). Each effect has complete dependencies (`eslint-plugin-react-hooks` enforces this), cleans up subscriptions, timers and requests (`AbortController`), and works when run twice in development Strict Mode.
- **Rules of Hooks.** Hooks are called unconditionally at the top level, and custom hooks start with `use`.
- **Lists and keys.** Keys are stable ids from the data, never the array index for lists that reorder, filter or insert.
- **Memoization on evidence.** `useMemo`, `useCallback` and `memo` are added for a measured problem, not sprinkled everywhere; the React Compiler, where the project uses it, handles most of it.
- **Every state is designed.** Loading, empty, error and success are each rendered deliberately. Error boundaries wrap sections that can fail independently, and Suspense fallbacks don't shift the layout.
- **Forms.** Every input has a label, errors are tied to their fields, double submits are prevented, and the server validates again, ideally with the same schema the client uses.
- **Security.** No `dangerouslySetInnerHTML` with unsanitized input (DOMPurify if HTML must be rendered), no user-controlled `href` that could be a `javascript:` URL, and no secrets in client code.
- **Tests.** React Testing Library queries by role and label, the way users find elements, and asserts behavior. Large snapshot tests are noise nobody can review.

## Next.js

*Leans on: least privilege, separation of concerns, Parse Don't Validate, explicit over implicit.*

In the App Router, the line between server and client runs through the component tree, and the most serious Next.js bugs are data crossing it the wrong way. Review where each file runs before what it does. The [Next.js data security guide](https://nextjs.org/docs/app/guides/data-security) is the reference.

- **The `'use client'` boundary.** Placed as low in the tree as possible, so most of the page stays a Server Component. Props passed into a Client Component are serialized to the browser: check they carry only what the UI needs, never whole database records.
- **Server-only code stays on the server.** Modules that touch the database, secrets or internal APIs `import 'server-only'`, so importing them from client code fails the build. Data access and `process.env` reads live in one data access layer.
- **Environment variables.** Anything prefixed `NEXT_PUBLIC_` is inlined into the client bundle. A secret with that prefix is a leak even if no component uses it yet.
- **Server Actions are public endpoints.** Every exported action can be called with a direct POST, whether or not the UI exposes it. Each one validates its arguments, checks authentication and authorization (ownership of the specific resource) itself, and returns only what the UI needs. A page-level auth check does not cover the actions defined in that page.
- **Route handlers and the proxy.** `route.ts` handlers get the full API endpoint review. `proxy.ts` (`middleware.ts` in older versions) is powerful and easy to get wrong; don't rely on it alone for authorization.
- **Dynamic segments are user input.** `[param]` folders and `searchParams` are validated like any request input.
- **Caching and revalidation.** For each data fetch, check whether it's cached, for how long, and what invalidates it (`revalidatePath`, `revalidateTag`). Per-user data cached as if it were shared leaks between users; data that must be fresh but is cached goes stale silently.
- **No side effects during render.** Mutations (logout, writes, cache invalidation) happen in Server Actions or route handlers, never while rendering a page.
- **Rendering mode.** Know whether a route renders statically or dynamically and why; reading cookies or headers makes it dynamic. Use `next/image` and `next/font`, and check the client bundle size impact of new client-side dependencies.
- **Hydration.** Values that differ between the server and client render (current time, random ids, `window` checks) cause hydration errors. Use `useId`, and render client-only values after mount.

## Accessibility

*Leans on: least astonishment, Fail Fast, KISS.*

Accessibility bugs rarely show up in a screenshot, so review the markup and the interaction, not just the look. Target [WCAG 2.2](https://www.w3.org/TR/WCAG22/) level AA unless the project states otherwise.

- **Semantic HTML first.** `<button>` for actions, `<a href>` for navigation, headings in order, lists as lists, a `<label>` for every input, landmarks (`<main>`, `<nav>`). A `div` with an `onClick` is a finding: keyboards and screen readers can't use it.
- **ARIA only to fill gaps.** No ARIA is better than wrong ARIA. Roles and states (`aria-expanded`, `aria-selected`) match the behavior and update with it.
- **Keyboard.** Everything interactive is reachable and usable by keyboard, in a logical order, with a visible focus indicator. Dialogs move focus in, keep it there while open, close on Escape, and return focus when closed.
- **Names and text alternatives.** Icon-only buttons have an accessible name. Images have meaningful `alt` text, or `alt=""` when decorative.
- **Color and contrast.** Text contrast of at least 4.5:1 (3:1 for large text and UI components). Meaning is never carried by color alone.
- **Dynamic content.** Errors, toasts and async results are announced through live regions or by moving focus. Form errors are linked to their fields with `aria-describedby`.
- **Motion and zoom.** Animation respects `prefers-reduced-motion`, and the layout works at 200% zoom and at 320 px wide without horizontal scrolling.
- **Tooling, then a manual pass.** `eslint-plugin-jsx-a11y` and axe in component or end-to-end tests catch part of the problems. New interactive components also get a keyboard-only pass and a quick screen reader check.

## CSS and styling

*Leans on: KISS, high cohesion, least astonishment, explicit over implicit.*

- **Follow the system.** Colors, spacing, type and radii come from design tokens or the theme, not hard-coded hex values and pixel numbers. A new one-off value is a question.
- **Scope.** Styles are scoped to their component (CSS Modules, Tailwind utilities, CSS-in-JS) rather than global selectors that reach into other components. Changes to global CSS get extra scrutiny, because they touch every page.
- **Specificity.** No `!important` and no deep selector chains to win a specificity fight; fix the cascade instead, with cascade layers (`@layer`) where the codebase uses them.
- **Tailwind.** Class lists repeated across components become a component, not an `@apply` block. Conditional classes go through a helper (`clsx`, `cva`), and class names are written as complete strings so the build can find them.
- **Layout.** Flexbox and grid rather than absolute positioning and magic offsets. Responsive at the project's breakpoints and checked at narrow widths. Images and embeds reserve their space so the page doesn't shift as they load.
- **Themes.** Dark mode and other themes work through variables; no color that only works on one background.
- **Stacking.** `z-index` values come from a defined scale, not ever-escalating numbers.
- **Animation.** Animate `transform` and `opacity` rather than layout properties, and respect `prefers-reduced-motion`.
- **Dead styles.** Removed components take their styles with them.

## HTML artifacts

*Leans on: KISS, least privilege, explicit over implicit.*

Standalone HTML files (generated reports, dashboards, docs pages, one-off tools, pages an AI agent produced) are shared widely and reviewed lightly. Review them as small web apps.

- **Pinned dependencies.** External scripts and stylesheets load from trusted CDNs at exact versions, with Subresource Integrity (`integrity`) hashes where possible. A floating version such as `@latest` changes the page without a code change.
- **XSS.** Data inserted with `innerHTML`, template strings or `document.write` is escaped or sanitized; `textContent` and DOM APIs are preferred. Where the page is served, a Content Security Policy is set.
- **Nothing private embedded.** API keys, tokens, internal URLs and personal data in the HTML, inline JSON or comments are visible to anyone who has the file.
- **Semantic and accessible.** A `lang` attribute, a viewport meta tag, real headings, labels and sufficient contrast; the accessibility playbook applies.
- **Responsive and themed.** Works at phone width without horizontal scrolling, and respects `prefers-color-scheme` if it has a dark mode.
- **Offline when that's the point.** A report meant to be emailed or archived works without the network; otherwise, the page fails gracefully when a CDN is unreachable.
- **Size.** Embedded images and data are compressed; large `data:` URIs bloat the file.
- **Generated output.** When a script or template produces the HTML, review the generator and a sample of its output, and reject hand edits to generated files.

## Data modeling: tables, relationships and domain objects

*Leans on: make illegal states unrepresentable, separation of concerns, high cohesion, YAGNI.*

A schema outlives the code that first used it, so it gets the most careful design review of anything in a PR. Review the tables and the Python objects that represent them together, because mismatches between the two are where bugs live.

**The tables**

- **Start from the queries.** Ask the author for the main reads and writes this model serves. The schema, keys and indexes should follow from them, not from the shape of a JSON payload.
- **Keys.** Every table has a primary key. Choose surrogate ids (`bigint` identity or UUID; UUIDv7 if inserts should stay index-friendly) consistently with the rest of the schema. Natural uniqueness (email per tenant, one active subscription per account) is a `UNIQUE` constraint, partial if needed, not an application check.
- **Constraints carry the invariants.** `NOT NULL`, `CHECK`, foreign keys and unique constraints make illegal states impossible regardless of which code path writes. An invariant enforced only in Python will be violated by the next script, migration or service that writes to the table.
- **Foreign key behavior.** Each `ON DELETE` (`CASCADE`, `RESTRICT`, `SET NULL`) is a deliberate choice. Cascades on large or important tables can delete far more than intended.
- **Normalization.** Normalize by default. Denormalized copies need a stated reason (a measured read path) and a mechanism that keeps them in step.
- **Soft deletes, audit and tenancy.** If `deleted_at` exists, every unique constraint and every query must account for it, usually with partial indexes. Decide whether audit history belongs in the table or a separate log. Tenant ids appear on every tenant-scoped table.
- **Naming.** Plural or singular table names, `_id` suffixes, timestamp column names (`created_at`, `updated_at`) consistent with the existing schema.

**Column types.** Check that the database's types fit the data:

| Smell | Why it hurts | Prefer |
| --- | --- | --- |
| Money as `float` or `REAL` | Rounding errors accumulate | `Decimal` with `NUMERIC(p, s)`, or integer minor units plus currency in a `Money` type |
| Timestamps as strings, naive datetimes, or `TIMESTAMP` without time zone | Ambiguous across zones and daylight saving changes | Timezone-aware UTC `datetime`, stored as `TIMESTAMPTZ` |
| UUIDs, IP addresses or fixed value sets as `VARCHAR` | No validation, larger indexes | Native `UUID` and `INET`; an enum, check constraint or lookup table for fixed sets |
| JSONB holding fields that are queried, joined, filtered or constrained | No integrity, awkward queries, silent schema drift | Real columns or tables; JSONB only for payloads that are rarely filtered and genuinely vary |
| Nullable columns that are never null in practice | Every reader handles a case that can't occur | `NOT NULL` wherever the domain requires a value |
| A list of ids packed into one column | No foreign keys, no joins | A join table |
| `is_active`, `is_deleted` and `deleted_at` side by side | Contradictory states are possible | One representation of state, with the rest derived |

**Relationship shapes.** Choose the structure that matches how the data relates:

- **One-to-many.** A foreign key on the many side, indexed, with a deliberate `ON DELETE` behavior.
- **One-to-one.** A foreign key with a unique constraint. First ask whether it should simply be one table; split only for a different lifecycle, access pattern, or large and rarely read columns.
- **Many-to-many.** An association table with a composite unique key. If the link carries data of its own (a role, a quantity, a start date), it is an entity and deserves a name.
- **Polymorphic references** (`target_type` plus `target_id`). The database can't enforce them. Prefer separate foreign keys with a check constraint, or a join table per target.
- **Hierarchies.** An adjacency list with a recursive CTE works for shallow or rarely queried trees. Use `ltree` or a closure table when subtree queries are frequent.
- **True graphs.** Variable-depth traversal, path finding, and many-to-many links among the same kind of entity, with questions like "who is connected to whom within N hops". If a SQL schema keeps accumulating self-joins and recursive CTEs, a graph database may fit better. The reverse also happens: data in a graph store whose queries are filters, aggregates and transactions belongs in a relational database. The dominant queries decide.

**The domain objects**

- **Persistence model vs. domain model.** For CRUD, one SQLModel class may serve as both. Once the domain has behavior and invariants, keep the ORM model at the repository boundary and map to domain objects, so the domain doesn't depend on SQLAlchemy and table changes don't ripple into business logic. The same applies to Prisma or Drizzle in TypeScript: map to domain types at the repository boundary instead of passing generated client types everywhere.
- **Relationships in code match the database.** A non-nullable foreign key is a non-optional attribute; a `UNIQUE` link is one object, not a list. Type hints, nullability and defaults on the Python side agree with the columns.
- **Aggregates.** Decide which objects are loaded and saved together and which are referenced by id only. An aggregate that pulls in half the database on load is the wrong boundary.
- **Loading strategy declared.** Relationships specify how they load. In async SQLAlchemy, `lazy="raise"` on relationships turns accidental lazy loads into immediate errors instead of hidden queries. In Prisma or Drizzle, relations load only when the query asks for them (include, with), so check list queries fetch them in one query rather than per row.
- **Value objects.** Money, addresses, date ranges and similar groups are value types in code, mapped to columns with composites or explicit mapping, not loose fields.

## Queries and indexes

*Leans on: premature optimization (measure), Fail Fast (catch it before production), explicit over implicit.*

A missing index rarely fails a test. It fails in production, when the table is large and a page or a job does a sequential scan under load. Review every new query against the data it will meet, not the test fixtures.

**Finding missing indexes**

- **Every new query, every new filter.** For each `WHERE`, `JOIN`, `ORDER BY` and `GROUP BY` on a table that is or will be large, find the index that serves it. If there isn't one, it's a finding.
- **Foreign keys.** PostgreSQL indexes the referenced primary key but not the referencing column. Without an index on the foreign key, joins from the parent and every cascading delete scan the child table.
- **Composite order.** Columns used with equality come first, then the range or sort column. An index on `(tenant_id, created_at)` serves `WHERE tenant_id = ? ORDER BY created_at`; one on `(created_at, tenant_id)` mostly doesn't.
- **Read the plan.** For anything non-trivial, ask for `EXPLAIN (ANALYZE, BUFFERS)` against production-sized data. A `Seq Scan` on a large table, a large `Rows Removed by Filter`, or a sort spilling to disk are the things to look for.
- **Partial and covering indexes.** `WHERE deleted_at IS NULL` or `WHERE status = 'pending'` partial indexes are smaller and faster for hot queries; `INCLUDE` columns can make a query index-only.
- **Don't over-index.** Each index slows every write and costs storage. Redundant indexes (a prefix of another index) and indexes no query uses are findings too.

**String matching, prefixes and wildcards**

| Pattern | Can use a plain B-tree index? | What to use |
| --- | --- | --- |
| `col = 'abc'` | Yes | B-tree |
| `col LIKE 'abc%'` (prefix) | Only with `C` collation, or an index built with `text_pattern_ops` / `varchar_pattern_ops` | B-tree with a pattern operator class |
| `col LIKE '%abc'` (suffix) | No | Trigram GIN index (`pg_trgm`), or an index on `reverse(col)` |
| `col LIKE '%abc%'` (contains) | No | Trigram GIN index (`pg_trgm`) |
| `col ILIKE ...` or `lower(col) = ...` | No | Expression index on `lower(col)`, `citext`, or trigram for patterns |
| Words in prose | No | Full-text search (`tsvector` with a GIN index) or a search engine |

- **Escape user input in patterns.** `%` and `_` in user input are wildcards. Escape them (and the escape character) before building a `LIKE` pattern, or a search for `100%` matches everything, and a leading `%` from a user turns an indexed prefix search into a full scan.
- **Minimum lengths.** Contains-searches on one or two characters match most rows even with a trigram index. Require a minimum length or cap results.
- **Regex and functions on columns.** `WHERE lower(email) = ...`, `WHERE date(created_at) = ...` or `~` regex matches can't use a plain index on the column. Index the expression or rewrite as a range.

**N+1 and other ORM traps**

- **Spot the loop.** Any relationship attribute accessed inside a loop over query results is a query per row unless it was eager-loaded. Look at templates and serializers too; they are where N+1 hides.
- **Load explicitly.** `selectinload` for collections, `joinedload` for many-to-one, and `lazy="raise"` so a missed one fails in tests. In TypeScript ORMs, use include or one findMany with an in filter rather than a query per item; in GraphQL resolvers, batch per-request lookups with DataLoader.
- **Count queries in tests.** A test that asserts the number of queries for a list endpoint (via an SQLAlchemy `before_cursor_execute` event listener, for example) stays green as the fixture grows only if there is no N+1.
- **Unbounded reads.** `.all()` on a table that grows, with no `LIMIT`. Paginate, stream, or batch.
- **Deep `OFFSET`.** Page 10,000 still reads and discards all earlier rows. Use keyset pagination.
- **Writes in loops.** One `INSERT` or `UPDATE` per row inside a loop. Use bulk operations.

## SQL files and raw queries

*Leans on: Parse Don't Validate, Fail Fast, explicit over implicit, least privilege.*

SQL shows up as `.sql` files (migrations, views, functions, seed data, reporting queries), as raw strings inside application code, and as query-builder chains. Review it as code that runs against production data, often with more privilege than the application has. The SQL section of Part 3 has the idioms; this is the review pass.

- **Parameters, never interpolation.** Values reach the query as bound parameters. Identifiers that must be dynamic (a sort column, a table name) come from an allowlist and are quoted with the driver's identifier quoting, never from raw user input.
- **Read it against the schema.** Check join conditions against the actual keys: a missing or wrong condition multiplies rows, and `DISTINCT` added to hide duplicates is a sign of it. Check `NULL` handling in comparisons, `NOT IN`, outer joins and aggregates.
- **Correct results on edge data.** Empty tables, `NULL` columns, duplicate keys, time zone boundaries and the first and last page of a paginated query.
- **Performance on real data.** Every new query or changed predicate gets the queries and indexes playbook, and `EXPLAIN (ANALYZE, BUFFERS)` on production-sized data for anything that touches large tables.
- **Transactions and locking.** Multi-statement changes run in one transaction. Long-running statements, `SELECT ... FOR UPDATE`, and bulk `UPDATE` or `DELETE` are checked for how long they hold locks and what waits behind them; large changes run in batches.
- **Destructive statements.** `DELETE`, `UPDATE`, `TRUNCATE` and `DROP` in scripts have an explicit `WHERE` or scope, a matching `SELECT` that shows what will change, a row-count check or `RETURNING`, and a backup or rollback plan for production.
- **Views, functions and triggers.** Views used as an interface are versioned like an API. Functions declare their volatility and security (`SECURITY DEFINER` sets `search_path` explicitly). Triggers are a last resort, because they hide behavior from everyone reading the application code.
- **Least privilege.** Reporting and analytics queries run as read-only roles. Scripts run with the narrowest role that works, not the owner or superuser.
- **Idempotent scripts.** Seeds and one-off scripts can be re-run safely (`CREATE ... IF NOT EXISTS`, `INSERT ... ON CONFLICT`), or say clearly that they can't.
- **Readable and linted.** Formatted by SQLFluff or the project's formatter, with CTEs named for what they hold and comments explaining business rules the query encodes.
- **Tested.** Queries with logic in them (reports, aggregates, complex filters) have tests against a real database with known fixture data and expected results.

## Migrations and deployment sequencing

*Leans on: Hyrum's Law, Gall's Law (small steps), Fail Fast, Chesterton's Fence.*

During a deploy, old and new code run against the same database at the same time, and a migration that locks a busy table takes the site down with it. Review a migration as an operation on production, not as a diff to a schema file.

**Sequencing: expand, migrate, contract**

Any change that old code can't tolerate is split across releases, so that every intermediate state works with both the code before and the code after it:

1. **Expand.** Add the new column, table or index. Nullable or with a default. Old code ignores it.
2. **Write both.** Deploy code that writes old and new shapes, and reads the old.
3. **Backfill.** Copy existing data in batches, as a separate, resumable job, not inside the schema migration.
4. **Read new.** Deploy code that reads the new shape. Old shape still written as a fallback.
5. **Contract.** Stop writing the old shape, then drop it in a later release.

A PR that renames a column, changes a type or drops anything in one step, alongside the code that depends on it, is a finding. So is a PR whose migration and code must deploy in a particular order that the deploy pipeline doesn't guarantee. The PR description should say which step this is and what follows.

**Locking and long operations (PostgreSQL)**

| Operation | Risk | Safer approach |
| --- | --- | --- |
| `CREATE INDEX` | Blocks writes for the whole build | `CREATE INDEX CONCURRENTLY`, which can't run inside a transaction (in Alembic, use `autocommit_block()`); check for an `INVALID` index if it fails |
| Add a column with a default | Fast on PostgreSQL 11 and later | Fine for constant and stable defaults, including `now()`; a volatile default (`random()`, `gen_random_uuid()`, `clock_timestamp()`) still rewrites the table |
| Add `NOT NULL` to an existing column | Full scan under an exclusive lock | Add `CHECK (col IS NOT NULL) NOT VALID` and commit; then, in a separate transaction, `VALIDATE CONSTRAINT`, which takes only a `SHARE UPDATE EXCLUSIVE` lock; then `SET NOT NULL`, which PostgreSQL 12+ does without a scan. In one transaction, the `ACCESS EXCLUSIVE` lock from the first step is held through the validation scan, so Alembic needs separate migrations or `autocommit_block()` |
| Add a foreign key | Scans the table while holding locks on both tables | Add it `NOT VALID`, then `VALIDATE CONSTRAINT` separately |
| Change a column type | Usually rewrites the table | New column plus backfill, via expand and contract |
| Rename or drop a column or table | Breaks running old code instantly | Expand and contract; drop only after no deployed code references it |
| Any DDL on a hot table | Queues behind long transactions, then blocks everything queued behind it | Set `lock_timeout` (a few seconds) and retry, rather than waiting indefinitely |

**The migration itself**

- **Matches the model.** Autogenerated migrations (Alembic, Prisma Migrate, Drizzle Kit) are a draft. Check that the migration does exactly what the model change implies: constraints, indexes, server defaults, enum changes. Alembic's autogenerate misses some of these.
- **Reversible, or honestly not.** A `downgrade` that works, or one that raises with an explanation when data would be lost. A downgrade that silently drops data is worse than none.
- **Data migrations separate from schema migrations.** Backfills in batches, idempotent, resumable, and not holding a transaction open for the whole table.
- **Tested on realistic data.** Run against a copy or a production-sized dataset to measure duration and locks. A migration that takes 50 ms locally can take 40 minutes in production.
- **Linear history.** No merge conflicts in revision heads; one migration per logical change.
- **Chesterton's Fence for drops.** Before dropping a column, table or index, confirm nothing reads it: other services, reports, analytics jobs, and old app versions still running.

## Code on the critical path

*Leans on: premature optimization (measure), Fail Fast, KISS, Gall's Law.*

Critical-path code is anything that sits in every request, in checkout or login, or in a job the business depends on. The bar is higher: the change must not make the path slower, less available, or harder to roll back, and the reviewer should be able to say how they know.

- **What's new in the path.** List every added network call, query, lock, file read or third-party dependency. Each one is a new way for the path to be slow or down. Ask whether it can move off the path: precomputed, cached, or done asynchronously after the response.
- **Timeouts and budgets.** Every outbound call has a timeout well inside the path's latency budget. Retries have a cap and backoff, and the total retry time also fits the budget.
- **Failure of dependencies.** What happens when the new dependency is slow or down? Prefer degrading (a fallback value, a skipped enrichment, a circuit breaker) over failing the whole request, when the business allows it.
- **Work per request.** No queries in loops, no unbounded reads, no heavy serialization, regex compilation or object construction repeated per call. Async code doesn't block the event loop.
- **Caching.** A new cache key includes everything the value depends on (tenant, user, permissions, locale). Expiry is a deliberate TTL or an explicit invalidation rule. A hot key expiring shouldn't send every request to the database at once, and the path still works when the cache is empty or down. A cached value served across a permission boundary is a security bug.
- **Measured, not assumed.** A change claimed to be faster comes with a benchmark or a profile. A change that could be slower comes with a load test or a comparison of p95/p99 latency before and after.
- **Rollout.** Behind a feature flag or a percentage rollout, with a metric that would show a regression and a way to turn it off without a deploy.
- **Observability.** Latency, error rate and saturation for the path are measured, and the new code adds spans or metrics for the parts it introduces.
- **Simplicity matters more here.** Clever caching, custom concurrency and hand-rolled retry logic on the critical path need the strongest justification, because they fail in ways that are hard to see.

## Background jobs, queues and events

*Leans on: Fail Fast, Hyrum's Law, explicit over implicit, Gall's Law.*

Asynchronous work fails differently from a request. Nobody is waiting for the response, so failures are silent unless someone made them loud, and most queues deliver at least once, so every message may arrive twice, late or out of order.

- **Idempotent handlers.** Running the same message twice produces the same result. Use a deduplication key, an upsert, or a state check guarded by a unique constraint. A handler that charges, emails or increments on every delivery is a finding.
- **Retries and dead letters.** Retries have backoff and a maximum. A message that keeps failing goes to a dead-letter queue that someone is alerted about, instead of blocking the queue or vanishing.
- **Transient vs. permanent errors.** Retry timeouts and connection errors; don't retry validation errors or missing records forever.
- **Publishing with the transaction.** An event published before the database transaction commits can describe a write that rolled back; one published after can be lost if the process dies. Use a transactional outbox (write the event to a table in the same transaction, relay it afterward) when the event must match the data.
- **Payloads are contracts.** Event schemas are versioned like endpoints. Consumers tolerate unknown fields; adding a required field or changing a meaning is a breaking change. Prefer ids plus a small amount of data over whole serialized objects, which go stale and grow.
- **Ordering.** If the handler assumes messages arrive in order, check that the queue guarantees it for this key, or make the handler check a version or timestamp.
- **Time limits.** The job's maximum runtime is shorter than the queue's visibility or ack timeout, or the message is redelivered while still running. Long work is split into resumable batches with checkpoints.
- **Scheduled jobs.** A cron job that can overlap its previous run needs a lock. Schedules state their time zone, and a missed run is either caught up or deliberately skipped.
- **Observability.** Queue depth, age of the oldest message, processing time and failure rate are measured. A job that silently stops running is the most common failure, so alert on absence, not just on errors.
- **Tests.** Run the handler twice on the same message, fail it halfway through, and deliver an old payload version.

## Logging and error logging

*Leans on: Fail Fast (failures are visible), least privilege (logs leak), KISS, explicit over implicit.*

Logs exist for the person debugging production at the worst possible moment. Review each log line by asking whether that person would want it, could find it, and could act on it, and whether it leaks something it shouldn't.

**General logging**

- **Structured, not interpolated.** Events with fields (`log.info("order_created", order_id=..., tenant_id=...)` with `structlog`), not prose built with f-strings. In Node, pino does the same. Fields are searchable; sentences aren't. With the stdlib logger, pass arguments rather than pre-formatting, so work is skipped when the level is off.
- **Stable event names.** A short, greppable event name per log site. Changing it breaks dashboards and alerts, which is Hyrum's Law applied to logs.
- **Correlation.** A request id or trace id bound once (contextvars, middleware) and present on every line, so one request can be followed across services.
- **Levels mean something.** `ERROR` means someone should look; `WARNING` is unexpected but handled; `INFO` is a business-level event; `DEBUG` is off in production. An `ERROR` that fires on normal traffic trains people to ignore alerts.
- **Volume on hot paths.** No per-item logging inside loops or per-request `INFO` noise on high-traffic endpoints. Sample, aggregate, or use a metric instead.
- **No sensitive data.** No passwords, tokens, API keys, full request or response bodies, payment details or unnecessary personal data. Log ids, not payloads. Prefer a redaction processor over relying on every call site to remember.
- **Metrics vs. logs.** Counts and rates belong in metrics. Watch label cardinality: user ids or URLs as metric labels will overwhelm the metrics backend.

**Error logging**

- **Log once, at the boundary that handles it.** Code that catches, logs and re-raises at every layer produces the same stack trace five times. Lower layers raise with context; the top-level handler or job runner logs.
- **Keep the traceback.** Inside `except`, use `log.exception(...)` (or `exc_info=True`) so the stack trace is recorded. `log.error(str(e))` throws away where it happened. In TypeScript, log the error object itself, not err.message, so the stack and cause survive.
- **Chain, don't replace.** `raise DomainError(...) from err` preserves the original cause for the log.
- **Context that helps.** The ids and parameters needed to reproduce the failure, not the whole object graph.
- **Expected vs. unexpected.** A user's invalid input is not an `ERROR`; it is a `4xx` and maybe an `INFO`. A failed payment-provider call after retries is. Classify deliberately, because error rate drives alerting.
- **No swallowing.** `except Exception: log.warning(...)` followed by carrying on is a silent failure with a paper trail. If the code can't proceed correctly, it should raise.
- **User-facing errors stay generic.** Details go to the log under a correlation id that is also returned to the client, so support can find the entry without exposing internals.

## Shell scripts (Bash and zsh)

*Leans on: Fail Fast, KISS, least privilege, explicit over implicit.*

Shell scripts run with full user privileges, often unattended, and fail in quiet ways. Part 3 covers shell idioms and the differences between Bash and zsh; this is the review pass.

- **Should it be shell?** Glue around commands is fine. Past roughly a hundred lines, or once it needs data structures, JSON handling beyond `jq` one-liners, or careful error recovery, ask for Python or TypeScript.
- **Interpreter and strict mode.** A shebang for the shell the script is written for (`#!/usr/bin/env bash`, `#!/bin/zsh`), and strict mode at the top (`set -euo pipefail`). Know its gaps: `set -e` is ignored inside a function called from `if`, `&&` or `||`, and `local x=$(cmd)` hides a failed command.
- **Linted.** ShellCheck passes for Bash and POSIX sh, with each disabled check justified inline. ShellCheck doesn't support zsh, so zsh scripts get `zsh -n` and a closer read.
- **Quoting.** Every expansion quoted (`"$var"`, `"$@"`, `"${arr[@]}"`) unless splitting is intended and commented. An unquoted variable in `rm`, `mv` or `cp` is a blocker.
- **Destructive commands.** `rm -rf` guarded against empty or unset variables (`"${dir:?}"`), `--` before arguments that could start with a dash, and a dry-run mode for anything that deletes or rewrites many files.
- **Inputs and environment.** Arguments validated, with a usage message and a non-zero exit. Required environment variables checked up front. Scripts run by cron, launchd, systemd or CI don't get your interactive shell: `PATH`, `HOME` and tool locations are set explicitly.
- **Temp files and cleanup.** `mktemp` instead of fixed paths in `/tmp`, removed by `trap ... EXIT`.
- **Idempotent.** Running twice is safe: `mkdir -p`, `ln -sfn`, checks before creating, and appends that don't duplicate lines.
- **Structured data.** `jq` for JSON, never `grep`, `sed` or `awk` over JSON text, and no inline Python one-liners to parse it.
- **Secrets.** Not passed as command-line arguments (visible in `ps`), not echoed, not logged, and `set -x` is off around them.
- **Downloads.** No `curl ... | sh`. Download, verify a checksum or signature, then run.
- **Output and exit codes.** Diagnostics to stderr, data to stdout, meaningful exit codes, `--help`, and a `main` function for anything longer than a screen.
- **Tested.** Non-trivial scripts have Bats tests, or at least a CI job that runs them against a fixture.

## Dockerfiles and container images

*Leans on: least privilege, KISS, explicit over implicit, Fail Fast.*

- **Pinned base image.** A specific version tag at minimum, a digest (`@sha256:...`) for reproducible builds, and a slim or distroless base where it works. `latest` is a finding.
- **Multi-stage builds.** Compilers and build tools live in a build stage; the final image has only the runtime and the application.
- **Layer order for caching.** Copy the dependency manifest and lockfile, install, then copy the source. Copying the whole repository first reinstalls everything on every code change.
- **Installs from the lockfile.** `uv sync --locked`, `npm ci`, `pnpm install --frozen-lockfile` or `bun install --frozen-lockfile`, never a fresh resolve.
- **No secrets in layers.** Every layer is readable in the final image, so build secrets use BuildKit secret mounts (`RUN --mount=type=secret,...`), never `ARG`, `ENV` or a copied key file. A `.dockerignore` keeps `.env`, `.git` and local build output out of the build context.
- **Non-root.** The final stage runs as a non-root `USER`, with files copied at the right ownership (`COPY --chown`).
- **Signals and shutdown.** `CMD` and `ENTRYPOINT` in exec form (a JSON array) so the process receives signals and shuts down cleanly, with an init process (`tini`, or `--init`) when the app doesn't reap child processes.
- **Runtime behavior.** A health check (in the image or the orchestrator), configuration from environment variables, and logs to stdout and stderr.
- **Small attack surface.** Package caches, compilers and debugging tools don't reach the final image; package installs and their cleanup happen in the same `RUN`.
- **Scanned and linted.** An image scanner (Trivy, Grype, or the registry's) runs in CI with critical vulnerabilities as a blocker, and hadolint checks the Dockerfile.

## Infrastructure as code

*Leans on: least privilege, Gall's Law, Chesterton's Fence, Hyrum's Law, explicit over implicit.*

Terraform or OpenTofu, Kubernetes manifests, Helm charts and Compose files change production directly. Review the plan, not only the diff.

- **Read the plan.** The PR includes the `terraform plan` output (or `helm diff`, `kubectl diff`). Any destroy or replace of a stateful resource (databases, volumes, buckets, DNS records) is a blocker until explained. A one-line attribute change can force a replacement.
- **Blast radius.** One environment at a time, production last. Shared modules change carefully, because every consumer picks up the change. State is split so that one mistake can't touch everything.
- **Pinned versions.** Providers, modules, charts and images pinned, with `.terraform.lock.hcl` committed.
- **Least privilege.** No `*` actions or resources in IAM policies, no `0.0.0.0/0` on non-public ports, buckets private by default, and encryption at rest and in transit.
- **Secrets.** Not in variable files or committed plans; read from a secret manager. Reading from a secret manager doesn't keep a value out of state: anything passed to an ordinary resource argument is stored in state and saved plans in plain text, and `sensitive` only redacts it from displayed output. So state and saved plans need encryption at rest and restricted access. Where a secret must not persist at all, use an ephemeral value or a write-only argument if the provider supports one.
- **Kubernetes workloads.** Resource requests and limits, readiness and liveness probes, a non-root security context, a PodDisruptionBudget for anything with replicas, and pinned image tags.
- **Protection for stateful resources.** Production databases and buckets have deletion protection or `prevent_destroy`.
- **Drift.** Resources changed by hand in a console are imported or reverted, and every `ignore_changes` has a reason.
- **Policy and lint in CI.** `terraform validate`, `tflint`, and a policy scanner (Checkov, Trivy's misconfiguration scan, or OPA).
- **Tags and naming.** Resources follow the existing naming convention and carry owner, environment and cost tags.
- **Compose files.** Pinned images, no secrets in committed `environment:` blocks, health checks on dependencies, and named volumes for data that must survive a restart.

## Configuration files

*Leans on: explicit over implicit, Fail Fast, least privilege, YAGNI.*

Configuration changes deploy behavior without changing code, and they often skip the tests that code gets. Review them with that in mind: a one-character change in a YAML file can take production down.

- **Is it configuration at all?** Make something configurable only when it differs between environments or deployments. Everything else is a constant in code, with tests and types.
- **Typed and validated at startup.** Settings are loaded into a typed model (`pydantic-settings`, or a zod schema over process.env in TypeScript) that fails fast on missing or invalid values when the process starts, not at first use hours later.
- **Defaults are safe.** Debug off, verbose logging off, authentication on, permissions narrow. A missing value should fail or fall back to the safe choice, not the convenient one.
- **No secrets in config files or the repository.** Secrets come from a secret manager or the environment at runtime. Check `.env` files, Docker Compose files, CI workflows and Kubernetes manifests in the diff for anything that looks like a key or password.
- **Per-environment differences are deliberate.** Diff staging against production config for the changed keys. A value that differs by accident is how "it worked in staging" happens.
- **Least privilege in infrastructure config.** IAM policies, database roles, network rules, container users and CI permissions grant only what is needed. Wildcards (`*`) in permission policies are findings.
- **Pinned and reproducible.** Dependency versions are pinned with a lockfile (`uv.lock`), container images by version or digest, CI actions by version or SHA.
- **Tooling config.** Changes to Ruff, mypy, coverage or pre-commit settings that loosen a rule (adding ignores, lowering strictness, excluding paths) need a reason. Silencing a rule to make a PR pass is the config equivalent of `# type: ignore`.
- **Rollout and rollback.** Feature flags and runtime config have an owner, a default, and a plan for removal once the flag is fully rolled out. Stale flags are dead code with a switch.
- **Validated in CI.** Config files are linted and schema-checked (YAML lint, `kubeconform`, `actionlint`, a dry run of the settings model) so syntax and type errors fail the build instead of the deploy.

## Tests: levels, coverage, gaps and TDD

*Leans on: make it work, make it right, make it fast; Fail Fast; KISS.*

Review tests for what they would catch, not for how many there are. Each level of test answers a different question, and a gap usually means a question nobody asked.

**What each level should prove**

| Level | Question it answers | What to check in review |
| --- | --- | --- |
| Unit | Does this piece of logic do the right thing for each input? | Fast, isolated from I/O, one behavior per test, no mocks of the unit's own collaborators unless they are I/O |
| Functional / integration | Do the pieces work together through real seams: database, queue, HTTP layer? | Uses a real database (a container or transactional test database), not mocks of SQLAlchemy; exercises the endpoint through the app's test client |
| End-to-end | Does the deployed system work for a whole user flow? | Few of them, covering the critical journeys only; stable selectors; no fixed sleeps; independent of each other's data |
| Acceptance | Does it do what the spec or ticket asked, in the business's terms? | Each acceptance criterion in the spec maps to at least one test, written in domain language, ideally readable by the person who wrote the criteria |

Most logic belongs in unit tests; the seams belong in integration tests; end-to-end tests are kept to the flows that would cost the most if broken. A suite that is mostly end-to-end is slow and tells you little about where a failure is.

**Coverage and gaps**

- **Coverage is a pointer, not a target.** Use branch coverage (`coverage run --branch`) rather than line coverage (Vitest and Jest report branches too), and look at the uncovered lines *in this diff*. A low number shows untested code; a high number shows nothing about assertion quality.
- **Check the assertions.** For a feature, ask what small, wrong change to the code would still pass the tests: an off-by-one, a flipped condition, a removed line. If one exists, there is a gap. Mutation testing (for example `mutmut`) automates this question for critical modules; StrykerJS does the same for TypeScript.
- **Where gaps usually are.** Error paths, boundaries (empty, one, max, max + 1), authorization negatives, concurrency and retries, time zones, migrations and backfills, and the behavior of deprecated paths that must keep working.
- **Bug fixes.** The fix comes with a test that fails without it. If the PR doesn't show that, check out the branch, revert the fix locally, and run the test.
- **Determinism.** No wall-clock time, randomness without a seed, network, ordering assumptions, or shared state. A flaky test is fixed or deleted, not retried.

**Reviewing TDD work**

Test-driven development writes a failing test first (red), the least code that makes it pass (green), then cleans up with the test as a safety net (refactor). It is "make it work, make it right" at the scale of minutes, and it suits review well, because the tests become a readable specification of what the code was meant to do.

- **Read the tests as the spec.** In a TDD change, the tests should read as a list of behaviors in the spec's language. If they read as a list of internal function calls, they were written after the code or against the implementation.
- **The history can show the cycle.** Commits that add a test, then make it pass, then refactor make the review easier. Don't require it, but where it exists, review each step against its intent.
- **Green means the least code.** TDD's "simplest thing that passes" is KISS and YAGNI enforced by the process. Code in the diff that no test drives is either untested or unnecessary; ask which.
- **The refactor step happened.** Passing tests with duplicated or awkward code means the cycle stopped at green. Ask for the cleanup now, while the tests are fresh.
- **No design damage.** TDD can push code toward too many small injected seams just to make each unit testable in isolation. Prefer testing behavior through a stable public interface; that is the classic TDD style, and it keeps tests from breaking on every refactor.
- **Acceptance tests first, where it fits.** Starting from a failing acceptance test that encodes the spec, then driving the units underneath it, keeps the change exactly as large as the spec: no more, no less.

## Test code itself: helpers, fixtures and fakes

*Leans on: KISS above all, then high cohesion, Rule of Three, explicit over implicit.*

Test code is held to a different standard from production code, and confusing the two is a common source of bad test suites. Production code is optimized for change over years; test code is optimized for being obviously correct at a glance. Nobody tests the tests, so a test must be simple enough that it can't plausibly be wrong.

**How test code differs**

|  | Production code | Test code |
| --- | --- | --- |
| Logic | Whatever the problem needs | None, ideally: no loops, conditionals or computation in a test body. A test with an `if` can pass by taking the wrong branch. |
| Duplication | Deduplicate shared knowledge | Prefer repetition that keeps each test readable on its own (DAMP: descriptive and meaningful phrases over DRY). A reader should understand a failing test without opening five helpers. |
| Abstraction | Earned by a second real use | Even more reluctant. Helpers exist to remove noise, not to share logic. |
| Expected values | Computed | Literal. `assert total == Decimal("42.50")`, not `assert total == price * qty * (1 - discount)`, which just re-implements the code under test. |
| Naming | Domain names | Names describe the scenario and outcome: `test_refund_rejected_after_30_days` |
| Reuse | Matters | Matters much less than clarity |

**Helpers, factories, builders and fakes**

- **Simple, or tested.** A test helper must be trivially correct by inspection: build an object with defaults, make one request, assert one shape. Once a helper has real logic (branching, parsing, calculation), it either gets simplified or gets its own unit tests, because a bug there makes every test that uses it lie.
- **Factories for data.** Use a factory (for example `factory_boy` or `polyfactory`, or fishery in TypeScript) or a small builder that fills valid defaults, so each test states only the fields it cares about. `make_order(status="refunded")` says what the test is about; a 20-field literal hides it.
- **Fakes over mocks.** An in-memory implementation of a `Protocol` (`InMemoryUserRepository`) is simple, reusable and behaves like the real thing. Mocks that assert call sequences couple tests to implementation.
- **Where test code lives.** Keep a helper next to the tests that use it: in the test module, or in a `conftest.py` in the same directory. Promote it to a shared location only when several distant test packages need it. The same rule as production code applies: don't scatter cohesive code for imagined reuse. And as the guide's simplicity section says, a helper used by both production code and tests stays in the production module; the test imports it from there.
- **Fakes that mirror production contracts** (an in-memory repository, a fake clock, a fake payment gateway) can live in a dedicated `testing` module or package next to the code they fake, so they evolve with the interface. These are real code and get real tests, often the same contract tests the production implementation passes.

**Fixtures**

- **Explicit and local.** A fixture's purpose should be clear from its name, and a test's setup visible from its arguments. Deep chains of fixtures depending on fixtures, defined in distant `conftest.py` files, make a test impossible to understand on its own.
- **Narrow scope by default.** Function scope unless setup is genuinely expensive. Session- or module-scoped fixtures that hold mutable state leak between tests and cause order-dependent failures.
- **No `autouse` surprises.** An `autouse` fixture changes every test in its scope invisibly. Use it only for true global hygiene (resetting a clock, isolating the environment). The same applies to global beforeEach hooks and setup files in Vitest or Jest.
- **Parametrize, don't loop.** `pytest.mark.parametrize` with readable ids gives one test per case and reports which one failed. A loop inside a test stops at the first failure and hides the rest.

**In review, ask of each test**

- Can I tell what behavior it checks from its name and body alone?
- Would it fail if that behavior broke?
- Does it check one thing, with arrange, act and assert visible?
- Does it depend on anything it doesn't show: shared state, ordering, the clock, the network?

## Documentation and Markdown

*Leans on: least astonishment, KISS, Hyrum's Law, DRY (for knowledge).*

Documentation is reviewed like an interface: for whether a reader can act on it correctly. Wrong documentation is worse than none, because it is trusted.

- **Know the reader and the kind of doc.** A tutorial, a how-to, a reference and an explanation have different jobs. A README that mixes all four serves none well. Check the doc does the one job its reader needs.
- **Accurate against the code.** Commands run as written, code samples work against the current API, configuration keys exist, and defaults match. Where possible, examples are executed in CI (doctests or a docs build that runs snippets).
- **Updated in the same PR.** A change to behavior, an endpoint, a config key or a CLI flag updates the docs in the same diff. Missing doc changes are a finding, the same as missing tests.
- **One home for each fact.** The same setup steps in three READMEs will drift apart. Link to the authoritative place instead of copying.
- **Why, not only what.** Reference docs can be generated from code; the valuable hand-written parts are the reasons, constraints and trade-offs the code can't express.
- **Docstrings and comments.** Docstrings on public APIs describe the contract without repeating type hints. Comments explain why. Both are reviewed for accuracy whenever the code next to them changes.
- **Plain and short.** Specific, scannable, with examples. Remove filler and anything a reader can't act on.
- **Public docs are contracts.** Hyrum's Law: whatever the documentation promises, users depend on. Don't document behavior you don't intend to keep.

**Markdown files**

- **Renders where it's read.** GitHub, the docs site, or an agent's context: one H1, headings in order, fenced code blocks with a language, tables that actually render.
- **Links work.** Relative links to files that exist, anchors that exist, and a link checker in CI for docs sites.
- **Linted.** markdownlint, or the project's formatter, so style isn't reviewed by hand.
- **Front matter is valid.** Where files carry YAML front matter (docs sites, skills, subagents), it parses and has the expected fields.
- **Generated sections are regenerated.** Tables of contents and API references produced by a tool aren't edited by hand.
- **Executable Markdown gets its own playbook.** Skills, commands, rules files and prompts are instructions an agent follows; review them with the agent and AI tooling playbooks, not only as prose.

## New dependencies

*Leans on: YAGNI, KISS, least privilege.*

A new package is code you didn't write, running with your application's privileges, maintained on someone else's schedule. Each one should earn its place.

- **Is it needed?** Check whether the standard library or an existing dependency already does the job. A large package pulled in for one function is usually a finding; copying a small, well-understood function with attribution can be the better trade.
- **Is it healthy?** Recent releases, responsive maintainers, a real user base, more than one maintainer for anything critical, and a license compatible with how you ship.
- **Is it safe?** No known vulnerabilities (`pip-audit`, npm audit or pnpm audit, or the CI equivalent), a name you've verified against the real project to rule out typosquatting, and an understanding of what it pulls in transitively, including install scripts that run when it's installed.
- **Is it pinned?** Exact versions in the lockfile (`uv.lock`, pnpm-lock.yaml, package-lock.json or bun.lock) for applications; sensible lower bounds in `pyproject.toml` for libraries. The lockfile diff is reviewed, not skimmed: unexpected transitive changes are worth a question.
- **Is it typed?** Ships `py.typed` or has stubs (in TypeScript, bundled types or a maintained @types package), so `mypy --strict` keeps working without blanket ignores.
- **Is it contained?** A vendor SDK is wrapped behind a narrow interface at the boundary, so swapping it later touches one module. A utility library used throughout the codebase is fine unwrapped.
- **Removals count too.** Dropping a dependency is reviewed for anything that still imports it indirectly, including plugins, entry points and scripts.

## LLM prompts

*Leans on: explicit over implicit, Parse Don't Validate, least privilege, make it work (with evidence).*

A prompt that ships in a product or pipeline is code: behavior changes when its text changes, and nothing type-checks it. Review it with the same rigor and ask for evidence that it still works.

- **Versioned and findable.** Prompts live in files in the repository, or in a prompt registry with versions, not as strings scattered through code, so changes show up as reviewable diffs.
- **Evals for every change.** A prompt or model change comes with results on a fixed set of cases, before and after. "I tried it a few times" isn't evidence, because outputs vary from run to run.
- **Clear structure.** Task and role first, then context, constraints, output format and examples. Instructions don't contradict each other, and each one is something the model can act on.
- **Untrusted input stays data.** User text, documents, web pages and tool results are clearly delimited, and nothing in them can override the instructions. Wherever outside text reaches a model that can call tools, treat prompt injection as a real threat.
- **Structured output is validated.** Output consumed by code uses structured output or tool calling with a schema, is validated (Pydantic or zod), and has a defined path for when validation fails. No regexes over free text.
- **Model and parameters pinned.** Model id, temperature and token limits are explicit, and a model upgrade is reviewed like a dependency upgrade, with evals.
- **Cost and context.** Token counts for typical inputs are known, stable content is ordered so prompt caching works, and the context isn't padded with material the task doesn't need.
- **Representative examples.** Few-shot examples cover edge cases and don't contain answers the model will copy verbatim.
- **No secrets or personal data** in prompts or examples; logged prompts and responses follow the logging playbook.

## Skills and instruction files

*Leans on: KISS, YAGNI, least privilege, high cohesion, least astonishment.*

Skills (`SKILL.md` folders), custom commands and similar instruction files are executable prompts: an agent follows them, runs their scripts and acts on the user's machine. Review them as code that happens to be written in English. The [Claude Code skills docs](https://code.claude.com/docs/en/skills) describe the format.

- **The description is the trigger.** The frontmatter `description` decides when the skill loads, and it's always in context. It says what the skill does and when to use it, key use case first, specific enough not to fire on unrelated requests and broad enough to fire on the right ones.
- **Frontmatter is exactly right.** Field names match the documentation, hyphens included. Claude Code silently ignores a field it doesn't recognize, so a typo quietly disables a setting.
- **Least privilege.** `allowed-tools` grants only what the steps need. A skill that can run arbitrary shell commands without asking needs a stated reason.
- **One job.** A skill covers one kind of task. One that tries to cover several workflows triggers unpredictably and is hard to test.
- **Concise and actionable.** Steps say what to do, in order, rather than explaining why at length. Once loaded, the body stays in context, so every line is a recurring token cost. Keep `SKILL.md` short (the Claude Code docs suggest under 500 lines) and move reference material into supporting files that load only when needed.
- **No conflicts.** Instructions don't contradict the project's rules files, other skills, or themselves, and the skill doesn't overlap an existing one so much that the choice between them is ambiguous.
- **Bundled scripts are code.** Scripts the skill runs get the full shell, Python or TypeScript review, including what they delete, what they send over the network, and what secrets they touch.
- **Deterministic where it matters.** Steps that must happen the same way every time (formatting, validation, file layout) are scripts, not prose the model may follow loosely.
- **Tested on real requests.** The skill is tried on realistic prompts, including ones that should *not* trigger it, ideally as a small eval set kept with the skill.
- **No name collisions.** Personal, project and plugin skills with the same name shadow each other; check the new name is free.

## Agent rules files and subagents

*Leans on: KISS, least astonishment, least privilege, DRY (for knowledge).*

`AGENTS.md`, `CLAUDE.md`, editor rules files and subagent definitions shape every action an agent takes in a repository. They're standing configuration for a non-deterministic collaborator, and deserve the review a CI configuration gets.

**Rules files**

- **Always loaded, always paid for.** These files are in context for every task, so every line costs tokens on every turn and competes for the model's attention. Keep them short and specific to this repository; move rarely needed detail into skills or docs that load on demand.
- **Specific and verifiable.** "Run `just test` before committing" beats "make sure code is tested". Commands are copy-pasteable and actually work.
- **Accurate.** Build, test and lint commands, paths and conventions match the repository as it is now. Stale instructions are worse than none, because the agent follows them.
- **Precedence is intended.** Nested files and other tools' rules files don't conflict. For `AGENTS.md`, the file nearest the edited code wins and an explicit user prompt overrides it ([agents.md](https://agents.md/)); check that a nested override is deliberate.
- **One source of truth.** If both `AGENTS.md` and `CLAUDE.md` exist, one imports or points to the other instead of duplicating content that will drift.
- **Guidance, not enforcement.** "Never push to main" also belongs in branch protection and permission settings. A rules file guides the agent; it doesn't guarantee anything.
- **Safe to publish.** No secrets, and nothing that would be a problem if the file were public.

**Subagents**

The [Claude Code subagents docs](https://code.claude.com/docs/en/sub-agents) describe the format; the same points apply to other tools' agent definitions.

- **The description routes work.** The main agent delegates based on `description`, so it says clearly when to use this subagent. Descriptions are always in context; keep them short and put detail in the body.
- **Tools are scoped.** List `tools` explicitly: omitting the field inherits every available tool, which is rarely right. A reviewer or researcher gets read-only tools.
- **The model fits the job.** Routine, high-volume work on a cheaper model, hard reasoning on a stronger one, chosen explicitly.
- **Self-contained prompt.** A subagent doesn't see the conversation that started it. Its system prompt plus the delegation message carry everything it needs.
- **Output contract.** It returns a summary in a defined shape, not everything it read, because its result lands in the caller's context.

## Hooks and commands

*Leans on: Fail Fast, least privilege, explicit over implicit, KISS.*

Hooks in Claude Code and Codex are commands (and, in Claude Code, HTTP calls, tools or prompts) that run automatically at points in an agent's lifecycle: before or after a tool call, when a prompt is submitted, when the agent stops. They run with your permissions and environment, without asking. Review them as production scripts with a trigger attached. References: [Claude Code hooks](https://code.claude.com/docs/en/hooks), [Codex hooks](https://learn.chatgpt.com/docs/hooks).

- **Where it lives decides who runs it.** Claude Code reads hooks from user, project (`.claude/settings.json`, committed), local, managed, plugin, and skill or subagent settings. Codex reads `hooks.json` or `[hooks]` tables in `config.toml`, at user and project level. A committed project hook runs for everyone who trusts the repository, so it gets the strictest review.
- **Narrow matchers.** The matcher selects only the tools or events the hook needs. A catch-all matcher on `PreToolUse` runs before every tool call and slows every turn.
- **Exit codes mean specific things.** In both tools, exit code `2` blocks the action on events that can block, and stderr becomes the reason. In Claude Code, any other non-zero code, including `1`, is a non-blocking error and the action proceeds. A policy hook that exits `1` enforces nothing.
- **Failures fail open.** A missing script, crash or timeout lets the action proceed by default. Hard guarantees belong in the permission system or managed settings; both tools' docs describe hooks as a guardrail, not a complete enforcement boundary.
- **Parse the input properly.** Command hooks receive the event as JSON on stdin. Parse it with `jq` or a typed script, never with `grep`, and treat the tool inputs inside it as untrusted.
- **Fast and bounded.** Default timeouts are long (600 seconds for command hooks in both tools), so a hook on a frequent event sets a short `timeout` and does little work. A slow hook makes every turn slow.
- **Quoting and paths.** Paths built from `$CLAUDE_PROJECT_DIR` or similar variables are quoted, or passed in exec form (`args`) so the shell never interprets them.
- **Output that reaches the model.** Context a hook injects, and the reasons it gives for blocking, are saved in the transcript and read by the model. Write them as plain facts, with no secrets and nothing phrased as system instructions.
- **Trust and re-review.** Codex records trust against each hook's hash, so an edited hook is skipped until someone re-trusts it; say so in the PR. Claude Code project hooks follow the workspace trust prompt.
- **The shell playbook applies** to every command a hook runs: strict mode, quoting, no secrets in arguments, idempotence.

**Commands.** In Claude Code, a file in `.claude/commands/` and a skill both create a `/name` command and work the same way, so review commands with the skills playbook. Check that arguments passed into the command are treated as data, not instructions, and that any pre-approved tools are the minimum it needs.

## Agent workflows

*Leans on: Gall's Law, Fail Fast, separation of concerns, least privilege, make it work (with evidence).*

Multi-step agent workflows (a lead agent fanning out to subagents, pipelines of model calls and tools, scheduled agent runs) are distributed systems built from non-deterministic parts. Review them like a background-job system, and then some.

- **Simplest thing first.** One agent with good tools often beats an orchestration of five. Each added agent or step needs a reason: real parallelism, a context that would otherwise overflow, or a different tool set or model.
- **Contracts between steps.** Each step's input and output is defined, ideally as a schema, and validated before the next step consumes it. Free-text handoffs are where workflows drift.
- **Self-contained handoffs.** Each subagent or step gets everything it needs in its own prompt; nothing depends on context it can't see.
- **Bounded everything.** Every loop and retry has a limit (turns, iterations, tool calls, wall time, tokens or cost), and hitting one produces a clear failure, not a silent stop.
- **Idempotent side effects.** Steps that write files, open pull requests, send messages or call external APIs are safe to re-run, through idempotency keys or a check before acting. A retried run shouldn't post twice.
- **Human checkpoints for irreversible actions.** Deploys, deletions, payments, outbound messages and merges wait for approval unless they're deliberately automated with guardrails.
- **Least privilege per step.** Each agent gets only the tools, credentials and directories its step needs; a summarizer doesn't get a shell.
- **Untrusted content stays data.** Web pages, issues, emails and files read in one step can contain instructions; they mustn't change what later steps do or which tools they call.
- **Observable.** Every run leaves a trace: prompts, tool calls, outputs, and cost and duration per step, so failures can be debugged and costs attributed.
- **Evaluated before it runs unattended.** The workflow is tested end to end on representative tasks against stated success criteria, and changes to prompts, models or tools re-run those evals.
- **Cost and concurrency limits.** Fan-out width, the model used at each step and the expected cost per run are explicit, with hard limits.

## AI-generated and AI-assisted code

*Leans on: KISS, YAGNI, reviewing code against its spec, Chesterton's Fence.*

Code written with an AI tool is held to exactly the same standard as any other code, and the author owns every line of it: they should be able to explain any part when asked. What changes is where to look, because generated code fails in characteristic ways and tends to arrive in larger diffs.

- **Scope beyond the spec.** Extra options, helpers, abstractions, fallback paths and features nobody asked for. Check the diff against the spec strictly: no more, no less.
- **Plausible but wrong APIs.** Function names, parameters and library features that look right but don't exist, are deprecated, or behave differently in the version you pin. Confirm unfamiliar calls against the docs, or Cmd+click through to the installed source.
- **Invented or unvetted packages.** A dependency name suggested by a model may not exist, or may be a malicious package registered under that name. Apply the dependencies playbook to every new import.
- **Defensive noise.** `try`/`except` around everything, redundant `None` checks, and silent fallbacks that turn failures into wrong results. Fail Fast applies.
- **Comments that narrate.** Comments restating each line, docstrings that repeat the types, and section-header comments. Ask for them to be removed.
- **Duplicates of existing code.** A new helper that reimplements something the codebase already has. Search before accepting it.
- **Inconsistency with the codebase.** Different error handling, logging, naming, typing style or async model from the surrounding code.
- **Tests bent to pass.** Weakened assertions, new `skip` or `xfail` markers, expected values copied from the output, or mocks of the code under test. Read test changes in an AI-assisted PR especially closely.
- **Unexplained removals.** Deleted guards, retries or edge-case handling with no reason given. Apply Chesterton's Fence.

An AI reviewer can be a useful first pass on any PR, catching mechanical issues before a person looks. Its findings are suggestions to weigh, and a human still owns the verdict.

---

# Part 3: Language Notes

The guide and the playbooks apply to any language. This part holds what differs between Python, TypeScript, shell (Bash and zsh) and SQL: the toolchain that enforces the mechanical rules, how packages are managed, how the principles show up in each language, and the idioms and smells specific to it. Review a diff against the guide first, then against the section for its language.

## Quick map

| Concern | Python | TypeScript | Shell (Bash, zsh) | SQL |
| --- | --- | --- | --- | --- |
| Formatter | `ruff format` | Prettier or Biome | `shfmt` | SQLFluff, or the project's formatter |
| Linter | Ruff | ESLint with typescript-eslint, or Biome | ShellCheck (not zsh) | SQLFluff; Squawk for PostgreSQL migrations |
| Type checker | mypy `--strict` or Pyright | `tsc` with `strict` | None | The database itself, via tests against a real instance |
| Tests | pytest, pytest-asyncio | Vitest or Jest; Playwright end to end | Bats | Tests against a real database (containers) |
| Packages and lockfile | uv with `uv.lock`, or pip with hashed requirements | npm, pnpm or Bun, with their lockfile | None; pin the tools the script calls | Migration tool's revision history |
| Parse at the boundary | Pydantic | zod or Valibot | Validate arguments first, `getopts` | Constraints and types on the table |
| Consumer-owned interface | `Protocol` | `interface` or `type` (structural by default) | n/a | Views or functions as a stable interface |
| Closed set | `StrEnum`, `Literal` | String literal union, `as const` | `case` | Enum type, `CHECK`, or lookup table |
| Exhaustive handling | `match` with `assert_never` | `switch` with a `never` check | `case` with a `*)` error branch | n/a |
| Value object | Frozen `dataclass` | `Readonly<...>` type | n/a | Composite type or grouped columns |
| Distinct ids | `NewType` | Branded type | n/a | Separate key types per table |
| Concurrency | `asyncio`, `TaskGroup` | Promises, `Promise.all`, `AbortSignal` | Background jobs and `wait` | Transactions and locks |
| Structured logging | structlog | pino | Messages to stderr | n/a |

## Python

### Tooling and settings

- **Ruff** for linting and formatting, configured in `pyproject.toml`. Enable rule sets deliberately (`E`, `F`, `B`, `UP`, `SIM`, `PERF`, `C4`, `PTH`, `PL`, `ANN`, and so on) and justify each ignore. Leave `PLR2004` (magic values) off or loose.
- **mypy `--strict`** (or Pyright in strict mode) in CI. Each `# type: ignore[code]` names its error code and has a reason.
- **pytest** with `pytest-asyncio` for async code, branch coverage, and a real database in integration tests.
- **pre-commit** runs the same checks locally that CI runs.
- **Python version** pinned in `pyproject.toml` (`requires-python`) and in `.python-version`, and the same in CI and the container image.

### Packages and environments: pip, uv and PyPI

- **PyPI** is the public package index. Anyone can publish to it, so a package name is not a guarantee of who wrote it.
- **`pyproject.toml`** declares the project's dependencies with version ranges. A **lockfile** pins the exact versions of everything, including transitive dependencies, so every install is identical. Applications commit a lockfile; libraries declare ranges and let applications lock.
- **uv** manages Python versions, virtual environments, dependencies and the lockfile (`uv.lock`) in one tool. `uv add` and `uv remove` edit `pyproject.toml` and the lock together; `uv sync --locked` installs from the lockfile and fails if it is out of date, while `uv sync --frozen` uses the existing lockfile without checking whether it is up to date; `uv run` runs a command in the project environment. Dependency groups keep dev, test and docs tools out of production installs.
- **pip** installs packages into the active environment. It doesn't manage a lockfile on its own; projects using pip pin with a fully resolved `requirements.txt` (from `pip-tools` or `uv pip compile`), ideally with hashes and `--require-hashes`.
- **Virtual environments** isolate each project's packages. Nothing is installed into the system Python, and `.venv` is never committed.
- **Wheels and sdists.** A wheel is a prebuilt package and installs without running code. A source distribution runs its build backend during install, which is arbitrary code on your machine.

In review:

- A change to `pyproject.toml` comes with the matching `uv.lock` change, and the lock diff contains only what the change implies. Unexpected upgrades of unrelated packages are worth a question.
- New packages go in the right group: test and lint tools aren't runtime dependencies.
- Version ranges are sensible: no unbounded `*`, no exact pins in a library's `pyproject.toml`.
- CI and Dockerfiles install from the lock (`uv sync --locked`), never with a fresh resolve.
- New dependencies get the dependencies playbook.

### Idioms

Idioms reduce astonishment because they are what a Python reader expects to see. Python usually offers several ways to do any one thing; some are idiomatic and some are transliterated from another language. Flag code that works but fights the language:

| Non-idiomatic | Idiomatic | Why it matters |
| --- | --- | --- |
| `for i in range(len(xs)): use(xs[i])` | `for x in xs:`, with `enumerate` or `zip` when you need an index or a pairing | Removes index errors and says what is iterated |
| `if x == None`, `if flag == True` | `if x is None`, `if flag` | `is` for singletons; truthiness states the intent |
| `if len(xs) == 0` | `if not xs` | Use `is None` instead when `None` and empty mean different things |
| `f = open(p)` ... `f.close()` | `with open(p) as f:` or `Path(p).read_text()` | Released on every path |
| `s += piece` in a loop | `"".join(pieces)` | Avoids quadratic copying |
| `if k in d: v = d[k]` `else: v = default` | `d.get(k, default)`, `defaultdict`, `Counter` | One lookup, no branch |
| `def f(items=[])` | `items: list[X] \| None = None`, or `field(default_factory=list)` | A mutable default is shared across calls |
| `os.path.join(a, b)` | `Path(a) / b` | Paths as objects |
| `get_name()` and `set_name()` | A plain attribute; `@property` only to compute or validate | Java-style accessors add noise without protection |
| A class of only `@staticmethod`s, or a hand-built singleton | A module of functions | Modules are already singletons |
| A tuple used as a record (`row[3]`) | `NamedTuple`, `dataclass`, `TypedDict` | Named fields are checkable |
| Hand-written `__init__`, `__repr__`, `__eq__` | `@dataclass` | Less code, fewer inconsistencies |
| `except Exception: pass` | The specific error, or `contextlib.suppress(FileNotFoundError)` when ignoring is intended | States what is ignored |
| `"%s" % x`, `"{}".format(x)` | f-strings | Except in log calls: pass fields so formatting is deferred |

Idioms can be overdone. A comprehension stops being idiomatic once it needs a second `for` and an `if` to read, and a plain loop is clearer.

When several idioms are acceptable, the one chosen should reflect how the behavior is meant to be used. A construct picked against its intent tells the reader something false:

| Choice | Use it when | The wrong pick signals |
| --- | --- | --- |
| `tuple`, `list`, `set` | A tuple is a fixed-shape record or immutable sequence; a list grows and holds one kind of thing; a set is for membership and uniqueness | A list used for membership tests, or a tuple rebuilt to "modify" it |
| `NamedTuple`, frozen `dataclass`, `TypedDict`, Pydantic model | Light immutable record; value object with behavior; dict-shaped JSON payload; parsing untrusted input | Pydantic for internal data that is already valid, or a `dict` for a stable shape |
| `@property` vs. method | A property is cheap and side-effect free; a method does work, I/O, or can fail | A property that queries the database |
| `@classmethod`, `@staticmethod`, module function | A classmethod is an alternate constructor; a module function covers almost every staticmethod | Staticmethods used as a namespace |
| Generator vs. list | A generator for large or streamed data consumed once; a list for `len`, indexing or several passes | A list built only to iterate once, or a generator consumed twice |
| `Enum` vs. `Literal` | `Enum` for a closed set with identity or behavior; `Literal` for a few strings at an API boundary | String constants compared with `==` |
| `Protocol` vs. ABC | A `Protocol` for a consumer-owned contract; an ABC for shared implementation or instantiation checks | An ABC with no shared code |
| Check first vs. `try`/`except` | `try` when the check is racy or duplicates the work; an explicit check when it is cheap and the miss is normal | `os.path.exists` followed by `open` |

### Python-specific smells

- **Mutable defaults and shared class attributes.** `def f(x=[])` and `class C: items = []` share one object across calls or instances.
- **Late-binding closures.** Lambdas created in a loop all see the loop variable's last value.
- **Naive datetimes.** `datetime.now()` without a time zone, and `datetime.utcnow()`, which returns a naive value and is deprecated since Python 3.12. Use `datetime.now(UTC)`.
- **Import-time work and hidden cycles.** Connections opened at import, and imports moved into functions or under `TYPE_CHECKING` only to dodge a circular import.
- **`assert` for validation.** Stripped under `python -O`.
- **Catching `BaseException`** or a bare `except:`, which also swallows `KeyboardInterrupt` and `SystemExit`.
- **`is` with literals.** `x is 1` or `s is "a"` compares identity, not value.
- **Blocking calls in `async def`.** `requests`, `time.sleep`, or a sync database driver inside a coroutine stalls the event loop.
- **`print` for diagnostics** in library or service code instead of logging.

## TypeScript and JavaScript

### Tooling and settings

- **`tsconfig.json` in strict mode.** `"strict": true` at minimum. `noUncheckedIndexedAccess` (indexing returns `T | undefined`), `exactOptionalPropertyTypes`, `noImplicitOverride` and `noFallthroughCasesInSwitch` catch more. Loosening any of these in a PR needs a reason.
- **ESLint with typescript-eslint's type-checked configs** (`recommended-type-checked` or `strict-type-checked`), or Biome. The rules that matter most in review: `no-floating-promises`, `no-misused-promises`, `no-explicit-any`, `switch-exhaustiveness-check`, `no-unnecessary-condition` and `consistent-type-imports`. React projects add `eslint-plugin-react-hooks` and `eslint-plugin-jsx-a11y`.
- **Prettier or Biome** for formatting, so style never reaches review.
- **Vitest or Jest** for unit and integration tests, React Testing Library for components, Playwright for end to end.
- **Node version** pinned (`.nvmrc` or `.node-version`, and `engines` in `package.json`), matching CI and the container image.

### Packages: npm, pnpm and Bun

- **The npm registry** is the public package index for JavaScript and TypeScript, used by all three tools. As with PyPI, anyone can publish, and package names can be typosquatted.
- **`package.json`** lists `dependencies` (shipped with the app), `devDependencies` (build, test and lint only) and sometimes `peerDependencies` (a library expects the host app to provide them, such as `react`). Version ranges use semver: `^1.2.3` allows minor and patch updates, `~1.2.3` patch only.
- **The lockfile** pins every installed version, transitive ones included: `package-lock.json` (npm), `pnpm-lock.yaml` (pnpm), `bun.lock` (Bun; older projects have the binary `bun.lockb`). Exactly one package manager and one lockfile per project; a PR that adds a second lockfile is a finding. The `packageManager` field in `package.json` records which tool and version the project uses.
- **npm** is bundled with Node and installs a flat `node_modules`. `npm ci` installs exactly what the lockfile says and fails if it doesn't match `package.json`.
- **pnpm** stores packages once in a content-addressed store and links them into each project. Its strict `node_modules` layout means code can only import what it declares, which surfaces missing dependencies early. Workspaces (`pnpm-workspace.yaml`) handle monorepos; `pnpm install --frozen-lockfile` is the CI install.
- **Bun** is a runtime and toolkit with a fast npm-compatible package manager. `bun install --frozen-lockfile` is the CI install. Check that the code actually runs on the runtime it will be deployed on: Node and Bun differ in places.
- **Install scripts.** Packages can run `preinstall` and `postinstall` scripts, which is arbitrary code on install. npm runs dependencies' scripts by default. pnpm (version 10 and later) doesn't run them unless the package is listed in `onlyBuiltDependencies`. Bun runs them only for trusted packages, but when a project sets no `trustedDependencies` it trusts a built-in default list of popular packages, so adding one of those can bring install-time code with no config change. Use `--ignore-scripts` (npm, pnpm, Bun) for an install that must not run any. A PR that allows a new package to run install scripts gets a closer look.
- **`package.json` scripts** (`build`, `test`, `lint`, `dev`) are the project's task runner; new scripts are reviewed like shell scripts.

In review:

- A `package.json` change comes with the matching lockfile change, made by the project's package manager, and the lock diff contains only what the change implies.
- New packages are in the right section: build and test tools in `devDependencies`, never shipped to production.
- CI and Dockerfiles install from the lockfile (`npm ci`, `pnpm install --frozen-lockfile`, `bun install --frozen-lockfile`).
- In monorepos, internal packages use the workspace protocol (`workspace:*`) and versions of shared dependencies don't diverge between packages without a reason.
- New dependencies get the dependencies playbook.

### How the principles show up

- **Parse, don't validate.** Data from outside (request bodies, `JSON.parse`, `fetch` responses, `process.env`, `localStorage`) is typed `unknown` until a schema parses it (`UserSchema.parse(data)`, with the type from `z.infer`). `JSON.parse(text) as User` is a finding: the cast is a promise the compiler can't check.
- **Make illegal states unrepresentable.** Discriminated unions instead of a bag of optional fields and booleans; an exhaustive `switch` whose `default` assigns to `never`, so adding a variant breaks the build until it's handled.
- **Explicit over implicit.** No `any`; use `unknown` and narrow. No non-null assertions (`value!`) to silence the compiler. `// @ts-expect-error` with a reason instead of `// @ts-ignore`, so it fails when the error goes away.
- **Fail fast.** No floating promises: every promise is awaited, returned, or explicitly handled. Errors in `catch` are `unknown` and narrowed before use; wrapped errors keep the original (`new Error(msg, { cause: err })`). No empty `catch` blocks.
- **Consumer-owned interfaces.** TypeScript is structural: any object with the right shape satisfies an interface, with or without `implements`. Declare the interface where it's used, narrow to what that code needs.
- **Encapsulation.** `private` is compile-time only; `#private` fields are private at runtime. `readonly`, `ReadonlyArray` and `as const` stop accidental mutation.
- **Distinct ids.** Branded types (`type UserId = string & { readonly __brand: "UserId" }`) keep a `UserId` from being passed where an `OrderId` is expected.
- **Composition over inheritance.** Same as anywhere: functions and modules first, small classes when there's state with invariants, deep class hierarchies rarely.

### Idioms

| Non-idiomatic | Idiomatic | Why it matters |
| --- | --- | --- |
| `any` | `unknown` and narrowing, or the precise type | `any` switches off checking for everything it touches |
| `JSON.parse(x) as User` | `UserSchema.parse(JSON.parse(x))` | The cast is unchecked; the schema checks at runtime |
| `enum Status { ... }` | `type Status = "active" \| "suspended"` or an `as const` object | Unions erase cleanly and need no runtime code |
| `obj!.field` | Narrow first, or handle `undefined` explicitly | `!` hides the bug it should report |
| `{ isLoading, isError, data? }` | `{ status: "loading" } \| { status: "error"; error } \| { status: "ok"; data }` | Contradictory states become impossible |
| `==` | `===` | No coercion surprises |
| `items.forEach(async (x) => ...)` | `for (const x of items) await ...`, or `await Promise.all(items.map(...))` | `forEach` doesn't wait; errors are lost |
| `for (const i in array)` | `for (const x of array)` or array methods | `for...in` iterates keys as strings, including inherited ones |
| `x as unknown as T` | Fix the types | A double cast is a type error being hidden |
| A class with only static methods | A module of functions | Modules are already namespaces |
| `new Promise` wrapping a function that already returns a promise | `await` it directly | Extra wrapper, lost errors |
| `process.env.API_KEY!` scattered through code | One module that parses `process.env` with a schema at startup | Missing configuration fails at boot, not mid-request |
| Barrel files re-exporting whole folders | Import from the module that defines the thing | Barrels slow builds, defeat tree-shaking and hide cycles |

### TypeScript-specific smells

- **Floating promises** and `async` callbacks passed where nothing awaits them (event handlers, `forEach`, `setTimeout`).
- **Types that lie.** Casts on external data, `as` to make an error go away, and generics that default to `any`.
- **Optional everything.** Props or types where every field is optional, so no caller is ever wrong and no consumer can rely on anything.
- **Duplicated types** for the same shape on the server and client, instead of one schema both sides import.
- **Mixing module systems.** CommonJS `require` and ESM `import` in the same package, or `"type"` in `package.json` that doesn't match the build output.
- **Mutating arguments** passed in by callers, including arrays sorted in place with `.sort()` (use `.toSorted()` where the runtime supports it, or copy first).
- **Dates handled by hand.** Timestamps stored as local-time strings, or month arithmetic on `Date`. Store instants as UTC ISO 8601 and use a date library for calendar math.

## Shell: Bash and zsh

Shell is the right tool for glue: running commands, moving files, short pipelines. KISS cuts both ways here. A ten-line script beats a Python program for the same job, but past roughly a hundred lines, or once a script needs data structures, JSON beyond `jq` one-liners, or careful error recovery, it should become Python or TypeScript. The shell scripts playbook is the review pass; this section is the reference.

### Tooling

- **ShellCheck** for Bash and POSIX sh. Each disabled check (`# shellcheck disable=SC2086`) has a reason next to it. ShellCheck doesn't support zsh.
- **shfmt** for consistent formatting of Bash and sh.
- **Bats** for tests of non-trivial scripts.
- **`bash -n` and `zsh -n`** parse a script without running it; useful in CI for zsh, which has no linter of ShellCheck's depth.

### Bash and zsh differences

The two look alike and behave differently in ways that bite. A script's shebang decides which rules apply, so review it against the right column.

| Behavior | Bash | zsh |
| --- | --- | --- |
| Unquoted `$var` | Split on whitespace and glob-expanded | Not split and not globbed by default (`SH_WORD_SPLIT` and `GLOB_SUBST` are off) |
| Array indexes | Start at 0 | Start at 1 by default |
| Glob with no matches | Passed through literally (unless `nullglob` or `failglob`) | Error: "no matches found" (`NOMATCH` is on) |
| `echo "a\nb"` | Prints the backslash literally | Interprets the escape |
| Strict mode | `set -euo pipefail` | `set -euo pipefail` works too; functions use `emulate -L zsh` to get predictable local options |
| Version on macOS | `/bin/bash` is 3.2, without many modern features; Homebrew bash is current | Current, and the default login shell |
| Linting | ShellCheck | No ShellCheck support; `zsh -n` and careful review |

Practical rules that hold in both: always quote expansions, use `printf` instead of `echo` for anything but fixed text, and don't write a script for one shell and run it with the other.

### Idioms

| Non-idiomatic | Idiomatic | Why it matters |
| --- | --- | --- |
| `$var`, `$@` unquoted | `"$var"`, `"$@"`, `"${arr[@]}"` | Spaces and globs in values break commands, sometimes destructively |
| `for f in $(ls *.txt)` | `for f in *.txt` (with `nullglob` in Bash) | Parsing `ls` breaks on spaces and newlines |
| `` `cmd` `` | `$(cmd)` | Nests and reads clearly |
| `[ $a == $b ]` | `[[ $a == "$b" ]]` in Bash and zsh | No word splitting inside `[[ ]]`, and fewer quoting traps |
| `echo "$data"` | `printf '%s\n' "$data"` | `echo` treats some values as options or escapes |
| `cat file \| grep x` | `grep x file` | One process, same result |
| `grep`, `sed` or `awk` over JSON | `jq` | JSON isn't line-oriented |
| `cd dir` then work | `cd dir \|\| exit 1`, or `( cd dir && ... )` | Otherwise the work runs in the wrong directory |
| Fixed temp paths (`/tmp/out.txt`) | `tmp=$(mktemp)` with `trap 'rm -f "$tmp"' EXIT` | No collisions, always cleaned up |
| `which cmd` | `command -v cmd` | Built in and reliable |
| `read line` | `IFS= read -r line` | Keeps backslashes and leading whitespace |
| `rm -rf $dir/` | `rm -rf -- "${dir:?}/"` | An empty variable no longer means `rm -rf /` |
| `local out=$(cmd)` | `local out` then `out=$(cmd)` | Combined, the exit status of `cmd` is lost |

### Shell-specific smells

- **No strict mode**, or strict mode trusted where it doesn't apply: `set -e` is ignored inside a function called from `if`, `&&` or `||`, and a pipeline without `pipefail` reports only its last command.
- **Secrets on the command line** (`curl -H "Authorization: Bearer $TOKEN"`), visible to anyone running `ps`. Pass them through files, stdin or environment variables.
- **`curl ... | sh`** without a checksum or signature check.
- **Assumed environment.** Scripts run by cron, launchd or CI get a minimal `PATH` and may not have `HOME` or your dotfiles; set what the script needs explicitly.
- **`sudo` inside a script** rather than documenting that the script needs root and failing clearly without it.
- **Long scripts without functions**, a `main`, or `--help`.

## SQL

SQL reaches review in migrations, `.sql` files, query builders and raw strings inside application code. The queries and indexes, data modeling and migrations playbooks cover the design; the SQL files playbook is the review pass; this section is the reference.

### Tooling

- **SQLFluff** lints and formats SQL for many dialects, so layout and casing never reach review.
- **Squawk** lints PostgreSQL migrations for operations that lock tables or break running code.
- **`EXPLAIN (ANALYZE, BUFFERS)`** on production-sized data is the review tool for performance. Read it for sequential scans on large tables, row estimates far from actual rows, and sorts or hashes spilling to disk.
- **Tests against a real database** (a container in CI), not mocks: a query is only verified when the database has run it.

### Idioms

| Non-idiomatic | Idiomatic | Why it matters |
| --- | --- | --- |
| String-built SQL (`f"... WHERE id = {id}"`) | Bound parameters | Injection, and plans can't be reused |
| `SELECT *` in application queries | Named columns | A new column changes results and payload size silently |
| `WHERE col = NULL` | `WHERE col IS NULL` | `= NULL` is never true |
| `NOT IN (subquery)` where the subquery can return `NULL` | `NOT EXISTS (...)` | One `NULL` makes `NOT IN` return no rows |
| `WHERE date(created_at) = '2026-11-04'` | `WHERE created_at >= '2026-11-04' AND created_at < '2026-11-05'` | A function on the column defeats its index |
| Implicit joins in `FROM a, b WHERE ...` | Explicit `JOIN ... ON` | A missing condition becomes a visible bug, not a cross join |
| `COUNT(*) > 0` to test existence | `EXISTS (...)` | Stops at the first match |
| `OFFSET` pagination on large tables | Keyset pagination (`WHERE (created_at, id) < (...)`) | Deep pages stay fast |
| `DISTINCT` to hide duplicate rows | Fix the join that produces them | Duplicates usually mean a wrong join condition |
| Long nested subqueries | Named CTEs (`WITH ...`) | Readable top to bottom |
| `UPDATE` or `DELETE` without `WHERE` in a script | An explicit `WHERE`, checked by running the matching `SELECT` first | One missing line changes every row |

### SQL-specific smells

- **Transactions left implicit** for multi-statement changes that must succeed or fail together.
- **Read-modify-write in two statements** where one atomic `UPDATE ... SET x = x + 1` or `INSERT ... ON CONFLICT` would do.
- **Hidden type casts** in comparisons (`varchar_col = 123`) that stop an index from being used.
- **Dialect-specific features** used without noting it, in code meant to run on more than one database.
- **Unbounded queries** with no `LIMIT` on tables that grow, in anything a user can trigger.
