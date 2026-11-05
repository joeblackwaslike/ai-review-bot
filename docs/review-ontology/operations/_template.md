# Operation entry template

Every operation family file (`relocation.md`, `deletion.md`, …) is a list of entries in this
shape. An entry is one `##` heading, one fenced `yaml` block, then the eleven `###` sections in
this order. Keep the section headings exactly as written so a script can extract entries later.

The guide ([Code-Review-Guide-and-Playbooks.md](../../Code-Review-Guide-and-Playbooks.md)) owns
the domain checklists. An entry links to it by anchor and never copies a checklist from it.
Write the checks that exist *because of the operation*.

## Field reference

| Field | Meaning |
| --- | --- |
| `id` | Family prefix plus a two-digit number: `REL`, `DEL`, `IFC`, `BEH`, `MEC`, `CMP` |
| `name` | Short, the way a reviewer would say it |
| `family` | `relocation`, `deletion`, `interface`, `behavior`, `mechanical` or `composite` |
| `aliases` | Other names the same operation goes by |
| `signals` | What in a diff suggests this operation. Short phrases |
| `narrows_playbooks` | `true` when the operation lets a reviewer skip domain checks on part of the diff (an unchanged moved body), `false` when it widens them, `neutral` otherwise |
| `escalates_with` | Domains that raise the stakes: `public-api`, `trust-boundary`, `auth`, `data-write`, `migration`, `critical-path`, `concurrency`, `money` |
| `guide_refs` | Heading anchors in the guide this entry leans on, for example `"#readability-and-review"` (where Chesterton's Fence lives). Only headings have anchors, so a principle named in bold is cited by its section |
| `tools` | Tool ids from [context-building.md](../context-building.md) |
| `bot_visibility` | What ai-review-bot sees today: `none`, `partial` or `full` |

## Entry skeleton

````markdown
## REL-00: Name of the operation

```yaml
id: REL-00
name: Name of the operation
family: relocation
aliases: []
signals: []
narrows_playbooks: neutral
escalates_with: []
guide_refs: []
tools: []
bot_visibility: none
```

### What it looks like in a diff

### How to recognize it

### Likely intents

### Context to gather

### What not to spend review on

### Checklist

### How it combines with domain playbooks

### Red flags

### Worked example

### ai-review-bot today

### Eval seed
````

## Writing rules

- Detection signals cover Python and TypeScript at least, since the bot reviews both.
- "Context to gather" names a tool for each item. Name the IDE action from the guide's
  [navigation table](../../Code-Review-Guide-and-Playbooks.md#review-locally-not-only-in-the-browser)
  where one fits, then the agent-callable equivalent.
- "ai-review-bot today" is factual and short. The hosted path sees the serialized diff with
  right-side line numbers and PR metadata. It has no repository access and no symbol search. The agent prompt
  gets each file's `renamed` status but not `previous_filename`, so it can't connect an old path
  to a new one; re-review triage and the ledger do use GitHub's rename data. Deletion-only hunks are dropped when the diff is over budget.
  The local CLI has a checkout but doesn't use it for navigation.
- "Eval seed" is one sentence: what a reviewer must say or not say on a minimal example to pass.
