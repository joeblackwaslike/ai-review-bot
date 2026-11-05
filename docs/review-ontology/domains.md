# Domains

A change is an operation applied to a domain. The operation is what was done to the code: moved,
renamed, deleted, reformatted, made to behave differently. The [operations/](operations/) files
define those. The domain is what the code is: an endpoint, a migration, an auth check, a test, a
config file. This file defines the domains.

Joe's [Code Review Guide and Playbooks](../Code-Review-Guide-and-Playbooks.md) already holds the
checklist for each kind of code, so this file does not repeat any of it. Every entry here adds
only what the guide lacks: how to tell from a diff that the domain is present, where the obvious
signals mislead, how each family of operations changes the amount of review the domain needs, and
what ai-review-bot can and cannot see of it today.

Three kinds of entry:

- **playbook.** One per Part 2 playbook of the guide (DOM-01 to DOM-18).
- **cross-cutting.** The four Part 1 concerns that apply to every diff but gain weight in some
  code (DOM-19 to DOM-22).
- **proposed.** Kinds of file the guide has no playbook for but that appear in real PRs (DOM-23
  to DOM-44). Each has detection notes and a sketch of what a playbook would need.

Field notes for the YAML blocks:

- `triage_weight` is how far the presence of this domain should raise review depth: more agents,
  a stronger model, more effort. It is a floor for routing, not a severity.
- `bot_visibility` is how much of what the playbook needs can be checked from the diff text alone,
  which is all the hosted bot gets. `full` means nearly all, `partial` means the shape is visible
  but the verdict needs repo or runtime context, `none` means the playbook's key questions cannot
  be answered from a diff.
- `agents_today` lists the Tier 1 and Tier 2 skills in `skills/` that plausibly cover the domain.
  "Plausibly" means the skill's focus overlaps. It does not mean the skill carries the playbook.
- Signals use `**` and `*` as glob wildcards on repo-relative paths. `content_signals` are strings
  or patterns in added or removed lines.

## Summary

| ID | Name | Kind | triage_weight |
| --- | --- | --- | --- |
| [DOM-01](#dom-01-reviewing-code-against-its-spec) | Reviewing code against its spec | playbook | medium |
| [DOM-02](#dom-02-design-specs-and-plans) | Design specs and plans | playbook | low |
| [DOM-03](#dom-03-new-api-endpoints) | New API endpoints | playbook | high |
| [DOM-04](#dom-04-endpoint-schema-changes-versioning-and-deprecation) | Endpoint schema changes, versioning and deprecation | playbook | high |
| [DOM-05](#dom-05-code-that-validates-user-input) | Code that validates user input | playbook | high |
| [DOM-06](#dom-06-authentication-and-authorization) | Authentication and authorization | playbook | critical |
| [DOM-07](#dom-07-data-modeling-tables-relationships-and-domain-objects) | Data modeling | playbook | high |
| [DOM-08](#dom-08-queries-and-indexes) | Queries and indexes | playbook | high |
| [DOM-09](#dom-09-migrations-and-deployment-sequencing) | Migrations and deployment sequencing | playbook | critical |
| [DOM-10](#dom-10-code-on-the-critical-path) | Code on the critical path | playbook | high |
| [DOM-11](#dom-11-background-jobs-queues-and-events) | Background jobs, queues and events | playbook | high |
| [DOM-12](#dom-12-logging-and-error-logging) | Logging and error logging | playbook | medium |
| [DOM-13](#dom-13-tests-levels-coverage-gaps-and-tdd) | Tests: levels, coverage, gaps and TDD | playbook | medium |
| [DOM-14](#dom-14-test-code-itself-helpers-fixtures-and-fakes) | Test code itself | playbook | low |
| [DOM-15](#dom-15-documentation) | Documentation | playbook | low |
| [DOM-16](#dom-16-configuration-files) | Configuration files | playbook | medium |
| [DOM-17](#dom-17-new-dependencies) | New dependencies | playbook | medium |
| [DOM-18](#dom-18-ai-generated-and-ai-assisted-code) | AI-generated and AI-assisted code | playbook | medium |
| [DOM-19](#dom-19-trust-boundaries) | Trust boundaries | cross-cutting | critical |
| [DOM-20](#dom-20-concurrency-and-io) | Concurrency and I/O | cross-cutting | high |
| [DOM-21](#dom-21-compatibility) | Compatibility | cross-cutting | high |
| [DOM-22](#dom-22-performance-and-observability) | Performance and observability | cross-cutting | medium |
| [DOM-23](#dom-23-frontend-and-ui-components) | Frontend and UI components | proposed | medium |
| [DOM-24](#dom-24-dockerfile-and-infrastructure-as-code) | Dockerfile and infrastructure-as-code | proposed | high |
| [DOM-25](#dom-25-shell-scripts) | Shell scripts | proposed | medium |
| [DOM-26](#dom-26-html-artifacts) | HTML artifacts | proposed | low |
| [DOM-27](#dom-27-binary-assets) | Binary assets | proposed | low |
| [DOM-28](#dom-28-llm-prompt-and-agent-instruction-files) | LLM prompt and agent-instruction files | proposed | medium |
| [DOM-29](#dom-29-outbound-service-clients-and-integrations) | Outbound service clients and integrations | proposed | high |
| [DOM-30](#dom-30-application-startup-shutdown-and-resource-ownership) | Application startup, shutdown and resource ownership | proposed | medium |
| [DOM-31](#dom-31-build-packaging-and-release-artifacts) | Build, packaging and release artifacts | proposed | medium |
| [DOM-32](#dom-32-command-line-interfaces) | Command-line interfaces | proposed | medium |
| [DOM-33](#dom-33-data-repair-backfill-import-and-export-scripts) | Data repair, backfill, import and export scripts | proposed | high |
| [DOM-34](#dom-34-browser-routing-and-url-state) | Browser routing and URL state | proposed | low |
| [DOM-35](#dom-35-serialization-and-interchange-formats) | Serialization and interchange formats | proposed | medium |
| [DOM-36](#dom-36-time-money-units-and-localization) | Time, money, units and localization | proposed | high |
| [DOM-37](#dom-37-ci-pipelines-deploy-orchestration-and-repository-automation) | CI pipelines, deploy orchestration and repository automation | proposed | high |
| [DOM-38](#dom-38-file-and-object-storage-workflows) | File and object storage workflows | proposed | medium |
| [DOM-39](#dom-39-data-retention-erasure-and-archival) | Data retention, erasure and archival | proposed | high |
| [DOM-40](#dom-40-streaming-and-long-lived-connections) | Streaming and long-lived connections | proposed | medium |
| [DOM-41](#dom-41-llm-inference-and-structured-output-handling) | LLM inference and structured-output handling | proposed | medium |
| [DOM-42](#dom-42-agent-execution-tools-and-durable-state) | Agent execution, tools and durable state | proposed | high |
| [DOM-43](#dom-43-retrieval-embeddings-and-search-indexes) | Retrieval, embeddings and search indexes | proposed | medium |
| [DOM-44](#dom-44-model-and-agent-evaluation-datasets) | Model and agent evaluation datasets | proposed | medium |

## How today's routing sees domains

Two facts apply to nearly every entry, so they are stated once here.

`classifyTier()` in `src/router.ts` raises a PR to the complex tier when any path contains
`auth`, `crypto`, `jwt`, `password`, `secret`, `/db/`, `database`, `migration` or `schema`, or
when the change is over 500 lines. That is plain substring matching on paths. It fires on
`authors.py`, on `lib/schema.ts` that holds a zod validator, and on `docs/secret-santa.md`. It
misses an Alembic file under `alembic/versions/` unless the slug contains "migration", a Drizzle
folder named `drizzle/`, `models.py`, `permissions.py`, and everything in `routes/`.

`security-auditor` (Tier 2) matches a longer substring list in `src/tier2.ts`, including `user`,
`role`, `ci`, `docker`, `deploy`, `policy` and `.env`, or a patch containing `crypto.`,
`bcrypt`, `Bearer `, `Authorization:` or `process.env.`. Short entries like `ci` and `user`
match inside other words (`decisions/`, `users_table.sql`, `specification.md`). `architect-review`
needs three path hits from its own list, an `architecture` or `breaking-change` label, or 300
changed lines across 10 files.

None of these detectors looks at file content other than the patch, and none reads the repo.

---

## DOM-01: Reviewing code against its spec

```yaml
id: DOM-01
name: Reviewing code against its spec
kind: playbook
playbook: "#reviewing-code-against-its-spec"
path_signals:
  - "docs/**/specs/**"
  - "docs/adr/**"
  - "docs/decisions/**"
  - "**/rfcs/**"
  - "openapi.{yaml,yml,json}"
content_signals:
  - "PR body links an issue, ticket id, ADR or spec path"
  - "PR body has a requirements table or acceptance criteria"
  - "commit or title prefix naming a ticket (ABC-123, #123, bd-xxx)"
agents_today: [code-reviewer]
triage_weight: medium
bot_visibility: partial
```

### Detection

This domain is present on nearly every PR, so detection is less about the diff than about the
description and the files around it. Look for a linked work item, a spec file edited in the same
PR, or a plan checked into the repo. In Python projects the spec is often an ADR under
`docs/adr/` or a design doc in `docs/`; in TypeScript repos, `docs/rfcs/`, a `.md` next to the
package, or a Linear/Jira key in the branch name. An OpenAPI file that changes alongside
handlers is a machine-readable spec and turns this domain into a diff comparison.

Look-alikes: a PR body that restates the diff ("Added X, changed Y") is a description, not a
spec. A bot-generated body (Dependabot, release-please) has no intent to check against.

### Playbook

Pull the [spec-conformance playbook](../Code-Review-Guide-and-Playbooks.md#reviewing-code-against-its-spec)
whenever a spec, ticket or plan is reachable, and say in the review when none was. Without one,
the review can only judge quality, and the review should say so.

### How operations change it

Pure refactors ([relocation](operations/relocation.md#rel-01-function-or-class-moved-between-files),
[mechanical](operations/mechanical.md)) narrow it to "does the PR say it is behavior-neutral, and
is it?". [Behavior](operations/behavior.md) changes widen it: each changed condition or default
should trace to a requirement. A deletion with no spec line behind it widens it too, because the
guide's Chesterton's Fence question has no answer yet.

### ai-review-bot today

The bot receives the PR title and body but not the linked issue, the spec file unless it is in the
diff, or any repo instruction file. `code-reviewer` can compare the diff to the description text.
Nothing fetches the spec.

---

## DOM-02: Design specs and plans

```yaml
id: DOM-02
name: Design specs and plans
kind: playbook
playbook: "#design-specs-and-plans"
path_signals:
  - "docs/**/specs/**"
  - "docs/**/plans/**"
  - "docs/superpowers/**"
  - "**/adr/**"
  - "**/rfcs/**"
  - "design*.md"
content_signals:
  - "headings such as Goals, Non-goals, Alternatives considered, Open questions, Rollout"
  - "status: draft | proposed | accepted in front matter"
agents_today: [comment-analyzer]
triage_weight: low
bot_visibility: full
```

### Detection

A Markdown file whose headings follow the spec shape (problem, goals and non-goals,
alternatives, interfaces, rollout, open questions). Path alone is weak, since teams put specs
anywhere; the headings are the stronger signal. Plans are numbered task lists with file paths and
verification commands. In an AI-assisted repo (including this one) specs and plans are committed
by agents and run to hundreds of lines.

Look-alikes: a README, runbook or how-to also lives in `docs/` but has a different job and a
different playbook ([DOM-15](#dom-15-documentation)). A changelog or release notes file is not a
spec either. A spec edited for typos is a
[mechanical](operations/mechanical.md) change and needs no design review.

### Playbook

Use the [design specs playbook](../Code-Review-Guide-and-Playbooks.md#design-specs-and-plans)
when the PR adds or substantially rewrites a spec. Review pays off most here, since a wrong boundary
costs a comment now instead of a rewrite later.

### How operations change it

A new spec is a full review. A rewrite that changes goals, interfaces or sequencing widens it.
Wording, link and formatting changes narrow it to nothing. A spec that gets a "superseded" status
should be checked against the code that still follows it.

### ai-review-bot today

A Markdown-only PR under 20 lines is routed trivial. A larger one runs the usual Tier 1 agents,
which are tuned for code, plus `comment-analyzer` (any `.md`, `.mdx`, `.rst` or `.txt` file
triggers it). No agent carries the design-spec checks, and `architect-review` fires only on its
path list, which does not include `docs/`.

---

## DOM-03: New API endpoints

```yaml
id: DOM-03
name: New API endpoints
kind: playbook
playbook: "#new-api-endpoints"
path_signals:
  - "**/routers/**"
  - "**/routes/**"
  - "**/api/**"
  - "**/views.py"
  - "**/urls.py"
  - "app/**/route.{ts,js}"
  - "pages/api/**"
  - "src/**/controllers/**"
content_signals:
  - "FastAPI: @router.get/post/put/patch/delete, @app.get, APIRouter(, Depends(, response_model=, status_code="
  - "Django REST: class *ViewSet, @api_view, path( or re_path( entries in urls.py"
  - "Express: app.get/post(, router.use(, Router()"
  - "Hono: new Hono(), app.get('/..', (c) =>"
  - "Next.js app router: export async function GET/POST/PUT/PATCH/DELETE in route.ts; middleware.ts"
  - "tRPC: publicProcedure / protectedProcedure"
  - "OpenAPI paths: entry added"
agents_today: [code-reviewer, security-sast, code-review-and-quality, architect-review, security-auditor]
triage_weight: high
bot_visibility: partial
```

### Detection

Added decorated functions in a router module, a new entry in a URL conf, a new exported HTTP
verb function in a Next.js `route.ts`, or a new `.get(` or `.post(` registration on an
Express or Hono app. The same PR usually adds a request model, a response model and a test.
Count the routes added, not the files.

Look-alikes:

- A client-side `fetch('/api/...')` or `requests.get(...)` calls an endpoint rather than defining
  one, so a path under `api/` alone proves nothing.
- A route in a test file (`app.get` on a throwaway app in a vitest setup) is test scaffolding.
- A route moved between router files with unchanged body is a
  [relocation](operations/relocation.md#rel-01-function-or-class-moved-between-files), not a new
  endpoint. Re-registering it on a different prefix is not a pure move, though, because the public
  URL changes.
- A Next.js `route.ts` that only re-exports a handler from another module still defines a public
  route.

### Playbook

Pull the [new endpoints playbook](../Code-Review-Guide-and-Playbooks.md#new-api-endpoints) for
any added route. Read request and response models before the handler body, and check auth with
[DOM-06](#dom-06-authentication-and-authorization) at the same time.

### How operations change it

Added routes are a full review. A route
[renamed](operations/relocation.md#rel-03-symbol-renamed-in-place) in code but not in its path
string is invisible to HTTP callers, but the generated OpenAPI `operationId` can derive from
the function name, so generated clients may see it. A path or method change is an
[interface](operations/interface.md) change and moves to [DOM-04](#dom-04-endpoint-schema-changes-versioning-and-deprecation).
A [deleted](operations/deletion.md) route needs a check for remaining callers, including other
services the repo cannot see.

### ai-review-bot today

The diff is visible, so decorators, models and handler bodies can be read. What is not visible is
the neighbouring routes, so "consistent with the rest of the API" and "every sibling route has the
auth dependency" cannot be checked. Router paths like `routes/` and `api/` are on
`architect-review`'s list, but it needs three matching files. The tier router does not treat
`routes/` or `api/` as sensitive.

---

## DOM-04: Endpoint schema changes, versioning and deprecation

```yaml
id: DOM-04
name: Endpoint schema changes, versioning and deprecation
kind: playbook
playbook: "#endpoint-schema-changes-versioning-and-deprecation"
path_signals:
  - "**/schemas/**"
  - "**/models/**"
  - "**/dto/**"
  - "**/types/api*"
  - "openapi.{yaml,yml,json}"
  - "**/v1/**"
  - "**/v2/**"
content_signals:
  - "Pydantic: BaseModel field added, removed, retyped, made Optional or required; extra='forbid' toggled; Literal or Enum members changed"
  - "zod: z.object({...}) keys, .optional(), .nullable(), .strict(), z.enum([...]) members"
  - "OpenAPI diff: required[] list, enum list, nullable, additionalProperties"
  - "response header or status code changed: Deprecation, Sunset, 201 to 200"
  - "version prefix in a path: /v1/ to /v2/"
agents_today: [code-reviewer, type-design-analyzer, architect-review]
triage_weight: high
bot_visibility: partial
```

### Detection

An existing request or response model changes. Pydantic fields appear and disappear in
`schemas.py`, zod objects in `*.schema.ts`, generated types in `openapi.d.ts`, or the OpenAPI
document itself. The signal that separates this domain from [DOM-03](#dom-03-new-api-endpoints)
is that the endpoint already existed at the base commit.

Look-alikes, and the router's habit of tagging them:

- `schema.ts` or `schemas.py` may hold a zod or Pydantic validator, a GraphQL schema, a DB table
  definition (Drizzle, `prisma/schema.prisma`) or a JSON Schema for config. Only the first two,
  when exposed through an endpoint, belong here. The router treats all of them as "schema" and
  routes the PR to the complex tier without telling which.
- A Pydantic model used only inside the service (a command object, an internal event) has no
  external clients yet.
- A zod schema used only to validate a form on the client is a UI contract, not an API one.
- A regenerated `openapi.json` is output, so read the source model change that produced it.

### Playbook

Use the [schema change playbook](../Code-Review-Guide-and-Playbooks.md#endpoint-schema-changes-versioning-and-deprecation)
and classify the change with its table before reading further. The verdict depends on the
classification more than on code quality.

### How operations change it

A pure [rename](operations/relocation.md#rel-03-symbol-renamed-in-place) of a model class is safe
unless the class name leaks into the OpenAPI component name or a serialized `type` field. A
renamed field is never a pure rename for clients. A
[tightened bound](operations/behavior.md) or changed default widens the domain. A
[moved](operations/relocation.md#rel-01-function-or-class-moved-between-files) model narrows it
to import and registration checks. A [removal](operations/deletion.md) of a field or model needs
the deprecation trail.

### ai-review-bot today

The bot sees the changed model but not its consumers, the previous deployed contract, or any
client usage data. It can classify an obvious breaking change from the diff (a required field
added, a field removed). It cannot confirm that a field is unused. `type-design-analyzer` fires
on `class`, `interface` and `Optional[` patterns in `.py` and `.ts` files, which is most
schema edits.

---

## DOM-05: Code that validates user input

```yaml
id: DOM-05
name: Code that validates user input
kind: playbook
playbook: "#code-that-validates-user-input"
path_signals:
  - "**/validators/**"
  - "**/validation/**"
  - "**/schemas/**"
  - "**/forms.py"
  - "**/serializers.py"
  - "**/*.schema.ts"
content_signals:
  - "Pydantic: Field(max_length=, ge=, le=, pattern=), @field_validator, @model_validator, EmailStr, strict=True"
  - "Django: forms.Form, serializers.Serializer, validate_<field>"
  - "zod: z.string().max(, .regex(, .email(), .refine(, .superRefine(, .transform(, z.coerce."
  - "hand-written re.compile / new RegExp for input checks, re.match vs re.fullmatch"
  - "file upload handling: UploadFile, multer, formidable, content-type or extension checks"
  - "URL fetching of a user-supplied value: requests.get(url), fetch(url), httpx"
agents_today: [security-sast, code-reviewer, type-design-analyzer, security-auditor]
triage_weight: high
bot_visibility: full
```

### Detection

A validator, serializer or schema changes, or a handler starts accepting a new field. In Python
look for `Field(...)` constraints, validators and `extra=` settings. In TypeScript look for zod
chains and for the places that call `.parse` or `.safeParse`. The call site matters as much as
the schema: a zod schema with no `.parse` on the request body validates nothing.

Look-alikes:

- A file named `schema.ts` that is a zod validator is in this domain, while a file named
  `schema.ts` holding Drizzle `pgTable(...)` definitions is [DOM-07](#dom-07-data-modeling-tables-relationships-and-domain-objects).
- A validator for config at startup (pydantic-settings, `z.object` over `process.env`) is
  [DOM-16](#dom-16-configuration-files), though trust is different: the input is operator-owned.
- Validation of the program's own outputs or internal DTOs is defensive code, not a boundary.
- A migrated validator with unchanged rules is a
  [relocation](operations/relocation.md#rel-01-function-or-class-moved-between-files). The
  danger is the call site that no longer runs it.

### Playbook

Use the [input validation playbook](../Code-Review-Guide-and-Playbooks.md#code-that-validates-user-input)
for any added or loosened rule, and for any new path that accepts untrusted data. Pair it with
[DOM-19](#dom-19-trust-boundaries).

### How operations change it

A changed bound, regex or `strict` flag is a [behavior](operations/behavior.md) change on a
security-relevant surface, so the full playbook applies. A
[move](operations/relocation.md#rel-01-function-or-class-moved-between-files) or
[rename](operations/relocation.md#rel-03-symbol-renamed-in-place) of a validator narrows review to
whether every caller still runs it. A [deleted](operations/deletion.md) validator or a removed
`.parse` call is the highest-risk case in this domain.

### ai-review-bot today

Patch-visible, so the bot can read regexes, bounds and parse calls. It cannot see callers outside
the diff, so "this validator is no longer used by endpoint X" goes unnoticed unless the removal is
in the PR. `security-sast` covers injection, path traversal and SSRF-style flaws.

---

## DOM-06: Authentication and authorization

```yaml
id: DOM-06
name: Authentication and authorization
kind: playbook
playbook: "#authentication-and-authorization"
path_signals:
  - "**/auth/**"
  - "**/authn/**"
  - "**/authz/**"
  - "**/permissions*"
  - "**/policies/**"
  - "**/middleware*"
  - "**/guards/**"
  - "**/session*"
  - "**/login*"
  - "**/oauth*"
  - "middleware.ts"
content_signals:
  - "FastAPI: Depends(get_current_user), Security(, OAuth2PasswordBearer, HTTPBearer"
  - "Django: @login_required, permission_classes, has_object_permission, @permission_required"
  - "JWT: jwt.decode, jose, PyJWT, jsonwebtoken, verify(, algorithms=, audience=, issuer="
  - "password hashing: bcrypt, argon2, passlib, scrypt, hashlib.sha"
  - "Express/Hono/Next: req.user, getServerSession, auth(), c.get('user'), withAuth, NextAuth, Better Auth"
  - "cookies: HttpOnly, Secure, SameSite, set_cookie"
  - "tenant scoping: tenant_id in WHERE, row-level security, policy"
  - "constant-time comparison: hmac.compare_digest, timingSafeEqual"
agents_today: [security-sast, security-auditor, code-reviewer]
triage_weight: critical
bot_visibility: partial
```

### Detection

Two kinds of diff. The first edits an auth module directly: token verification, session
handling, hashing, middleware. The second is a feature diff where one decorator or dependency is
missing, which is the dominant real-world bug and the hard one to see. For that, count routes
added or changed and compare each against the auth pattern used in sibling routes of the same
file.

Look-alikes:

- `author`, `authority`, `authorize_net` contain `auth` and trip path matching.
- `user` and `account` are in many filenames that have nothing to do with identity (a `User`
  data model, a `user_service` that handles profile text).
- A rename of `isAdmin` to `hasAdminRole` in a UI component is cosmetic. The same rename in the
  server's check is not, if any caller used the old name via a string.
- A test fixture that creates a fake token is test setup, but check it can't be used in production
  (a hardcoded secret in a shared module).

### Playbook

Use the [auth playbook](../Code-Review-Guide-and-Playbooks.md#authentication-and-authorization)
for any diff that adds a protected route, touches token or session code, or changes a query that
fetches by id. Authorization negatives in the tests are the quickest sanity check.

### How operations change it

This domain is where operations lose their usual discount. A
[relocation](operations/relocation.md#rel-01-function-or-class-moved-between-files) of an auth
check can silently drop it from the call path, so the narrowing in `relocation.md` does not
apply and every call site is verified. A [deleted](operations/deletion.md) guard or middleware
is a finding until proven otherwise. A [reformat](operations/mechanical.md) is
narrow, but a "reformat" that touches a boolean expression in a check is not a reformat.
[Interface](operations/interface.md) changes to a permission enum or role name are data
migrations too.

### ai-review-bot today

`classifyTier()` sends paths containing `auth`, `jwt`, `password`, `secret` or `crypto` to the
complex tier. `security-auditor` runs on a longer list. Neither sees the sibling routes or the
middleware chain, so a missing guard on a new route is only found if the diff includes enough
context. Paths like `permissions.py`, `policies/`, `guards/` and `middleware.ts` reach
`security-auditor` (it lists `permission`, `policy`, `guard`, `middleware`) but not the tier
router.

---

## DOM-07: Data modeling: tables, relationships and domain objects

```yaml
id: DOM-07
name: 'Data modeling: tables, relationships and domain objects'
kind: playbook
playbook: "#data-modeling-tables-relationships-and-domain-objects"
path_signals:
  - "**/models.py"
  - "**/models/**"
  - "**/entities/**"
  - "**/db/**"
  - "**/domain/**"
  - "prisma/schema.prisma"
  - "**/schema.ts"
  - "**/drizzle/schema*"
  - "**/*.entity.ts"
content_signals:
  - "SQLAlchemy: Column(, mapped_column(, relationship(, ForeignKey(, UniqueConstraint, CheckConstraint, Index("
  - "SQLModel / Django: class X(SQLModel, table=True), models.ForeignKey, models.CharField, on_delete="
  - "Prisma: model X { ... }, @relation, @@unique, @@index, @default"
  - "Drizzle: pgTable(, serial(, uuid(, references(, uniqueIndex("
  - "Kysely: Generated<, interface Database {"
  - "float or REAL used for money; timestamp without timezone; JSON or JSONB columns"
agents_today: [type-design-analyzer, code-reviewer, architect-review]
triage_weight: high
bot_visibility: partial
```

### Detection

Table and model definitions change: new columns, constraints, foreign keys, enum types, join
tables. In Python the signal is a SQLAlchemy, SQLModel or Django model class. In TypeScript it
is a Prisma `model` block or a Drizzle `pgTable` call. A model change nearly always has a
companion migration ([DOM-09](#dom-09-migrations-and-deployment-sequencing)), and a model
change with no migration is itself a finding.

Look-alikes:

- A Pydantic `BaseModel` or zod schema looks like a model but is an API or validation shape
  ([DOM-04](#dom-04-endpoint-schema-changes-versioning-and-deprecation)). Class-per-table
  and class-per-payload both live in `models.py` in many projects.
- A TypeScript `interface User` from generated Prisma or Kysely types is output, not the source.
- An in-memory dataclass in `domain/` is a domain object with no table. The playbook's
  persistence-versus-domain split applies, but no migration exists.
- Fixtures and seed data under `db/` are data, not model definitions.

### Playbook

Use the [data modeling playbook](../Code-Review-Guide-and-Playbooks.md#data-modeling-tables-relationships-and-domain-objects)
for any new table, new constraint or loosened constraint. Ask for the queries the model serves
before judging the shape.

### How operations change it

A [rename](operations/relocation.md#rel-03-symbol-renamed-in-place) of a class is not a rename
of the table unless `__tablename__` or `@@map` moves with it, and the difference decides whether
a migration is needed. A [move](operations/relocation.md#rel-01-function-or-class-moved-between-files)
of a model between modules can break string-based relationship targets and Alembic autogenerate
discovery. A [removed](operations/deletion.md) column or constraint widens the domain into
[DOM-09](#dom-09-migrations-and-deployment-sequencing).

### ai-review-bot today

`db/` and `database` paths route to the complex tier. `models.py`, `entities/` and
`prisma/schema.prisma` are caught only by the substring `schema` or by `architect-review`'s list.
`type-design-analyzer` reads class definitions but has no database context. No agent compares the
model change with the migration unless both are in the diff.

---

## DOM-08: Queries and indexes

```yaml
id: DOM-08
name: Queries and indexes
kind: playbook
playbook: "#queries-and-indexes"
path_signals:
  - "**/repositories/**"
  - "**/repository*.{py,ts}"
  - "**/queries/**"
  - "**/dao/**"
  - "**/crud.py"
  - "**/*.sql"
content_signals:
  - "SQLAlchemy: select(, .where(, .join(, .order_by(, selectinload, joinedload, lazy=, .all(), .offset("
  - "Django ORM: .filter(, .objects.all(, select_related, prefetch_related, .raw("
  - "raw SQL strings: SELECT, LIKE '%, ILIKE, ORDER BY, OFFSET"
  - "Prisma: findMany, include:, where:, $queryRaw"
  - "Drizzle / Kysely: db.select().from(, selectFrom(, .innerJoin("
  - "CREATE INDEX, Index(, @@index, index("
  - "loops containing awaits on queries or relationship attribute access"
agents_today: [code-reviewer, code-review-and-quality]
triage_weight: high
bot_visibility: partial
```

### Detection

Added or changed queries and index definitions. N+1 hides in loops, serializers and templates
where a relationship attribute is read per row, so reading the query alone is not enough: read
what happens to each result. Index changes show up as `Index(...)` in a model, `CREATE INDEX` in
a migration, or `@@index` in a Prisma file.

Look-alikes:

- `.filter(` and `.where(` also appear on in-memory lists, pandas frames and iterables. Check
  the receiver.
- A `LIKE` on a small lookup table is harmless where the same pattern on an events table is not.
  Table size is invisible in the diff.
- A query inside a test or seed script is not production load.

### Playbook

Use the [queries and indexes playbook](../Code-Review-Guide-and-Playbooks.md#queries-and-indexes)
for each new query against a table that is or will be large. The question the diff cannot answer
is how big the table is, so ask.

### How operations change it

A [moved](operations/relocation.md#rel-01-function-or-class-moved-between-files) query is narrow
unless it moved into or out of a transaction or session scope. A changed `WHERE`, `ORDER BY` or
page size is a [behavior](operations/behavior.md) change that invalidates the index reasoning. An
[inlined](operations/relocation.md#rel-07-inline-function-or-helper) repository helper can turn
one query into one per loop iteration. A [deleted](operations/deletion.md) index needs a check
that no query still relies on it.

### ai-review-bot today

No execution plan, no table sizes, no schema outside the diff. The bot can spot textbook
patterns (query in a loop, `.all()` without a limit, leading `%`). `code-reviewer` and
`code-review-and-quality` cover these as general bugs and performance notes, but no skill carries
the playbook's index and collation tables.

---

## DOM-09: Migrations and deployment sequencing

```yaml
id: DOM-09
name: Migrations and deployment sequencing
kind: playbook
playbook: "#migrations-and-deployment-sequencing"
path_signals:
  - "alembic/versions/*.py"
  - "**/migrations/**"
  - "prisma/migrations/**/migration.sql"
  - "drizzle/**/*.sql"
  - "drizzle/meta/_journal.json"
  - "**/migrations/*.{ts,js}"
  - "db/migrate/**"
  - "flyway/**"
content_signals:
  - "Alembic: revision =, down_revision =, op.add_column, op.drop_column, op.alter_column, op.create_index, op.execute"
  - "Django: migrations.Migration, AddField, RemoveField, AlterField, RunPython, RunSQL"
  - "Kysely: export async function up(db: Kysely<any>) / down(...)"
  - "Prisma/Drizzle SQL: ALTER TABLE, DROP COLUMN, CREATE INDEX (without CONCURRENTLY), NOT NULL, ADD CONSTRAINT"
  - "postgresql_concurrently=True, autocommit_block(), lock_timeout"
agents_today: [code-reviewer, architect-review]
triage_weight: critical
bot_visibility: partial
```

### Detection

A new file in a migration directory, or a change to a SQL file that the ORM tool generated. The
revision chain gives the shape: Alembic files carry `revision` and `down_revision`, Django files
a `dependencies` list, Prisma folders a timestamp prefix, Kysely files exported `up` and `down`
functions, Drizzle numbered `.sql` files plus a `meta/_journal.json`. Count the operations in
`upgrade()`, and note whether any of them rewrites a table or takes a long lock.

Look-alikes:

- A data fix script under `scripts/` that runs once looks like a migration but has no revision
  chain and no ordering guarantee.
- A "migrations" folder in a frontend repo can hold content migrations or codemods.
- An autogenerated Alembic file that is empty (`pass`) is noise to skip, but a file that
  autogenerate filled with unrelated drops is a warning that the model and database disagree.
- A squashed migration rewrites history rather than adding any.

### Playbook

Use the [migrations playbook](../Code-Review-Guide-and-Playbooks.md#migrations-and-deployment-sequencing)
for every migration. Decide first which expand, migrate or contract step this is, then check the
locking table.

### How operations change it

A migration is the one place where a "pure" operation still has consequences: renaming a column
in a model and in the migration is two coordinated changes with a deploy window between them, not
a [rename](operations/relocation.md#rel-03-symbol-renamed-in-place). A
[reformat](operations/mechanical.md) of an applied migration should be rejected, since applied
files are history. A [deleted](operations/deletion.md) migration breaks every database that has
applied it. Whether a [moved or renamed](operations/relocation.md#rel-02-file-moved-or-renamed)
migration is safe depends on the framework. Alembic identifies a revision by the `revision`
id inside the file, so a move is safe if the id is unchanged and the file is still on the
versions path. Django identifies a migration by app label and file name, so renaming the file
changes its identity and breaks every migration that depends on it.

### ai-review-bot today

`migration` in a path routes to the complex tier. Alembic's `versions/` folder is not caught
unless the slug includes the word. Migration SQL is patch-visible, so `CREATE INDEX` without
`CONCURRENTLY` and `ADD COLUMN ... NOT NULL` are catchable. Whether the table is large, whether
the code deploys before or after, and whether the revision graph has two heads are not
visible. `architect-review` lists `migration` and `schema` among its paths.

---

## DOM-10: Code on the critical path

```yaml
id: DOM-10
name: Code on the critical path
kind: playbook
playbook: "#code-on-the-critical-path"
path_signals:
  - "**/checkout/**"
  - "**/payments/**"
  - "**/billing/**"
  - "**/login/**"
  - "**/middleware*"
  - "**/hot/**"
  - "**/cache*"
content_signals:
  - "new outbound call in a handler or middleware: httpx, requests, aiohttp, fetch, axios, got, a new SDK client"
  - "retry loops, tenacity, p-retry, backoff, circuit breaker libraries"
  - "caching: lru_cache, cachetools, redis get/set, unstable_cache, next revalidate, Cache-Control"
  - "feature flags: LaunchDarkly, Unleash, Edge Config, flag checks"
  - "timeouts removed, raised or absent: timeout=, AbortSignal.timeout, asyncio.wait_for"
agents_today: [code-reviewer, code-review-and-quality, architect-review]
triage_weight: high
bot_visibility: none
```

### Detection

This domain has no file-pattern signature, because "critical" is a property of how the code is
used, not of what it is. The diff-level signals are indirect: an added network call, a lock, a
cache, a retry, or a dependency in a function that every request passes through (middleware, a
base class, a dependency-injection hook, a root layout in Next.js). Business-critical paths
(`checkout`, `payments`, `login`) are a weaker hint, since the same names appear on pages that
nobody calls often.

Look-alikes: a call added in a startup hook, a CLI command or a cron job is off the request path
and belongs to [DOM-11](#dom-11-background-jobs-queues-and-events). A call added behind a feature
flag that defaults off has a different risk profile from one that does not.

### Playbook

Pull the [critical path playbook](../Code-Review-Guide-and-Playbooks.md#code-on-the-critical-path)
when the diff adds work to a shared path, or the PR description names a latency or availability
goal. Ask for the measurement the guide asks for.

### How operations change it

A [behavior](operations/behavior.md) change on the path (new call, new retry, new cache) is the
core case. A [moved](operations/relocation.md#rel-01-function-or-class-moved-between-files)
helper can move work in or out of the path, which a diff that shows only the destination file
hides. A [deleted](operations/deletion.md) timeout, cache or guard widens the domain. A
[mechanical](operations/mechanical.md) change narrows it.

### ai-review-bot today

Invisible by construction. The bot cannot tell which functions run on every request, nor measure
latency. It can flag a call added with no timeout in the same hunk, and `code-reviewer` and
`silent-failure-hunter` will notice some swallowed-error fallbacks. `architect-review` is
advisory and caps P0 and P1 to P2.

---

## DOM-11: Background jobs, queues and events

```yaml
id: DOM-11
name: Background jobs, queues and events
kind: playbook
playbook: "#background-jobs-queues-and-events"
path_signals:
  - "**/tasks.py"
  - "**/tasks/**"
  - "**/workers/**"
  - "**/jobs/**"
  - "**/queues/**"
  - "**/consumers/**"
  - "**/events/**"
  - "**/handlers/**"
  - "**/cron/**"
  - "celery.py"
content_signals:
  - "Celery: @shared_task, @app.task, .delay(, .apply_async(, autoretry_for, acks_late, beat_schedule"
  - "Python others: arq, RQ (@job), Dramatiq (@actor), APScheduler, Kafka/SQS/Pub/Sub clients"
  - "BullMQ: new Queue(, new Worker(, queue.add(, attempts:, backoff:, removeOnComplete"
  - "QStash (this repo): publishJSON, Receiver.verify; Inngest, Trigger.dev, Temporal workflows"
  - "serverless crons: vercel.json crons, GitHub Actions schedule:"
  - "event publish after a DB commit or inside a transaction block"
agents_today: [code-reviewer, silent-failure-hunter, pr-test-analyzer]
triage_weight: high
bot_visibility: partial
```

### Detection

Added task or worker definitions, a new producer call (`.delay(`, `queue.add(`), a changed
message schema, or a new cron entry. The producer and consumer often sit in different files and
sometimes different services; look for the message shape in both. The signs of trouble are
visible in the hunk: a handler that does a write or send with no idempotency key, a `retry` with
no cap, a publish placed before `commit()`.

Look-alikes:

- `asyncio.create_task` or `BackgroundTasks` in FastAPI run in the same process and are not
  durable queues, so the retry and dead-letter questions look different.
- A `handlers/` folder in a web app often holds HTTP handlers, not event handlers.
- A cron expression in a CI workflow schedules CI, not application work.

### Playbook

Use the [background jobs playbook](../Code-Review-Guide-and-Playbooks.md#background-jobs-queues-and-events)
for any new or changed job, consumer or event schema. Read payload changes as contract changes
([DOM-21](#dom-21-compatibility)).

### How operations change it

A [renamed](operations/relocation.md#rel-03-symbol-renamed-in-place) task function is a changed
contract: Celery registers tasks by dotted name, and messages already in the queue carry the old
one. Moving a task module changes the same name. A
[deleted](operations/deletion.md) consumer strands messages. A
[behavior](operations/behavior.md) change to retry or ordering semantics is a full review. A
[reformat](operations/mechanical.md) is narrow.

### ai-review-bot today

The diff shows handler logic but not queue configuration held elsewhere, in-flight messages, or
visibility timeouts. `silent-failure-hunter` is well placed for swallowed errors in handlers.
No agent has the idempotency or outbox checks. Path hits such as `workers/` or `jobs/` are not in
the router's or the Tier 2 lists.

---

## DOM-12: Logging and error logging

```yaml
id: DOM-12
name: Logging and error logging
kind: playbook
playbook: "#logging-and-error-logging"
path_signals:
  - "**/logging*"
  - "**/logger*"
  - "**/observability/**"
  - "**/telemetry/**"
  - "**/errors/**"
  - "**/exceptions.py"
content_signals:
  - "Python: logger.info/warning/error/exception, structlog, logging.getLogger, f-string inside a log call, except ... : pass, raise ... from"
  - "TypeScript: console.log/error, pino, winston, logger.info({..}), Sentry.captureException, catch (e) { }"
  - "sensitive names in log arguments: password, token, secret, authorization, body, req.headers"
  - "metrics with high-cardinality labels: user_id, url, email"
agents_today: [silent-failure-hunter, security-sast, code-reviewer]
triage_weight: medium
bot_visibility: full
```

### Detection

Added or changed log calls and `except` or `catch` blocks. A log line is visible in the patch
along with its arguments, so leaks and format problems can be read directly. The structural
questions (log once at the boundary, correlation ids bound by middleware) need the surrounding
call stack.

Look-alikes:

- `console.log` in a CLI tool is its output, while the same call in a server is a log.
  This repo's CLI prints to stdout on purpose.
- A `print` in a test or a debugging leftover is not a logging change but is still worth a note.
- Catching an exception to convert it into a domain error is a legitimate `except` and is not
  swallowing, so look for what happens inside the block.

### Playbook

Use the [logging playbook](../Code-Review-Guide-and-Playbooks.md#logging-and-error-logging) when
the diff adds log calls on a hot path, touches error handling, or logs anything derived from a
request.

### How operations change it

Changing an event name or field is a [behavior](operations/behavior.md) change for dashboards and
alerts. A [removed](operations/deletion.md) log line or `exc_info` argument degrades diagnosis
without any test failing. A [move](operations/relocation.md#rel-01-function-or-class-moved-between-files)
can change a logger name (`logging.getLogger(__name__)`) and with it level configuration.
[Reformatting](operations/mechanical.md) a message string is narrow.

### ai-review-bot today

`silent-failure-hunter` is the Tier 1 agent built for this domain. The bot sees every log call in
the diff. It does not see the logging configuration, redaction processors, or the alert rules that
depend on event names.

---

## DOM-13: Tests: levels, coverage, gaps and TDD

```yaml
id: DOM-13
name: "Tests: levels, coverage, gaps and TDD"
kind: playbook
playbook: "#tests-levels-coverage-gaps-and-tdd"
path_signals:
  - "tests/**"
  - "**/test_*.py"
  - "**/*_test.py"
  - "**/*.test.{ts,tsx,js}"
  - "**/*.spec.{ts,tsx,js}"
  - "**/__tests__/**"
  - "e2e/**"
  - "playwright.config.*"
  - "vitest.config.*"
  - "jest.config.*"
content_signals:
  - "pytest: def test_, @pytest.mark.parametrize, @pytest.mark.skip, xfail"
  - "vitest/jest: describe(, it(, test(, expect(, it.skip, test.todo, vi.mock, jest.mock"
  - "Playwright / Cypress: page.goto, cy.visit"
  - "a source diff with no test file in the PR"
agents_today: [pr-test-analyzer]
triage_weight: medium
bot_visibility: partial
```

### Detection

Test files added or changed, or the absence of them next to a source change. For each, work out
the level: unit tests have no I/O and no app boot, integration tests use a test client with a real
database, end-to-end tests drive a browser. A diff that adds `skip`, `xfail`, `.only`, a loosened
assertion or a lowered coverage threshold is a stronger signal than a diff that adds tests.

Look-alikes:

- A file named `*.test.ts` can be a utility, and a `tests/helpers.py` can hold only fixtures
  ([DOM-14](#dom-14-test-code-itself-helpers-fixtures-and-fakes)).
- Snapshot files (`*.snap`) are generated and rarely worth reading line by line.
- A test directory used as a data folder for fixtures does not define behavior.

### Playbook

Use the [tests playbook](../Code-Review-Guide-and-Playbooks.md#tests-levels-coverage-gaps-and-tdd)
for every PR with a source change, and read test changes closely in AI-assisted PRs. For a bug
fix, check for a test that fails without the fix.

### How operations change it

A [moved](operations/relocation.md#rel-01-function-or-class-moved-between-files) function should
bring its tests and mocks with it, and a patch target string like `mock.patch("pkg.a.fn")`
silently stops patching when the function moves. A [deleted](operations/deletion.md) test is
suspect unless the code it covered went too. A [behavior](operations/behavior.md) change with no
test change is the headline gap. A [mechanical](operations/mechanical.md) change needs no new
tests.

### ai-review-bot today

`pr-test-analyzer` is the dedicated Tier 1 agent. It sees test and source hunks together, so
"source changed, tests did not" is checkable. It cannot run the suite or see coverage, and it has
no way to confirm a fix test fails without the fix. Test paths are not in the router or Tier 2
lists. The replay harness notes a limit: a gap anchored on the source line misses a claim in the
test file.

---

## DOM-14: Test code itself: helpers, fixtures and fakes

```yaml
id: DOM-14
name: "Test code itself: helpers, fixtures and fakes"
kind: playbook
playbook: "#test-code-itself-helpers-fixtures-and-fakes"
path_signals:
  - "**/conftest.py"
  - "tests/fixtures/**"
  - "tests/factories*"
  - "**/testing/**"
  - "**/test-utils/**"
  - "**/__mocks__/**"
  - "vitest.setup.*"
  - "jest.setup.*"
  - "**/fakes/**"
content_signals:
  - "pytest: @pytest.fixture, autouse=True, scope='session', factory_boy, polyfactory, monkeypatch"
  - "vitest/jest: vi.mock(, jest.mock(, beforeAll, setupFiles, vi.fn(, MSW handlers"
  - "loops or conditionals inside a test body; helper with branching logic"
  - "expected value computed from the same formula as the code under test"
agents_today: [pr-test-analyzer]
triage_weight: low
bot_visibility: full
```

### Detection

Shared test infrastructure changes: `conftest.py`, factories, fakes, setup files, `__mocks__`
directories. The effect radius is larger than the diff, since one fixture edit changes many
tests. Check scope and `autouse`.

Look-alikes: a helper under `testing/` that production code imports (a fake clock shipped in the
package) is production code with a test purpose, and the guide says it needs real tests. Mock
files generated by a tool are output.

### Playbook

Pull the [test code playbook](../Code-Review-Guide-and-Playbooks.md#test-code-itself-helpers-fixtures-and-fakes)
when a helper gains logic, a fixture's scope or autouse status changes, or a fake replaces a mock
or the reverse.

### How operations change it

A [moved](operations/relocation.md#rel-01-function-or-class-moved-between-files) fixture can
change which tests can see it (pytest resolves `conftest.py` by directory), and a moved
`vi.mock` call changes hoisting. A [deleted](operations/deletion.md) helper needs every caller
found. A change to what a shared fixture returns is a [behavior](operations/behavior.md) change
for every consumer.

### ai-review-bot today

The same agent as [DOM-13](#dom-13-tests-levels-coverage-gaps-and-tdd). The bot sees only
fixtures changed in the diff, not the tests that depend on them.

---

## DOM-15: Documentation

```yaml
id: DOM-15
name: Documentation
kind: playbook
playbook: "#documentation"
path_signals:
  - "README*"
  - "docs/**"
  - "**/*.{md,mdx,rst,txt}"
  - "CHANGELOG*"
  - "CONTRIBUTING*"
  - "mkdocs.yml"
  - "docusaurus.config.*"
content_signals:
  - "fenced code blocks with commands or config keys"
  - "docstrings changed in a source diff: triple-quoted strings, JSDoc /** */"
  - "doc text mentioning flags, endpoints or env vars that are also changed in the diff"
agents_today: [comment-analyzer]
triage_weight: low
bot_visibility: partial
```

### Detection

Markdown, reStructuredText or text files, docstrings in source diffs, and OpenAPI descriptions.
The more important signal is a mismatch: a code change that adds an env var, flag or endpoint
with no doc change, or a doc that mentions a key the diff just removed. A docs-only PR is cheap,
but a README with install commands is code in disguise.

Look-alikes:

- Specs, plans and ADRs are [DOM-02](#dom-02-design-specs-and-plans). Prompt and instruction
  files such as `AGENTS.md` and `skills/*.md` are Markdown that executes, see
  [DOM-28](#dom-28-llm-prompt-and-agent-instruction-files).
- `.txt` files include `requirements.txt` and robots files, which are dependencies and config.
- A generated API reference is output.

### Playbook

Use the [documentation playbook](../Code-Review-Guide-and-Playbooks.md#documentation) for any
docs change, and for any source change that alters something a doc describes.

### How operations change it

A [move](operations/relocation.md#rel-02-file-moved-or-renamed) of a doc breaks inbound links and
anchors, and a heading [rename](operations/relocation.md#rel-03-symbol-renamed-in-place) breaks
anchors. [Reformatting](operations/mechanical.md) a doc is narrow. A
[behavior](operations/behavior.md) change in code without a doc change is the typical finding.

### ai-review-bot today

Under 20 changed lines, all `.md`, `.txt`, `.rst` or `.mdx`, routes to the trivial tier. Any such
file triggers `comment-analyzer`. The bot cannot execute doc commands or follow links outside the
diff. The stale-doc check ("this PR changes the flag, README still says the old name") needs the
other file, which is absent unless the PR also changes it.

---

## DOM-16: Configuration files

```yaml
id: DOM-16
name: Configuration files
kind: playbook
playbook: "#configuration-files"
path_signals:
  - "pyproject.toml"
  - "ruff.toml"
  - "mypy.ini"
  - "pytest.ini"
  - "tsconfig*.json"
  - "biome.json"
  - ".eslintrc*"
  - "eslint.config.*"
  - "vercel.json"
  - "next.config.*"
  - "*.{yaml,yml,toml,ini}"
  - ".env*"
  - ".github/workflows/**"
  - ".pre-commit-config.yaml"
  - "config/**"
content_signals:
  - "pydantic-settings: BaseSettings, SettingsConfigDict, env_prefix, model_config"
  - "TypeScript env access: process.env.X, a zod parse of env, @t3-oss/env"
  - "loosened tooling: ignore =, exclude =, strict: false, noImplicitAny false, skipLibCheck, per-file-ignores"
  - "secrets-looking values: key, token, password, secret, private key headers"
  - "feature flag defaults flipped"
agents_today: [security-auditor, architect-review, code-reviewer]
triage_weight: medium
bot_visibility: partial
```

### Detection

Settings classes, config files and CI workflows. Distinguish what kind of config it is, because
the checks differ: runtime settings (env vars, flags), tooling settings (linters, type
checkers), deploy config (workflows, Vercel, Kubernetes) and secrets. A `.env.example` that gains
a real-looking value is a leak. A `strict: false` or new `ignore` entry is a loosened gate.

Look-alikes:

- `config/` in a Rails or Django repo can hold code (initializers, settings modules). Treat
  `settings.py` as code that happens to be config.
- A lockfile is not config ([DOM-17](#dom-17-new-dependencies)).
- A JSON fixture in `config/` used by tests is test data.
- `pyproject.toml` carries dependencies, tool settings and project metadata in one file, so one
  file can sit in three domains. Read which table changed (`[project]`, `[tool.ruff]`,
  `[tool.uv]`).

### Playbook

Pull the [configuration playbook](../Code-Review-Guide-and-Playbooks.md#configuration-files) for
any change to a settings model, CI workflow or tooling gate. Workflows with permissions or
secrets also fall under [DOM-24](#dom-24-dockerfile-and-infrastructure-as-code).

### How operations change it

A [renamed](operations/relocation.md#rel-03-symbol-renamed-in-place) config key is an
[interface](operations/interface.md) change for deployments that set the old one. A
[deleted](operations/deletion.md) setting needs a search for readers, including docs and
deployment repos. A [changed default](operations/behavior.md) is the typical risk. Reformatting a
YAML file is narrow, but YAML's indentation makes "formatting" changes semantically live.

### ai-review-bot today

`.env`, `config/`, `package.json` and `pyproject.toml` are on the Tier 2 lists, but only
`security-auditor` and `architect-review` look, and the second is advisory. Neither can see the
production values or the other environments' files. Lock and `.snap` files are marked generated
and packed last.

---

## DOM-17: New dependencies

```yaml
id: DOM-17
name: New dependencies
kind: playbook
playbook: "#new-dependencies"
path_signals:
  - "pyproject.toml"
  - "uv.lock"
  - "requirements*.txt"
  - "poetry.lock"
  - "Pipfile*"
  - "package.json"
  - "pnpm-lock.yaml"
  - "pnpm-workspace.yaml"
  - "package-lock.json"
  - "bun.lock"
  - "Cargo.toml"
  - "go.mod"
content_signals:
  - "[project] dependencies or [dependency-groups] entries added; [tool.uv] sources"
  - "package.json dependencies / devDependencies / peerDependencies / overrides / pnpm.overrides"
  - "git or URL dependencies, tarball URLs, file: links, patched packages"
  - "postinstall / preinstall scripts"
  - "new import of a package that appears nowhere else in the repo"
agents_today: [security-sast, security-auditor, architect-review]
triage_weight: medium
bot_visibility: partial
```

### Detection

A manifest gains an entry, or source adds an import for a package that no manifest in the diff
declares. Check both directions: an import with no declaration breaks installs, and a
declaration with no import is dead weight. For lockfiles, the manifest diff is small and the
lockfile diff is large; read the manifest and look only for surprising transitive changes in the
lockfile.

Look-alikes:

- A version bump of an existing dependency is an upgrade. Review the changelog for breaking
  changes, which is a different question from "is this package needed".
- A change under `devDependencies` or a dependency group has a smaller blast radius than a
  runtime one, though build tooling can still run arbitrary code at install.
- A monorepo workspace entry (`workspace:*`) is internal.

### Playbook

Use the [new dependencies playbook](../Code-Review-Guide-and-Playbooks.md#new-dependencies) for
each added package. Check that the package name is spelled as the real project, since AI-assisted
diffs can invent plausible names ([DOM-18](#dom-18-ai-generated-and-ai-assisted-code)).

### How operations change it

A [removed](operations/deletion.md) dependency needs a search for indirect users (plugins,
scripts, config strings). A swap of one library for another is a
[behavior](operations/behavior.md) change spread across every call site. A
[mechanical](operations/mechanical.md) reorder of the manifest is narrow.

### ai-review-bot today

`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock`, `Cargo.lock`, `poetry.lock` and
`go.sum` are classed generated and packed last. `uv.lock` is not in the list in
`src/diff-pack.ts`, so a large `uv.lock` change competes for diff budget with source files. The
bot has no registry or advisory access, so health, license, and typosquatting checks are
unavailable.

---

## DOM-18: AI-generated and AI-assisted code

```yaml
id: DOM-18
name: AI-generated and AI-assisted code
kind: playbook
playbook: "#ai-generated-and-ai-assisted-code"
path_signals:
  - "docs/superpowers/**"
  - ".cursor/**"
  - ".claude/**"
  - "AGENTS.md"
  - "CLAUDE.md"
content_signals:
  - "Co-Authored-By: Claude / Copilot / Codex, 'Generated with' trailers in commits or body"
  - "narrating comments restating the next line; section-banner comments"
  - "wide try/except or catch around everything; redundant None or undefined checks"
  - "added skip, xfail, .skip, .only, loosened assertions"
  - "very large diff with uniform style; helpers duplicating existing ones"
  - "imports of packages absent from the manifest"
agents_today: [code-reviewer, silent-failure-hunter, comment-analyzer, code-review-and-quality]
triage_weight: medium
bot_visibility: partial
```

### Detection

Authorship is rarely stated, so detect by symptoms: a commit trailer or PR body note, a size and
uniformity that suggests generation, and the characteristic defects the playbook lists (scope
beyond the spec, nonexistent APIs, defensive noise, tests bent to pass). The tell worth acting on
is a changed assertion or a new `skip` in the same PR as the code it covers.

Look-alikes: a human PR can show every one of these symptoms, and a generated one can show none.
The playbook is useful as a lens either way, so the signal selects emphasis and does not
decide whether the PR is "AI". Bot PRs (Dependabot, release-please) are machine-authored but
deterministic and are not this domain.

### Playbook

Apply the [AI-assisted code playbook](../Code-Review-Guide-and-Playbooks.md#ai-generated-and-ai-assisted-code)
as an overlay on the domains the diff touches. It points to [DOM-01](#dom-01-reviewing-code-against-its-spec),
[DOM-13](#dom-13-tests-levels-coverage-gaps-and-tdd) and [DOM-17](#dom-17-new-dependencies)
rather than adding checks of its own.

### How operations change it

Generated PRs often mix operations: a rename, a move and a behavior change in one commit. Split
them mentally ([move plus modify](operations/relocation.md#rel-10-move-plus-modify)) and review
the behavior part fully. An unexplained [deletion](operations/deletion.md) gets the Chesterton's
Fence treatment.

### ai-review-bot today

The bot has no authorship signal beyond the PR text and commit trailers it may be shown. The
Tier 1 agents already look for several playbook items (swallowed errors, test gaps). Nothing
checks that an imported API exists in the pinned version, which needs the installed package.

---

## DOM-19: Trust boundaries

```yaml
id: DOM-19
name: Trust boundaries
kind: cross-cutting
playbook: "#least-privilege-and-trust-boundaries"
path_signals:
  - "**/webhook*"
  - "**/upload*"
  - "**/auth/**"
  - "**/api/**"
  - "**/serializers/**"
  - "**/deserialize*"
  - "**/templates/**"
content_signals:
  - "SQL assembled from strings or f-strings; .raw(, text(, $queryRaw, sql.raw"
  - "subprocess with shell=True or an interpolated string; child_process.exec; os.system; eval, exec, new Function"
  - "pickle.load, yaml.load without SafeLoader, unserialize, vm.runInContext"
  - "unescaped template output: |safe, mark_safe, dangerouslySetInnerHTML, v-html, innerHTML="
  - "HTTP fetch of a user-supplied URL; open redirects; path joins from request values"
  - "webhook receivers without signature verification (hmac, timingSafeEqual)"
  - "secrets or tokens in code, logs, fixtures; broad IAM or token scopes"
agents_today: [security-sast, security-auditor, code-reviewer]
triage_weight: critical
bot_visibility: partial
```

### Detection

Find where data crosses from outside (HTTP request, webhook, file upload, queue message, CLI
argument, environment, LLM output) into code that does something with it: a query, a shell
command, a path, a template, a deserializer, a fetch. The signal is the sink, because sinks have
recognizable syntax, while sources are everywhere. Then check that the path from source to sink
passes through validation or encoding.

Look-alikes: a string-built SQL statement over constants is not injection. `eval` in a build
script over repo-owned input is a code smell and not a boundary. A webhook handler in this repo
verifies HMAC-SHA256 before parsing, and an equivalent handler elsewhere that does not is the
finding. Input from an LLM or a PR diff is untrusted too, even though it arrives through a trusted
channel.

### Playbook

Use the [least privilege and trust boundaries section](../Code-Review-Guide-and-Playbooks.md#least-privilege-and-trust-boundaries)
as the baseline for any sink hit, and pull the sharper playbooks
([validation](#dom-05-code-that-validates-user-input),
[auth](#dom-06-authentication-and-authorization),
[dependencies](#dom-17-new-dependencies)) as the diff dictates.

### How operations change it

This domain overrides the usual discounts. A
[move](operations/relocation.md#rel-01-function-or-class-moved-between-files) of a sanitizer can
leave callers unsanitized; a [removal](operations/deletion.md) of any check is a finding until
shown redundant; a [reformat](operations/mechanical.md) is narrow only if the diff tool confirms
no token changed. A [rename](operations/relocation.md#rel-03-symbol-renamed-in-place) that
makes `sanitize_html` become `clean` should be followed to see whether a second function of the
same name now shadows it.

### ai-review-bot today

`security-sast` and `security-auditor` are built for this. They see sinks in the diff, not the
callers that feed them, so source-to-sink tracing is limited to the changed files. The tier
router's path list covers `auth`, `crypto`, `jwt`, `password` and `secret` and not `webhook`,
`upload` or `templates`.

---

## DOM-20: Concurrency and I/O

```yaml
id: DOM-20
name: Concurrency and I/O
kind: cross-cutting
playbook: "#concurrency-and-io-made-explicit"
path_signals:
  - "**/async*"
  - "**/locks*"
  - "**/pool*"
  - "**/cache*"
  - "**/worker*"
content_signals:
  - "Python: async def, await, asyncio.create_task, gather, TaskGroup, run_in_executor, to_thread, threading, multiprocessing, a blocking call (requests, time.sleep, sync DB driver) inside async def"
  - "SQLAlchemy async: AsyncSession, lazy='select' relationships, missing selectinload, MissingGreenlet"
  - "read-modify-write on a row (row.x -= n; session.commit()), check-then-insert, SELECT FOR UPDATE, version columns"
  - "TypeScript: Promise.all / allSettled, unawaited promises (floating), setTimeout loops, AbortController, worker_threads"
  - "module-level mutable state, class attributes, mutable default arguments, shared caches"
  - "locks, semaphores, mapWithConcurrency-style helpers"
agents_today: [code-reviewer, silent-failure-hunter]
triage_weight: high
bot_visibility: partial
```

### Detection

Async and threading keywords, and equally their absence in a new I/O path. The common finds are
visible in one hunk: a blocking call in `async def`, a promise created and never awaited, a
shared dict mutated by two handlers, a balance updated in Python. Races between two requests are
not visible in a diff and must be inferred from the data flow.

Look-alikes: `await` in a test is plain sequencing. `Promise.all` over a list of constants is
harmless. A module-level constant dict that is never written to is not shared mutable state, but a
module-level dict used as a cache is.

### Playbook

Use the [concurrency section](../Code-Review-Guide-and-Playbooks.md#concurrency-and-io-made-explicit)
whenever the diff adds async, threads, shared state, or a read-modify-write on stored data. It
pairs with [DOM-08](#dom-08-queries-and-indexes) for the database races.

### How operations change it

[Inlining](operations/relocation.md#rel-07-inline-function-or-helper) or
[extracting](operations/relocation.md#rel-06-extract-function-or-class) code can move a call
across a lock, transaction or `await` boundary, which changes atomicity without changing a
single expression. Turning a function from sync to async is an [interface](operations/interface.md)
change for every caller. A [mechanical](operations/mechanical.md) change is narrow.

### ai-review-bot today

`code-reviewer` handles the locally visible cases. There are no tools to trace call graphs, so
whether a sync function is called from an async path is unknown unless both appear in the diff.

---

## DOM-21: Compatibility

```yaml
id: DOM-21
name: Compatibility
kind: cross-cutting
playbook: "#compatibility-hyrums-law"
path_signals:
  - "**/__init__.py"
  - "index.ts"
  - "**/public/**"
  - "package.json"
  - "openapi.*"
  - "**/events/**"
  - "CHANGELOG*"
content_signals:
  - "__all__ changed; export / export * / export type added or removed; package.json exports, main, types, bin"
  - "public function signature: parameter added, removed, reordered, default changed, return type changed"
  - "removed or renamed environment variable, config key, CLI flag, column, header, event field"
  - "changed default values, sort order, status codes, error message text"
  - "warnings.warn(..., DeprecationWarning), @deprecated, JSDoc @deprecated"
agents_today: [architect-review, type-design-analyzer, code-reviewer]
triage_weight: high
bot_visibility: partial
```

### Detection

Anything old callers or old data can observe: exported symbols, endpoint schemas, event payloads,
config keys, column names, CLI flags, sort order, error text. The key judgment is whether the
thing is public in practice. In Python that means names without a leading underscore reachable
from a package `__init__` or documented; in TypeScript, anything reachable from the `exports` map
or an `index.ts` barrel. In an application (as opposed to a library) the contract surface is its
endpoints, events and database.

Look-alikes: a signature change on a private helper whose only callers are in the diff is a
refactor. A change in a type-only export can still break consumers' builds. A renamed internal
class that appears in serialized data (pickles, `type` fields, log event names) is a breaking
rename.

### Playbook

Use the [compatibility section](../Code-Review-Guide-and-Playbooks.md#compatibility-hyrums-law)
to classify the change, then the specific playbooks:
[schema changes](#dom-04-endpoint-schema-changes-versioning-and-deprecation),
[migrations](#dom-09-migrations-and-deployment-sequencing),
[jobs and events](#dom-11-background-jobs-queues-and-events).

### How operations change it

[Interface](operations/interface.md) operations are the core of this domain. A
[move](operations/relocation.md#rel-01-function-or-class-moved-between-files) of a public symbol
is a break unless re-exported from the old path. A
[rename](operations/relocation.md#rel-03-symbol-renamed-in-place) of a public symbol is a break
unless an alias remains. [Deletion](operations/deletion.md) is the strongest form. A
[mechanical](operations/mechanical.md) change is narrow.

### ai-review-bot today

The bot cannot tell whether a symbol is public beyond the diff's own evidence (underscore,
`export` keyword, `__all__` hunks). Callers elsewhere in the repo and downstream consumers are not
visible. `architect-review` (advisory) is the only agent that frames interface boundaries.

---

## DOM-22: Performance and observability

```yaml
id: DOM-22
name: Performance and observability
kind: cross-cutting
playbook: "#performance-and-observability"
path_signals:
  - "**/benchmarks/**"
  - "**/perf/**"
  - "**/metrics*"
  - "**/tracing*"
  - "**/instrumentation*"
content_signals:
  - "queries or I/O inside loops; unbounded .all() / findMany without take; repeated JSON or regex work per item"
  - "large objects held in memory; reading whole files; no pagination"
  - "re.compile / new RegExp inside hot functions; repeated parsing"
  - "metrics, spans, counters added or removed: prometheus_client, opentelemetry, statsd, Sentry, Datadog"
  - "optimization claims in the PR text: 'faster', 'reduces latency', with or without numbers"
agents_today: [code-review-and-quality, code-reviewer]
triage_weight: medium
bot_visibility: partial
```

### Detection

Two parts: work placed badly (visible in the hunk) and signals added or lost (visible as
instrumentation calls). The first is textbook patterns: loops over queries, unbounded reads,
repeated work. The second shows in `metrics.increment`, span creation and `logger` calls. The
claim "this is faster" is a signal in itself, since the guide asks for a measurement.

Look-alikes: a loop over a fixed three-element tuple is not N+1. A comment or PR note mentioning
"performance" does not mean there is a performance change.

### Playbook

The [performance and observability section](../Code-Review-Guide-and-Playbooks.md#performance-and-observability)
is short on purpose. Go to [DOM-08](#dom-08-queries-and-indexes) and
[DOM-10](#dom-10-code-on-the-critical-path) for depth, and [DOM-12](#dom-12-logging-and-error-logging)
for the log side.

### How operations change it

[Inlining](operations/relocation.md#rel-07-inline-function-or-helper) a memoized helper, an
[extraction](operations/relocation.md#rel-06-extract-function-or-class) that moves a call into a
loop, or a [mechanical](operations/mechanical.md) change that alters evaluation order can change
cost with no semantic change. An optimization is a [behavior](operations/behavior.md) change in
cost only and needs the measurement.

### ai-review-bot today

`code-review-and-quality` covers performance as one of five axes, and it is advisory (P0 and P1
capped to P2). No agent can run a benchmark or read a profile.

---

## DOM-23: Frontend and UI components

```yaml
id: DOM-23
name: Frontend and UI components
kind: proposed
playbook: null
path_signals:
  - "**/*.{tsx,jsx,vue,svelte}"
  - "app/**/page.tsx"
  - "app/**/layout.tsx"
  - "components/**"
  - "**/*.{css,scss}"
  - "tailwind.config.*"
  - "**/*.stories.*"
  - "**/*.module.css"
content_signals:
  - "React: useState, useEffect with dependency array, useMemo, useCallback, 'use client', 'use server'"
  - "Next.js app router: server vs client component boundary, metadata exports, revalidate, cookies(), headers()"
  - "dangerouslySetInnerHTML; key props missing in lists; fetch inside useEffect"
  - "accessibility: aria-*, role=, alt=, label htmlFor, tabIndex, onClick on non-button elements"
  - "Tailwind class lists, CSS variables, media queries"
agents_today: [type-design-analyzer, code-reviewer, security-sast]
triage_weight: medium
bot_visibility: partial
```

### Detection

`.tsx`, `.jsx`, `.vue`, `.svelte` files and stylesheets. In Next.js, `page.tsx`, `layout.tsx` and
`'use client'` files mark the app-router component tree, and `route.ts` in the same folder is an
endpoint ([DOM-03](#dom-03-new-api-endpoints)). Python projects reach this domain through Jinja
or Django templates, HTMX fragments and Streamlit or Gradio apps.

Look-alikes: a `.tsx` file with no JSX (a typed utility) is plain TypeScript. A `components/`
folder in a backend repo may hold something else entirely. Storybook files and snapshot tests
are test code ([DOM-13](#dom-13-tests-levels-coverage-gaps-and-tdd)).

### What a playbook would need to cover

State and effects (dependency arrays, derived state, stale closures, effects that should be event
handlers); the server and client component boundary in Next.js (secrets or server-only imports
leaking into client bundles, serialization across the boundary); accessibility basics (semantic
elements, labels, keyboard access, focus, contrast); rendering cost (list keys, memoization only
where measured, bundle size from new imports); styling consistency with the design system; and the
XSS surface of any raw-HTML sink. Visual correctness cannot be judged from a diff, so the
playbook should say what to ask the author for (screenshots, a Storybook link) instead of
guessing.

---

## DOM-24: Dockerfile and infrastructure-as-code

```yaml
id: DOM-24
name: Dockerfile and infrastructure-as-code
kind: proposed
playbook: null
path_signals:
  - "Dockerfile*"
  - "**/Dockerfile*"
  - "docker-compose*.{yml,yaml}"
  - "compose*.{yml,yaml}"
  - "**/*.tf"
  - "**/*.tfvars"
  - "k8s/**"
  - "helm/**"
  - "charts/**"
  - ".github/workflows/**"
  - "vercel.json"
  - "pulumi*"
content_signals:
  - "Dockerfile: FROM with :latest or no digest, USER root or no USER, ADD from URL, curl | sh, COPY . ., secrets passed with ARG or ENV, apt-get without cleanup, missing .dockerignore"
  - "Compose: privileged: true, network_mode: host, ports published on 0.0.0.0, volumes mounting the Docker socket or host root"
  - "Terraform: wildcard IAM actions or resources, 0.0.0.0/0 ingress, public buckets, hardcoded credentials, removed lifecycle or deletion_protection"
  - "Kubernetes: runAsUser: 0 or runAsNonRoot unset, privileged: true, missing resource limits or probes, hostPath, latest tags, secrets in manifests"
  - "GitHub Actions: permissions: write-all, pull_request_target with checkout of PR code, actions pinned by tag instead of SHA, secrets echoed"
agents_today: [security-auditor, architect-review]
triage_weight: high
bot_visibility: partial
```

### Detection

File names do most of the work (`Dockerfile`, `*.tf`, Helm charts, compose files, workflow YAML).
Content signals then separate a harmless tweak from a change that widens access or alters
deployment. Python and TypeScript projects hit this domain as multi-stage builds, `uv` or `pnpm`
install steps in images, and CI workflows.

Look-alikes: a Dockerfile for a dev container is lower risk than the production image. A
workflow that only runs lint has a smaller blast radius than one with deploy credentials. A
`.tfvars.example` file holds placeholders. The word `deploy` in a Python module name is application
code, but today's `security-auditor` path match treats it the same.

### What a playbook would need to cover

Least privilege for IAM, network rules, container users and CI tokens; image provenance (pinned
by version or digest, minimal base, no secrets in layers or build args); reproducible builds
(lockfile install flags such as `pnpm install --frozen-lockfile`, `uv sync --locked`); CI
workflow safety (trigger choice, `pull_request_target`, SHA-pinned actions, scoped
`permissions`); blast radius and rollback of an apply (plan output, state moves, resource
replacement that destroys data); and drift between environments. The guide's configuration
playbook ([DOM-16](#dom-16-configuration-files)) covers part of it, and a dedicated playbook
should absorb the infra items.

---

## DOM-25: Shell scripts

```yaml
id: DOM-25
name: Shell scripts
kind: proposed
playbook: null
path_signals:
  - "**/*.{sh,bash,zsh}"
  - "scripts/**"
  - "bin/**"
  - ".husky/**"
  - "Makefile"
  - "justfile"
  - "**/hooks/**"
content_signals:
  - "shebang: #!/bin/sh, #!/usr/bin/env bash, #!/usr/bin/env zsh"
  - "set -euo pipefail absent; set +e; || true after meaningful commands"
  - "unquoted variable expansion; rm -rf with a variable; eval; curl | sh; sudo"
  - "backticks vs $(...); [ ] vs [[ ]] in a POSIX sh script; bashisms under #!/bin/sh"
  - "package.json scripts: entries that shell out; GitHub Actions run: blocks"
agents_today: [security-sast, code-reviewer]
triage_weight: medium
bot_visibility: full
```

### Detection

Files with a shell shebang or extension, `Makefile` recipes, git hooks, and multi-line `run:`
blocks in CI. Package scripts such as `"build": "tsc && node scripts/x.js"` are one-liners of
the same kind. Python projects often have a `scripts/` folder mixing shell and Python, so check
the shebang, not the folder.

Look-alikes: a `.sh` file that is only sourced for exports is configuration. A script under
`scripts/` written in TypeScript or Python is that language's code. Husky hook lines such as
`bd hooks run ... || true` are intentional fail-open, which is the opposite of a bug.

### What a playbook would need to cover

Strict mode and error handling (what happens on failure, exit codes, `trap` cleanup);
quoting and word splitting; portability between `sh`, `bash` and `zsh` (this repo's author runs
zsh, where an unmatched glob aborts a command); destructive commands guarded against empty
variables; idempotence on re-run; secrets in arguments and logs; and whether a shell script
should be a small program in the repo's main language instead. ShellCheck catches most of the
mechanical items, so the playbook should say to run it and spend review time on intent and blast
radius.

---

## DOM-26: HTML artifacts

```yaml
id: DOM-26
name: HTML artifacts
kind: proposed
playbook: null
path_signals:
  - "**/*.html"
  - "docs/**/*.html"
  - "artifacts/**"
  - "public/**/*.html"
  - "**/*.svg"
content_signals:
  - "single-file pages with inline <style> and <script>"
  - "external <script src=> or <link href=> from CDNs, with or without integrity="
  - "embedded data: URIs, base64 blobs, large inline JSON"
  - "inline event handlers (onclick=), eval, innerHTML assignments in inline scripts"
  - "generated output markers: <!-- generated -->, minified bundles, Storybook or coverage reports"
agents_today: [security-sast]
triage_weight: low
bot_visibility: partial
```

### Detection

Standalone `.html` files outside a framework's template directories: dashboards, explainers,
reports, exported documents. They tend to be large, to inline everything, and to be produced by
an agent or a tool. Check whether the file is generated (coverage report, docs build, exported
page) before reading it, since generated HTML is not reviewed line by line.

Look-alikes: an `index.html` that is the entry point of a Vite or Next SPA is application
shell, and belongs with [DOM-23](#dom-23-frontend-and-ui-components). A Jinja or Django
template that happens to end in `.html` is a template, with an XSS surface to check. An SVG is
markup that can carry script.

### What a playbook would need to cover

Whether the artifact is source or output; where it is served from and who can open it (public
pages need a stricter look at inline script, third-party loads and any embedded data); external
resources pinned with versions and `integrity` attributes; size, since a multi-megabyte inline
blob bloats diffs and the review budget; accessibility and responsive behavior at a glance; and
whether sensitive content (tokens, internal URLs, personal data) is embedded. A reviewer should
open the file in a browser rather than read the markup.

---

## DOM-27: Binary assets

```yaml
id: DOM-27
name: Binary assets
kind: proposed
playbook: null
path_signals:
  - "**/*.{png,jpg,jpeg,gif,webp,avif,ico}"
  - "**/*.{woff,woff2,ttf,otf}"
  - "**/*.{pdf,zip,tar,gz,whl,jar}"
  - "**/*.{mp4,mov,mp3,wav}"
  - "**/*.{db,sqlite,parquet,pkl,onnx,bin}"
  - "**/__snapshots__/**"
  - ".gitattributes"
content_signals:
  - "GitHub's files API returns no patch for binary files"
  - "'Binary files differ' in a local diff; Git LFS pointer text (version https://git-lfs.github.com/spec/v1)"
  - ".gitattributes change adding or removing LFS or linguist-generated rules"
  - "PR size dominated by one or two large files"
agents_today: []
triage_weight: low
bot_visibility: none
```

### Detection

The signal is the absence of a patch. A binary file appears in the PR file list with a status and
a size but no hunks, so the hosted bot knows the file exists and nothing about its content.
Separate the types: images and fonts are low risk; archives, wheels and executables are a supply
chain risk; databases, pickles (`.pkl`) and model files (`.onnx`, `.bin`) can contain data or
code that executes on load.

Look-alikes: an LFS pointer file is text and small, and its diff shows only a new hash. A `.svg`
is text and belongs to [DOM-26](#dom-26-html-artifacts). A large generated JSON fixture is text
but behaves like an asset.

### What a playbook would need to cover

Whether the file should be in git at all (size, LFS, a release artifact or a build output
instead); provenance and license of the asset; a pickle, archive or executable that something
will load, which is a trust-boundary matter ([DOM-19](#dom-19-trust-boundaries)); personal data or
secrets inside the file (EXIF location in photos, embedded metadata, credentials in a `.db`);
whether a replaced asset is referenced by hash or filename elsewhere; and repo growth. Most of
this is answered from the PR text and file metadata, so the playbook should tell the reviewer
what to ask for, since the bot cannot open the file.

---

## DOM-28: LLM prompt and agent-instruction files

```yaml
id: DOM-28
name: LLM prompt and agent-instruction files
kind: proposed
playbook: null
path_signals:
  - "skills/**/*.md"
  - "**/SKILL.md"
  - "AGENTS.md"
  - "CLAUDE.md"
  - "GEMINI.md"
  - ".cursor/rules/**"
  - ".cursorrules"
  - ".github/copilot-instructions.md"
  - ".claude/**"
  - "**/prompts/**"
  - "**/*.prompt.{md,txt}"
content_signals:
  - "YAML front matter with name and description (skill files)"
  - "imperative rules addressed to the model: 'always', 'never', 'you must', 'do not'"
  - "tool lists, permission allowlists, hook definitions in .claude/settings.json"
  - "template placeholders passed to a model: {{var}}, ${var}, f-string prompts in code"
  - "system prompt strings in Python or TypeScript source passed to an SDK call"
agents_today: [comment-analyzer]
triage_weight: medium
bot_visibility: partial
```

### Detection

Markdown files whose reader is a model. In this repo `skills/*.md` are the review agents' system
prompts, loaded by `buildAgentSystemPrompt()`, so a change to them changes the bot's behavior as
much as a code change does. `AGENTS.md`, `CLAUDE.md` and `.cursor/rules` do the same for coding
agents. Prompts also live inside source as string constants and template literals.

Look-alikes: a README that talks about prompts is documentation
([DOM-15](#dom-15-documentation)). A spec for a skill is [DOM-02](#dom-02-design-specs-and-plans).
`skills/code-review-excellence/SKILL.md` in this repo is a source document that the runtime does
not load, so editing it changes nothing at runtime. A file listed here may or may not be loaded
by the product, so check the loader.

### What a playbook would need to cover

Because the file executes, review it as behavior: is each rule testable by a scenario that fails
without it; do rules conflict with others in the same or a parent file; is an added rule scoped
to the cases that justified it or does it generalize from one incident; does it duplicate a
rule elsewhere; do loaded files stay within the context budget; do permission and hook entries
widen what an agent may run (a trust-boundary question, [DOM-19](#dom-19-trust-boundaries)); and
for a prompt that processes untrusted text, is there injection exposure (a diff, an issue body or
a web page flowing into the prompt). The playbook should also say what evidence to ask for, such
as a before and after run on a fixture, since a diff of prose cannot show whether behavior
improved. Today `comment-analyzer` fires only because the files are `.md`, and it judges comments
and docs, not instruction quality.

## DOM-29: Outbound service clients and integrations

```yaml
id: DOM-29
name: Outbound service clients and integrations
kind: proposed
playbook: null
path_signals:
  - "**/clients/**"
  - "**/integrations/**"
  - "**/providers/**"
  - "**/sdk/**"
  - "**/*{client,gateway,adapter}.{py,ts}"
  - "**/webhooks/**"
content_signals:
  - 'Python: httpx.AsyncClient, requests.Session, aiohttp.ClientSession, boto3.client, stripe., openai.OpenAI(), tenacity or backoff decorators'
  - 'TypeScript: fetch(, axios.create, ky, got, new Octokit, new Stripe(, Authorization header construction, refresh-token handlers'
  - 'pagination loops: next_page, nextPageToken, cursor, Link header, while has_more'
  - 'API version pins: Stripe-Version, anthropic-version, /v1/ vs /v2/ in a base URL, apiVersion options'
  - 'error mapping: catch blocks that turn provider status codes into domain errors; response.json() with no status check'
agents_today: [silent-failure-hunter, security-sast, code-reviewer]
triage_weight: high
bot_visibility: partial
```

### Detection

Code that calls a service the team does not own: payments, email, identity, storage, a model
provider, another team's API. In Python the shape is a client class wrapping `httpx` or an SDK. In
TypeScript it is a module that builds a `fetch` or `axios` instance with a base URL and an auth
header. Wrapper modules named `client`, `gateway` or `adapter` are the usual home, and a changed
mapping from provider errors to domain errors is the strongest signal.

Look-alikes: a service-to-service call inside one monorepo with a shared typed contract is closer
to [DOM-03](#dom-03-new-api-endpoints) seen from the caller's side. A test double that fakes a
provider is test code ([DOM-14](#dom-14-test-code-itself-helpers-fixtures-and-fakes)). A webhook
receiver is inbound and belongs with [DOM-19](#dom-19-trust-boundaries).

### What a playbook would need to cover

What the provider's error envelope contains (a 200 with an error body, a 429 with `Retry-After`, a
5xx with a partial result) and whether the client maps each case instead of raising one generic
exception. Pagination that stops on the first empty page or never terminates. Credential refresh
races when two requests find the token expired at once. The API version, pinned or left to the
provider's default. The ambiguous outcome of a write that timed out: the provider may have applied
it, so a retry needs an idempotency key ([BEH-07](operations/behavior.md#beh-07-retry-or-timeout-change)).
The provider's current docs decide most of this, so the playbook should say to read them instead of
trusting the client's author. Removed handling is a separate risk
([DEL-05](operations/deletion.md#del-05-retry-fallback-timeout-or-error-handling-removed)).

---

## DOM-30: Application startup, shutdown and resource ownership

```yaml
id: DOM-30
name: Application startup, shutdown and resource ownership
kind: proposed
playbook: null
path_signals:
  - "**/main.{py,ts}"
  - "**/app.{py,ts}"
  - "**/server.{py,ts}"
  - "**/lifespan*"
  - "**/bootstrap*"
  - "**/container*"
  - "instrumentation.ts"
content_signals:
  - 'Python: FastAPI lifespan, on_event startup and shutdown, atexit.register, signal.signal, create_engine or a pool created at import time, asyncio.create_task without a stored reference'
  - 'TypeScript: process.on SIGTERM handlers, server.close, new PrismaClient() or new Pool( at module scope, global singletons for hot reload, Next.js instrumentation register()'
  - 'subprocess.Popen, child_process.spawn, worker threads or pools opened without a matching close'
  - 'module-level side effects: network calls, file reads or env validation that run on import'
  - 'serverless handlers that create a client inside the handler or outside it'
agents_today: [code-reviewer, silent-failure-hunter, architect-review]
triage_weight: medium
bot_visibility: partial
```

### Detection

The code that decides when things come into being and who closes them: app factories, lifespan
hooks, signal handlers, dependency containers, and module-level objects holding connections. A diff
that adds a pool, a session, a subprocess or a background task creates an ownership question even
when no startup file changes, because the new resource needs an owner somewhere.

Look-alikes: a function-scoped `with` block that closes its own resource is local and fine. A
`Depends()` dependency that yields lives for one request, which is a different lifetime from an
application-scoped client. In serverless TypeScript, module scope is reused across invocations and
handler scope is not, so the same line means different things by platform.

### What a playbook would need to cover

Whether each resource is created once in the right scope (process, request, test) and not once per
import. What gets cleaned up when startup fails halfway, such as a pool opened before a migration
check that then raises. Shutdown order, so a consumer stops before the pool it writes to closes.
Draining in-flight requests and tasks on `SIGTERM` within the platform's grace period. Who owns a
resource that is passed around, since two closers produce double-close errors and zero closers
produce leaks. Import-time side effects get their own question because they also run in tests and
tooling. A change to when work runs is closer to [BEH-10](operations/behavior.md) than to a plain
edit, and concurrency inside shutdown is covered by [DOM-20](#dom-20-concurrency-and-io).

---

## DOM-31: Build, packaging and release artifacts

```yaml
id: DOM-31
name: Build, packaging and release artifacts
kind: proposed
playbook: null
path_signals:
  - "pyproject.toml"
  - "setup.{py,cfg}"
  - "MANIFEST.in"
  - "package.json"
  - "tsconfig*.json"
  - "tsup.config.*"
  - "vite.config.*"
  - ".npmignore"
  - ".changeset/**"
  - "release-please*"
content_signals:
  - 'package.json fields: exports, main, module, types, bin, files, sideEffects, type'
  - 'pyproject.toml fields: [project.scripts], package-data settings, [build-system], requires-python, optional-dependencies'
  - 'build output paths: dist/, build/, *.d.ts, *.map, py.typed'
  - 'a data file, template or migration read at runtime that is not listed in the package manifest'
  - 'version bumps, prepublish scripts, publish workflows, provenance flags'
agents_today: [code-reviewer, architect-review]
triage_weight: medium
bot_visibility: partial
```

### Detection

Manifest and build-config files, plus any change that moves a file read at runtime. The diff rarely
shows the artifact, only the recipe, so the signal is a recipe edit: a new `exports` entry, a
renamed entry point, a `files` allowlist change, a new directory of non-code data. In Python, look
for `importlib.resources` or `open(Path(__file__).parent / ...)` on a file that is not declared as
package data.

Look-alikes: a `package.json` edit that only changes a dev dependency belongs to
[DOM-17](#dom-17-new-dependencies) or to lockfile churn
([MEC-08](operations/mechanical.md#mec-08-lockfile-only-churn)). A `tsconfig` change that only
affects editor behavior does not change the published output. An application that is deployed, not
published, has no consumers of its `exports`.

### What a playbook would need to cover

Whether the built package works when installed somewhere else, not only from the checkout: data
files and templates present, both the ESM and CJS entry points resolving with matching `.d.ts`
files, `bin` and `[project.scripts]` entries pointing at real functions, a `py.typed` marker
included. A clean-install smoke test in CI answers most of this, and the playbook should ask for
it. Also whether the artifact leaks anything (source maps with embedded source, `.env` files, test
fixtures, credentials swept in by a loose `files` allowlist), and whether the version bump matches
the change ([IFC-08](operations/interface.md#ifc-08-export-surface-added-or-removed)). The release
workflow itself is covered by [DOM-37](#dom-37-ci-pipelines-deploy-orchestration-and-repository-automation).

---

## DOM-32: Command-line interfaces

```yaml
id: DOM-32
name: Command-line interfaces
kind: proposed
playbook: null
path_signals:
  - "**/cli.{py,ts}"
  - "**/cli/**"
  - "**/commands/**"
  - "**/__main__.py"
  - "bin/**"
content_signals:
  - 'Python: argparse, click, typer, sys.argv, sys.exit, input(), getpass, print(file=sys.stderr)'
  - 'TypeScript: commander, yargs, cac, process.argv, process.exit, process.stdin, process.stdout.isTTY, readline'
  - 'flags named --force, --yes, --dry-run, --json, --quiet, --no-color'
  - 'exit codes: sys.exit(1), process.exitCode, a command that prints an error and still exits 0'
  - 'destructive operations whose default is to proceed'
agents_today: [code-reviewer, silent-failure-hunter]
triage_weight: medium
bot_visibility: full
```

### Detection

Argument parsing, command registration, and the `main` function that turns exceptions into exit
codes. This repo's own `ai-review` command (`src/cli.ts`) is an example, with `--json`, `--dry-run`
and non-zero exits that other tools read. Anything that scripts or CI call is an interface, and its
flags and exit codes are a contract ([IFC-01](operations/interface.md#ifc-01-function-signature-changed)).

Look-alikes: a function a script imports directly is a library API, not a CLI. A `package.json`
script entry is a shell one-liner ([DOM-25](#dom-25-shell-scripts)). An interactive TUI has the
same parsing concerns plus terminal handling.

### What a playbook would need to cover

Option parsing edge cases (repeated flags, `--` separators, values that start with a dash, defaults
and env var overrides). Behavior when stdin is piped, absent or a TTY, since a prompt that waits
for input hangs a CI job. Result on stdout and diagnostics on stderr, so `| jq` works.
Machine-readable output that stays stable and reports errors in the same shape. Exit codes that
tell success, failure and "found findings" apart. Destructive commands that need a dry run or a
confirmation, with a preview that matches what the real run does. A renamed flag or a changed
default breaks callers ([IFC-04](operations/interface.md#ifc-04-default-value-changed)), so the
playbook should ask who calls the command.

---

## DOM-33: Data repair, backfill, import and export scripts

```yaml
id: DOM-33
name: Data repair, backfill, import and export scripts
kind: proposed
playbook: null
path_signals:
  - "scripts/**"
  - "**/backfill*"
  - "**/repair*"
  - "**/fixup*"
  - "**/import*"
  - "**/export*"
  - "**/management/commands/**"
  - "**/seeds/**"
content_signals:
  - 'SQL or ORM bulk writes: UPDATE with a hand-built WHERE, bulk_update, executemany, updateMany, deleteMany, INSERT ... SELECT'
  - 'batching and cursors: OFFSET paging while rows change, last_id checkpoints, keyset pagination, chunk size constants'
  - 'dry-run flags and logs that print counts'
  - 'CSV, JSONL or Parquet readers and writers handling external files'
  - 'one-off scripts with a date or ticket id in the filename'
agents_today: [code-reviewer, silent-failure-hunter, security-sast]
triage_weight: high
bot_visibility: partial
```

### Detection

One-off or rarely run code that writes to production data outside the normal request path. The
file is usually a script, a Django management command, or a notebook, and it tends to get less
review than the schema change it accompanies. The strongest signal is a bulk write with a
hand-built `WHERE` clause.

Look-alikes: the data-moving step of a schema migration belongs to
[DOM-09](#dom-09-migrations-and-deployment-sequencing) and runs under its ordering rules. A
recurring job is [DOM-11](#dom-11-background-jobs-queues-and-events). A seed file for tests is
fixture data.

### What a playbook would need to cover

Whether the script is safe to stop and start again: batches with a stable cursor (keyset on the
primary key, not `OFFSET` over rows the script is changing), a checkpoint that survives a crash,
and writes that are idempotent on a re-run. Whether the dry run uses the same selection code as the
real run and reports the same counts. Whether it holds locks or transaction time across a large
table. Whether reconciliation totals (rows read, changed, skipped, failed) are printed and compared
with an independent count. How a wrong run is undone, which means a backup or audit table before
the first write. Replica lag, triggers and downstream events fired by bulk writes
([IFC-06](operations/interface.md#ifc-06-event-or-message-payload-changed)) and the scope of the
filter (a missing tenant clause) are the usual surprises. Ask too whether the script should be
deleted after it runs.

---

## DOM-34: Browser routing and URL state

```yaml
id: DOM-34
name: Browser routing and URL state
kind: proposed
playbook: null
path_signals:
  - "app/**/page.tsx"
  - "app/**/layout.tsx"
  - "pages/**"
  - "**/routes/**"
  - "**/router.{ts,tsx}"
  - "middleware.ts"
  - "**/*.routes.*"
content_signals:
  - 'React Router, TanStack Router and Next.js: useRouter, useSearchParams, usePathname, redirect(, router.push, router.replace, notFound()'
  - 'URL state: URLSearchParams, query string parsing, filter or sort state serialized into the URL'
  - 'route definitions: dynamic segments [id], catch-all [...slug], nested layouts, route groups, rewrites and redirects in next.config'
  - 'history API: history.pushState, popstate listeners, scroll restoration'
  - 'Python server-rendered apps: url_for, redirect(), Flask or Django URL patterns that mirror client routes'
agents_today: [code-reviewer]
triage_weight: low
bot_visibility: partial
```

### Detection

Route files, the router configuration, and components that read or write the address bar. In
Next.js the file tree is the route table, so a moved or renamed `page.tsx` changes a public URL
([REL-02](operations/relocation.md#rel-02-file-moved-or-renamed)). In Python-served frontends the
equivalent is the URL pattern list and `redirect` calls.

Look-alikes: a component that calls `router.push` is UI code
([DOM-23](#dom-23-frontend-and-ui-components)) unless the route structure or the URL contract
changes. An API route (`route.ts`) is an endpoint ([DOM-03](#dom-03-new-api-endpoints)). Internal
state kept in `useState` does not need to survive a refresh.

### What a playbook would need to cover

Whether a page works on direct entry and refresh, not only when reached by clicking. Back and
forward behavior: a `replace` where a `push` was needed leaves no history, and the opposite traps
the user. A round trip of state through the query string (parse then serialize returns the same
value, with unknown and repeated parameters and encoded characters). Nested route precedence and
catch-all shadowing. Redirect loops between auth and landing routes. Old URLs that were bookmarked
or emailed and now return 404. Middleware or server redirects interact with client routing, so the
playbook should say to test the pair. Most of this needs a running browser, so ask the author for
a recording or a test.

---

## DOM-35: Serialization and interchange formats

```yaml
id: DOM-35
name: Serialization and interchange formats
kind: proposed
playbook: null
path_signals:
  - "**/serializers/**"
  - "**/schemas/**"
  - "**/codecs/**"
  - "**/*.{proto,avsc,thrift}"
  - "**/fixtures/**"
  - "**/testdata/**"
content_signals:
  - 'Python: json.dumps and json.loads options, default= handlers, model_dump, model_validate, pickle, orjson, datetime.isoformat, Decimal, bytes decoding'
  - 'TypeScript: JSON.stringify and JSON.parse with replacers or revivers, BigInt, Date serialization, toJSON, structuredClone, Buffer to string'
  - 'optional fields: exclude_none, exclude_unset, undefined vs null, nullable vs optional'
  - 'encodings and canonical forms: utf-8, base64, sort_keys, signed or hashed payloads'
  - 'numeric fields near 2**53 or monetary values passed as floats'
agents_today: [type-design-analyzer, code-reviewer]
triage_weight: medium
bot_visibility: partial
```

### Detection

Code that turns in-memory values into bytes or text and back, at a boundary that outlives one
process: stored rows, queue messages, files, HTTP bodies, cache entries, signed tokens. The diff
shows an encoder or decoder change, a model field switching between required and optional, or a
type that gains a new serialized form. The payload shape itself is
[IFC-06](operations/interface.md#ifc-06-event-or-message-payload-changed).

Look-alikes: a Pydantic model used inside one function is a data class, not an interchange format.
A schema for an HTTP API is covered by
[DOM-04](#dom-04-endpoint-schema-changes-versioning-and-deprecation), and this entry adds the
encoding layer under it.

### What a playbook would need to cover

Round trips: whether `decode(encode(x))` equals `x` for edge values. The recurring mismatches are
null versus absent (a PATCH body that cannot say "clear this field"), integers above 2**53 that
Python keeps exact and JavaScript rounds, `Decimal` against float for money, timezone-naive
datetimes, and bytes that are not valid UTF-8. Whether output is canonical when something hashes or
signs it (key order, whitespace, number formatting). Whether old stored records still decode after
the change, and whether new records still decode on the old version during a rollout
([DOM-21](#dom-21-compatibility)). Whether untrusted input reaches a decoder that can run code
(`pickle`, `yaml.load`). Tests should include a fixture of a record written by the old version.

---

## DOM-36: Time, money, units and localization

```yaml
id: DOM-36
name: Time, money, units and localization
kind: proposed
playbook: null
path_signals:
  - "**/billing/**"
  - "**/pricing/**"
  - "**/currency*"
  - "**/i18n/**"
  - "**/locales/**"
  - "**/*.{po,pot,xlf}"
  - "**/schedul*"
content_signals:
  - 'Python: datetime.now(), datetime.utcnow(), zoneinfo, pytz, timedelta(days=, Decimal quantize and rounding modes, locale, babel, gettext'
  - 'TypeScript: new Date(, Date.now, setHours, getTimezoneOffset, Intl.NumberFormat, Intl.DateTimeFormat, toLocaleString, Temporal, dayjs, date-fns, parseFloat on user text'
  - 'money as float, cents conversions, tax or discount applied before or after rounding'
  - 'unit suffixes in names (ms, seconds, kb, mb) that change or mix'
  - 'plural forms built by string concatenation; hard-coded date or number formats'
agents_today: [code-reviewer, pr-test-analyzer]
triage_weight: high
bot_visibility: partial
```

### Detection

Arithmetic and formatting over quantities that look simple and are not: instants, calendar dates,
durations, currency amounts, units and translated strings. Names carry the signal (`price`,
`amount`, `expires_at`, `timeout_ms`, `locale`). A diff that changes where a value is rounded,
which timezone a date is built in, or the unit of a stored number is a behavior change even when it
reads like cleanup ([BEH-03](operations/behavior.md#beh-03-conditional-or-boundary-change)).

Look-alikes: logging a timestamp is low risk. A `timeout=30` is a duration, and its unit question
belongs with [BEH-07](operations/behavior.md#beh-07-retry-or-timeout-change). A date used only as
an opaque sort key may not need a calendar.

### What a playbook would need to cover

Money as integer minor units or `Decimal`, never float, with a stated rounding mode and a fixed
order (tax then round, or round per line, the same way everywhere), currency carried with the
amount, and conversion rates stamped with the time they were taken. Instants stored in UTC and
converted at the edge. Daylight-saving gaps and overlaps, month-end arithmetic, leap days, week
starts, and "end of day" in the user's zone. Durations kept in one unit with the unit in the name.
Locale-aware parsing (a comma decimal separator turns `1,234` into a different number) and
formatting through `Intl` or `babel`, with plural rules per language. Tests pinned to a fixed clock
so the suite does not pass in only one timezone.

---

## DOM-37: CI pipelines, deploy orchestration and repository automation

```yaml
id: DOM-37
name: CI pipelines, deploy orchestration and repository automation
kind: proposed
playbook: null
path_signals:
  - ".github/workflows/**"
  - ".github/actions/**"
  - ".github/CODEOWNERS"
  - ".github/dependabot.yml"
  - ".gitlab-ci.yml"
  - "release-please*"
  - "renovate.json*"
  - ".husky/**"
content_signals:
  - 'triggers and filters: on push, pull_request, pull_request_target, workflow_run, paths and paths-ignore, branches, tags, concurrency groups, cancel-in-progress'
  - 'job wiring: needs, if conditions, continue-on-error, matrix, required status check names'
  - 'artifacts and caches: upload-artifact, download-artifact, cache keys, build once and deploy that artifact'
  - 'deploy steps: environment, approvals, a migration job before or after deploy, a rollback step'
  - 'auto-merge, auto-approve, labeler and bot-commit rules'
agents_today: [security-auditor, architect-review]
triage_weight: high
bot_visibility: partial
```

### Detection

Workflow files and repository automation config. [DOM-24](#dom-24-dockerfile-and-infrastructure-as-code)
covers the security surface of the same files (token scopes, SHA pinning, `pull_request_target`).
This entry is about whether the pipeline selects, orders and reports the right things. A workflow
that parses and runs is not necessarily one that tests what the PR changed.

Look-alikes: a workflow that only runs a linter has a small blast radius. A reusable workflow
called from many repos changes all of them at once. Python and TypeScript repos mostly appear here
as test matrices, package publishing and monorepo "affected" filters.

### What a playbook would need to cover

Event and ref selection: whether it runs on the PR head or a merge ref, on forks, on tags.
Changed-file filters that skip a job a required check depends on, which leaves the check pending
forever or silently green. Required check names still reported when a job is renamed or skipped.
One artifact built once and promoted, with provenance, instead of rebuilt per environment.
Cancellation of an in-progress deploy by a newer push. The order of migration, deploy and flag
changes ([DOM-09](#dom-09-migrations-and-deployment-sequencing)). Whether a step swallows failure
(`continue-on-error`, `|| true`). A pipeline is tested by a dry run on a branch, so ask for the run
link. The release outputs themselves are
[DOM-31](#dom-31-build-packaging-and-release-artifacts).

---

## DOM-38: File and object storage workflows

```yaml
id: DOM-38
name: File and object storage workflows
kind: proposed
playbook: null
path_signals:
  - "**/storage/**"
  - "**/uploads/**"
  - "**/blob*"
  - "**/s3*"
  - "**/media/**"
  - "**/attachments/**"
content_signals:
  - 'Python: boto3 put_object and upload_fileobj, generate_presigned_url, shutil.move, os.replace, tempfile, open(path, "wb"), UploadFile'
  - 'TypeScript: S3Client with PutObjectCommand, getSignedUrl, multipart upload, fs.writeFile, fs.rename, Supabase or Vercel Blob clients, FormData handling'
  - 'content-type, content-length, checksum or ETag handling; file names taken from user input'
  - 'expiry values on signed URLs and lifecycle rules'
  - 'a database row written before or after the object is stored'
agents_today: [security-sast, code-reviewer, silent-failure-hunter]
triage_weight: medium
bot_visibility: partial
```

### Detection

Code that writes, moves, serves or deletes files and objects, local or in a bucket, and the
database rows that point at them. A `put_object` close to an `INSERT` is the typical shape, and a
file or key name built from request data is the typical hazard.

Look-alikes: reading a small config file is [DOM-16](#dom-16-configuration-files). Binary files
committed to the repo are [DOM-27](#dom-27-binary-assets). A user upload endpoint is also
[DOM-05](#dom-05-code-that-validates-user-input) for the validation half.

### What a playbook would need to cover

Replacement that is atomic: write to a temp key or file, then `rename` or copy, so a reader never
sees half a file. Multipart uploads that are aborted on failure, with a lifecycle rule for the
leftovers. Whether metadata (content type, size, checksum) matches the bytes. The order of the
object write and the database row, and what is left behind if the second step fails
([BEH-10](operations/behavior.md)). Expiring signed URLs, their scope, and who can mint them. Key
and file name sanitization (path traversal, collisions, overwriting another tenant's object).
Deletion that leaves no orphan objects or dangling rows. The cost of a hot path that lists a
bucket. Disk space and temp-file cleanup apply to local storage too.

---

## DOM-39: Data retention, erasure and archival

```yaml
id: DOM-39
name: Data retention, erasure and archival
kind: proposed
playbook: null
path_signals:
  - "**/retention*"
  - "**/gdpr*"
  - "**/privacy/**"
  - "**/erasure*"
  - "**/archiv*"
  - "**/purge*"
  - "**/cleanup*"
content_signals:
  - 'deleted_at, is_deleted, soft delete flags, ON DELETE CASCADE, DELETE FROM with a date predicate, TTL or expireAfterSeconds settings'
  - 'deletion that touches one store only: the primary table but not the search index, cache, object storage, analytics or event stream'
  - 'delete_user, anonymize, redact, hash-and-keep, legal_hold fields'
  - 'backup, snapshot and restore scripts; replica or warehouse sync jobs'
  - 'retention periods stated in code, config or docs (30 days, 7 years)'
agents_today: [security-auditor, code-reviewer]
triage_weight: high
bot_visibility: none
```

### Detection

Code that decides how long data lives and what happens when it must go: scheduled purges, account
deletion, anonymization, archival to cold storage. The bot sees the delete statement and not the
other copies. A diff that deletes from one table is a retention change if other systems hold data
derived from it. Dropping a column is [DEL-10](operations/deletion.md#del-10-schema-element-dropped)
and is a schema matter, not an erasure.

Look-alikes: cleaning up temp files or expired sessions is housekeeping. A soft delete used as undo
in the UI is a feature, and a soft delete used to satisfy an erasure request usually fails it.

### What a playbook would need to cover

The list of every place the data lives: read replicas, caches, search indexes, object storage,
event logs, analytics exports, logs, backups. Whether the deletion reaches each one, in what order,
and whether a retried or half-finished deletion is safe to run again. Whether derived data
(embeddings, aggregates, training sets) is covered. Legal holds that must block deletion. What a
restore from backup does: it can bring erased people back, so a restore procedure needs a
re-erasure step driven by a deletion ledger. Retention periods should come from a documented
policy, not a constant someone typed. The bot cannot verify any of this from a diff, so the
playbook should ask for the data map and a test that deletes a record and then queries every store.

---

## DOM-40: Streaming and long-lived connections

```yaml
id: DOM-40
name: Streaming and long-lived connections
kind: proposed
playbook: null
path_signals:
  - "**/stream*"
  - "**/sse*"
  - "**/websocket*"
  - "**/ws/**"
  - "**/realtime/**"
  - "**/events/**"
content_signals:
  - 'Python: StreamingResponse, EventSourceResponse, async generators with yield, websockets, WebSocket receive and send, aiter_lines, asyncio.CancelledError'
  - 'TypeScript: ReadableStream, TransformStream, EventSource, new WebSocket(, res.write, controller.enqueue, AbortController, TextDecoder with the stream option'
  - 'SSE framing: data lines, event ids, Last-Event-ID, heartbeat comments, text/event-stream'
  - 'reconnect and resume logic: retry intervals, cursors, offsets, backoff'
  - 'a loop reading a stream with no timeout or no cancellation check'
agents_today: [code-reviewer, silent-failure-hunter]
triage_weight: medium
bot_visibility: partial
```

### Detection

Responses that stay open and deliver data in pieces: server-sent events, WebSockets, chunked
downloads, token streams from a model, and the client code that consumes them. The signal is an
async generator or a stream reader in a handler, or an `EventSource` in a component. They are
async by nature, so [DOM-20](#dom-20-concurrency-and-io) applies underneath, and a change to the
order of sends and effects is
[BEH-05](operations/behavior.md#beh-05-async-or-concurrency-change).

Look-alikes: a paginated list fetched in a loop is not a stream. Polling every few seconds is
simpler and has different failure modes. A queue consumer
([DOM-11](#dom-11-background-jobs-queues-and-events)) is long-lived but not tied to a client
connection.

### What a playbook would need to cover

Framing: messages that split across chunk boundaries (a UTF-8 character cut in half, a JSON line
arriving in two reads), and a parser that handles partial input. What happens on client disconnect,
meaning whether the server stops the work or keeps computing and paying for it. Backpressure when
the consumer is slower than the producer. Reconnect with a cursor or `Last-Event-ID` so the client
neither loses nor repeats events. Authentication that expires while the connection is open.
Proxies and platform limits that buffer the stream or cut idle connections (heartbeats, response
time caps on serverless). Error signaling after headers are sent, when a status code is no longer
possible. Cleanup of listeners and timers on unmount or close matters in React too.

---

## DOM-41: LLM inference and structured-output handling

```yaml
id: DOM-41
name: LLM inference and structured-output handling
kind: proposed
playbook: null
path_signals:
  - "**/llm/**"
  - "**/ai/**"
  - "**/models.{py,ts}"
  - "**/inference*"
  - "**/completion*"
  - "**/chat*"
content_signals:
  - 'Python: anthropic, openai, litellm, pydantic-ai and langchain calls; response_format, tool_choice, max_tokens, stop_reason, finish_reason, model_validate_json'
  - 'TypeScript: generateObject, generateText, streamText, zod schemas passed to a model, messages.create, response.choices[0], usage.inputTokens'
  - 'handling of refusals, finish_reason of length or content_filter, stop_reason of max_tokens or refusal'
  - 'model id strings and capability assumptions (tool use, JSON mode, prompt caching, context size)'
  - 'retry or repair loops around schema validation failures'
agents_today: [silent-failure-hunter, code-reviewer]
triage_weight: medium
bot_visibility: partial
```

### Detection

Code that calls a model and then consumes what comes back. The call site, the schema handed to it,
the code that assembles a streamed answer, and the code that validates it are all in scope. The
instructions given to the model are [DOM-28](#dom-28-llm-prompt-and-agent-instruction-files). This
entry covers what the program does with the output. Provider clients also fall under
[DOM-29](#dom-29-outbound-service-clients-and-integrations) for transport and credentials.

Look-alikes: a unit test that mocks the model returns whatever the test author typed, so it proves
the parsing and nothing about the model. A call to an embedding endpoint belongs to
[DOM-43](#dom-43-retrieval-embeddings-and-search-indexes).

### What a playbook would need to cover

Finish reasons: a truncated answer (`max_tokens`, `length`) is not a complete answer, and parsing
half a JSON object either throws or repairs into something plausible. Refusals and content filters
that return success with no content. Stream assembly, since tool-call arguments arrive as
fragments. Schema validation: what happens on failure (retry count, fallback, failing closed), and
whether the schema uses constructs the chosen model's structured-output mode does not support.
Capabilities differ by model and version and change over time, so check the provider's current docs
before accepting a claim about what a model supports. Token and cost bounds: an input cap, an
output cap, a retry cap, and a budget alarm. Nondeterminism: whether tests pin temperature and
whether any decision depends on the exact wording of a reply.

---

## DOM-42: Agent execution, tools and durable state

```yaml
id: DOM-42
name: Agent execution, tools and durable state
kind: proposed
playbook: null
path_signals:
  - "**/agents/**"
  - "**/tools/**"
  - "**/graph*"
  - "**/workflow*"
  - "**/checkpoint*"
  - "**/mcp/**"
  - "**/orchestrat*"
content_signals:
  - 'Python: langgraph StateGraph and checkpointers, pydantic-ai Agent, tool decorators, while True agent loops, max_steps, recursion_limit'
  - 'TypeScript: tool definitions with execute handlers, AI SDK maxSteps or stopWhen, MCP server tool handlers, agent loops over generateText'
  - 'permission checks, approval prompts or allowlists around tool calls'
  - 'persisted conversation, memory or task state: checkpoint, thread_id, resume, replay'
  - 'tool results appended to a prompt without marking their source'
agents_today: [security-auditor, architect-review, code-reviewer]
triage_weight: high
bot_visibility: partial
```

### Detection

Loops in which a model chooses actions, tools that perform them, and the state kept between steps
or runs. The signals are a loop with no obvious exit, a tool handler that touches the filesystem,
network or database, and persisted state that a later run resumes from. Tools exposed over MCP are
an interface that other agents depend on
([IFC-01](operations/interface.md#ifc-01-function-signature-changed)).

Look-alikes: a single model call with a fixed prompt is
[DOM-41](#dom-41-llm-inference-and-structured-output-handling). A background job queue is
[DOM-11](#dom-11-background-jobs-queues-and-events). Instruction files that configure an agent are
[DOM-28](#dom-28-llm-prompt-and-agent-instruction-files).

### What a playbook would need to cover

Termination: a step limit, a token or time budget, and a stop condition a confused model cannot
dodge. Authorization at execution time, checked against the user the run acts for, not the user who
started the session or the model's own claim; a tool that wraps a destructive operation needs the
guard inside the tool ([DEL-04](operations/deletion.md#del-04-guard-or-check-removed)). Duplicate
side effects after a resume, where a step that already sent an email runs again because the
checkpoint was saved before the effect. Checkpoint consistency when state and external effects can
diverge ([BEH-10](operations/behavior.md)). Attribution of tool output: text from a web page or a
file is data and must not be able to change the instructions
([DOM-19](#dom-19-trust-boundaries)). Also what is logged, so a failed run can be reconstructed.

---

## DOM-43: Retrieval, embeddings and search indexes

```yaml
id: DOM-43
name: Retrieval, embeddings and search indexes
kind: proposed
playbook: null
path_signals:
  - "**/embedding*"
  - "**/retriev*"
  - "**/rag/**"
  - "**/search/**"
  - "**/indexing/**"
  - "**/vector*"
  - "**/chunk*"
content_signals:
  - 'Python: sentence_transformers, openai embeddings.create, faiss, chromadb, qdrant_client, pgvector, Vector(dim), elasticsearch or opensearch clients, text splitters'
  - 'TypeScript: embed or embedMany, pgvector queries, Pinecone or Weaviate clients, MeiliSearch, lunr, chunking functions'
  - 'embedding model names and dimension constants; distance operators (<->, <=>, <#>)'
  - 'chunk size and overlap values; chunk id construction'
  - 'metadata filters, tenant or user ids in a query, top_k, score thresholds, rerankers'
agents_today: [code-reviewer, security-sast]
triage_weight: medium
bot_visibility: partial
```

### Detection

Code that turns documents into vectors or index entries, stores them, and queries them. The pair of
write path (chunk, embed, upsert) and read path (embed the query, filter, rank) matters more than
either alone. A model name, a dimension, a chunking parameter or a distance metric appearing in a
diff is a data-format change in disguise, because stored vectors depend on all four
([IFC-05](operations/interface.md#ifc-05-env-var-or-config-key-renamed) covers the renamed-config
half).

Look-alikes: a SQL `LIKE` or full-text query is ordinary [DOM-08](#dom-08-queries-and-indexes)
work. A cache keyed by a hash is not retrieval. An index defined in a migration also falls under
[DOM-09](#dom-09-migrations-and-deployment-sequencing).

### What a playbook would need to cover

Compatibility: vectors from different embedding models, or from one model at a different
dimension or normalization, cannot be compared, so a model change needs a full re-index and a
cutover plan. Chunk identity: stable ids, so a re-run updates instead of duplicating and an edited
document replaces its old chunks. Access control: the tenant or permission filter must apply before
or inside retrieval, not after taking the top results and not as a prompt instruction. Deletion
must propagate to the index ([DOM-39](#dom-39-data-retention-erasure-and-archival)). Relevance
regressions: any change to chunking, model or ranking needs an evaluation on a fixed query set
([DOM-44](#dom-44-model-and-agent-evaluation-datasets)), since a diff cannot show whether answers
got worse.

---

## DOM-44: Model and agent evaluation datasets

```yaml
id: DOM-44
name: Model and agent evaluation datasets
kind: proposed
playbook: null
path_signals:
  - "**/evals/**"
  - "**/eval/**"
  - "**/benchmarks/**"
  - "**/datasets/**"
  - "**/fixtures/**/labels*"
  - "**/*.{jsonl,csv,parquet}"
  - "**/scoring*"
content_signals:
  - 'Python: pytest-based evals, promptfoo or inspect configs, sklearn.metrics, train_test_split, random seeds, pass@k computation, judge-model calls'
  - 'TypeScript: custom eval runners, JSON fixtures of expected outputs, scoring functions, replay harnesses'
  - 'label files with source, status or reviewer fields; provisional vs confirmed markers'
  - 'denominators: filters that exclude cases, skipped or errored cases dropped from the total'
  - 'summary tables comparing before and after scores in the PR text'
agents_today: [pr-test-analyzer]
triage_weight: medium
bot_visibility: partial
```

### Detection

Datasets of cases with expected results, the code that scores a system against them, and the
reports derived from the scores. This repo's `src/replay/` fixtures are an example. A diff that
adds cases, edits labels, changes a filter or alters a scoring function can move a headline number
without any change to the system under test, and the PR text often quotes that number.

Look-alikes: ordinary unit test fixtures
([DOM-14](#dom-14-test-code-itself-helpers-fixtures-and-fakes)) check the correctness of code and
have no aggregate score. A benchmark of runtime speed is
[DOM-22](#dom-22-performance-and-observability). A prompt change is
[DOM-28](#dom-28-llm-prompt-and-agent-instruction-files) and is judged by this domain's evidence.

### What a playbook would need to cover

Leakage: cases used to tune a prompt or threshold must not be the cases reported, so held-out data
needs a marker and a rule against editing the system with it in view. Label provenance: who or what
produced each label, whether a model graded its own output, and how disagreements are counted
instead of dropped. Denominators: the score before and after must be computed over the same cases,
and removed, skipped or failed cases need to be reported. Reproducibility: seeds, model versions,
temperature, and a recorded run so a number can be rerun. Slices: an aggregate gain can hide a loss
on one language, size or category, so the report should break out slices and flag regressions.
Sample size matters when the claimed gain is a few cases.
