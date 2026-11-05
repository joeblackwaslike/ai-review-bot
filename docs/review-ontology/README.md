# Review ontology

A design reference for teaching ai-review-bot to review a pull request the way a senior
engineer does. It starts from [00-origin.md](00-origin.md), the problem statement, and builds
on [Code-Review-Guide-and-Playbooks.md](../Code-Review-Guide-and-Playbooks.md), which is the
standard for what a review checks.

This is a reference, not code. Eval fixtures, reviewer prompts and implementation specs are
derived from it later, each through its own spec.

## The model: a change is an operation applied to a domain

The guide's playbooks are keyed by what the code **is**: an endpoint, a migration, auth,
tests, config. They say what to check, and this folder never restates them.

What the guide doesn't key anything by is what was **done** to the code: moved, renamed,
deleted, reformatted, codemodded, reverted, or changed in behavior. That is the operation,
and it decides how much of a playbook applies:

- **Narrowing.** A function moved unchanged was reviewed when it was written. The review
  checks what the move could break (references, mocks, config paths, the public surface) and
  skips the body.
- **Widening.** A changed comparison inside an auth check is new behavior on a trust
  boundary. It gets the full
  [authentication and authorization](../Code-Review-Guide-and-Playbooks.md#authentication-and-authorization)
  pass and raises the review tier.
- **Neutral.** Extracting a helper doesn't change the domain; the guide's design rules judge it.

A reviewer that can't tell the operation re-reviews old code as new and misses the checks
that matter. That is the failure in Joe's move-a-function example, and the reason this folder
exists.

## What's here

| File | What it answers |
| --- | --- |
| [00-origin.md](00-origin.md) | The problem, in Joe's words |
| [operations/](operations/) | One file per operation family. Each entry says how to detect the operation from a diff, how to confirm why it happened, what context to gather, what not to review, what to check, and what ai-review-bot sees today |
| [domains.md](domains.md) | One detection entry per guide playbook, plus cross-cutting domains and proposed new ones: how to tell from a diff that the domain is present, and which playbook to pull in |
| [triage.md](triage.md) | How to size a PR by what it contains, not how many lines it has, and how that picks the tier, the agents and each agent's model and effort |
| [context-building.md](context-building.md) | The levels of context a reviewer reads beyond the diff, and the tools (git, tree-sitter, LSP, Serena, Graphify, GitHub APIs) that reach each one |
| [reviewer-tools.md](reviewer-tools.md) | The proposed tool surface that lets the bot work like an engineer with the branch checked out |
| [customization.md](customization.md) | How a repo or organization adds, removes or overrides rules at each layer |
| [process-design.md](process-design.md) | An audit of today's pipeline against the guide's review process, candidate architectures, and the experiments that choose between them |

### Operation families

| Family | File | Typical effect on playbooks |
| --- | --- | --- |
| Relocation (`REL`) | [operations/relocation.md](operations/relocation.md) | Narrows |
| Deletion (`DEL`) | [operations/deletion.md](operations/deletion.md) | Narrows the deleted code, widens the callers |
| Interface (`IFC`) | [operations/interface.md](operations/interface.md) | Widens to compatibility |
| Behavior (`BEH`) | [operations/behavior.md](operations/behavior.md) | Widens |
| Mechanical (`MEC`) | [operations/mechanical.md](operations/mechanical.md) | Narrows, once confirmed mechanical |
| Composite (`CMP`) | [operations/composite.md](operations/composite.md) | Depends on the parts; usually a request to split |

### Domains, lenses and provenance

Not every entry in [domains.md](domains.md) describes what code *is*. Three kinds apply on top
of any domain, and a classifier should treat them as modifiers, not as one more domain to pick:

- **Lenses** are ways of reading any change. Reviewing against the spec (DOM-01) applies to
  every PR. Trust boundaries, concurrency, compatibility, and performance and observability
  (DOM-19 to DOM-22) cut across code of every kind.
- **Provenance** says who or what wrote the change. AI-generated code (DOM-18) and an
  AI-generated bulk change (CMP-08) change where to look, not what the code is.
- **Contract domains** overlap with operations. New endpoints (DOM-03) and endpoint schema
  changes (DOM-04) are two domains with separate detections and playbooks, both under API
  contracts, each combined with a behavior or interface operation.

## How the pieces connect

1. **Triage** reads the PR's files, its description and the linked ticket. It classifies each
   change into operations and domains, and from those picks depth and passes.
2. **Context building** fetches what each detected operation needs: references at base and
   head, the old body of a moved function, the blame on a removed guard, the CI results.
3. **Review** applies the operation's checklist and the matching guide playbooks to the
   narrowed or widened scope.
4. **Customization** lets a repo or org change any of the above with its own rules.

How these steps run (one agent, many, a planned graph) is an open question that
[process-design.md](process-design.md) settles by experiment.

## Adding an entry

1. Find the family in [operations/](operations/), or the domain in [domains.md](domains.md).
   If the change is a mix, it belongs in composite.
2. Copy the skeleton from [operations/_template.md](operations/_template.md). Take the next
   free id in the family.
3. Link the guide for any check it already makes. Write only the checks the operation itself
   creates.
4. Fill in "ai-review-bot today" from the code, not from memory, and keep "Eval seed" to one
   pass/fail sentence.

## Not covered here

- **Severity labels.** The guide labels comments `blocker`, `issue`, `suggestion`,
  `question`, `nit` and `praise`; the bot uses P0 to P3 plus advisory. Mapping one to the
  other is follow-up work.
- **Reviewer prompts and eval fixtures.** Both are derived from these entries in later work.
