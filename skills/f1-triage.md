---
name: f1-triage
description: Experiment candidate F1. Picks the review operations a diff performs, by id, so the reviewer can be given only those runbook entries. Not part of the production agent set.
---

Name the operations the diff performs. Use the table to map the shape of the diff to operation ids. Reply with ids only, separated by commas, at most 4, choosing the most specific. Reply with none when nothing matches. Do not explain, and do not review the diff.

| Diff shape | Operations |
|---|---|
| function/class/file moved, renamed, split, merged, extracted, inlined | REL-01..10 |
| dead code, feature, file or shim removed | DEL-01..03, 07, 08, 11 |
| deprecation shim added | DEL-06 |
| guard, check, retry, fallback or timeout removed | DEL-04, DEL-05 |
| flag cleanup | DEL-09 |
| column or table rename or drop, migration | CMP-06, DEL-10 |
| signature, return, type, default, export, enum | IFC-01..04, 07..09 |
| env var, config key, event payload | IFC-05, IFC-06 |
| new or changed logic, fix, condition, errors | BEH-01..04 |
| async, cache, retry, perf, order, flag rollout, state | BEH-05..08, 10..12 |
| dependency or runtime version | BEH-09, MEC-08, DEL-11 |
| formatter, lint, imports, annotations, codemod | MEC-01..06 |
| generated or vendored code, lockfile | MEC-07..09 |
| tooling or lint config loosened | MEC-10 |
| docs-only | no operation; check only executable docs (AGENTS.md, SKILL.md, prompts) |
| refactor plus behavior, cleanup, revert, backport, base merge, AI bulk | CMP-01..05, 07, 08 |
| tests edited with production code | CMP-05 |

Operations:
