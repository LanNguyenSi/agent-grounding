---
type: runbook
title: Merge-approval gate — labels, keys, and when it actually blocks
description: How the merge-approval Check-Run maps five review:* PR labels to merge_approval booleans, keys evidence by the PR HEAD BRANCH NAME, and blocks only when required in branch protection — which on agent-grounding master it is not, so it is advisory in fact today.
tags: [merge-approval, review-claim-gate, ci, runbook, labels]
timestamp: 2026-07-10T01:40:00.436303Z
sources:
  - .github/workflows/merge-approval.yml
  - packages/review-claim-gate/README.md
  - packages/review-claim-gate/action/action.yml
  - docs/testing/merge-approval-rollout.md
---

# Merge-approval gate — labels, keys, and when it actually blocks

## What it is

`.github/workflows/merge-approval.yml` is a `pull_request` workflow (job `gate`)
that reads five `review:*` PR labels, converts each to a boolean, and hands them
to the `review-claim-gate` composite action. The action evaluates the
`merge_approval` policy and posts a **`merge-approval` Check-Run** with a
0–100 score and an `allowed: true|false` verdict. All five prerequisites must be
true for `allowed: true` / score 100 (`README.md:36`, `README.md:132`).

The action is pinned by SHA, not a floating tag:

```
uses: LanNguyenSi/agent-grounding/packages/review-claim-gate/action@62faca5b4ad7f9b9072fdad284287a351a114097 # review-claim-gate-v0.1.0
```

(`merge-approval.yml:47`; the referenced `packages/review-claim-gate/action/`
directory exists and contains `action.yml`.)

## What it reads: the five labels → booleans

The `Extract prereq flags from PR labels` step (`actions/github-script@v7`,
`merge-approval.yml:31-44`) maps each label name to a `"true"|"false"` output,
which is passed into the action inputs (`merge-approval.yml:51-55`). Exact
mapping:

| PR label (apply on the PR)     | github-script output   | action input               | `merge_approval` prereq             |
| ------------------------------ | ---------------------- | -------------------------- | ----------------------------------- |
| `review:tests-pass`            | `tests_pass`           | `tests-pass`               | `tests_pass`                        |
| `review:checklist-complete`    | `checklist_complete`   | `review-checklist-complete`| `review_checklist_complete`         |
| `review:comments-resolved`     | `comments_resolved`    | `comments-resolved`        | `no_unresolved_review_comments`     |
| `review:scope-matches-task`    | `scope_matches_task`   | `scope-matches-task`       | `scope_matches_task`                |
| `review:evidence-logged`       | `evidence_logged`      | `evidence-logged`          | `evidence_logged`                   |

All five label names confirmed verbatim at `merge-approval.yml:40-44`; the
prereq column matches the policy table at `README.md:28-34` and the rollout
table at `merge-approval-rollout.md:15-21`.

Apply labels **truthfully only.** Each label asserts that a real review step
happened — `review:evidence-logged` in particular is today an honour-system tick
that nothing in CI cross-checks (`merge-approval-rollout.md:31-37`). Ticking a
label you did not earn defeats the whole gate.

## The task-id key: PR HEAD BRANCH NAME, not a task UUID

Load-bearing correction. The action's `task-id` input is:

```
task-id: ${{ github.event.pull_request.head.ref }}
```

(`merge-approval.yml:49`.) That is the **PR head branch name** (e.g. `feat/foo`),
**not** an agent-tasks task UUID. The rollout doc confirms: "`task-id` is the
PR's head branch name — stable across commits on the branch"
(`merge-approval-rollout.md:27-28`). Everywhere the gate says "task id" for
evidence lookup, read **branch name**.

## Evidence-source precedence (used by `check`)

When the action evaluates `evidence_logged`, it resolves evidence from one of
three sources, highest precedence first (`README.md:69-80`):

1. **Forced** — `--evidence-logged` (the `evidence-logged: true` input) forces
   `evidence_logged=true` regardless of any other signal.
2. **Committed evidence file** — `--evidence-file <path>` if given and it exists;
   otherwise auto-detect `./.agent-grounding/evidence/<task-id>.jsonl` relative
   to `process.cwd()`, counting non-empty JSON lines. (`<task-id>` = branch name.)
   An explicit `--evidence-file` pointing at a non-existent path **throws** rather
   than silently falling back (`README.md:80`).
3. **Ledger fallback** — local evidence-ledger DB keyed by `session = <task-id>`
   (again, branch name).

`evidenceSource` in the JSON verdict is one of `"forced" | "file" | "ledger" |
"none"` (`README.md:109`). Note the workflow only wires the label→`evidence-logged`
input, so in CI today evidence is effectively **forced by label** (iteration 1);
iteration 2 swaps the label for the committed file
(`merge-approval-rollout.md:31-37`, follow-up task `5ea6d7cf`).

## When it actually blocks (two states — know which is live)

The Check-Run is **only** a hard merge gate when `merge-approval` is listed in
the branch's **required status checks** in branch protection
(`merge-approval-rollout.md:6-8`, `README.md:180-185`). There are two states:

- **Hard gate (end state the rollout doc describes).** `merge-approval` is a
  required check on `master`; a red / `allowed: false` verdict blocks the Merge
  button until all five labels are present and the check flips to ALLOWED
  (`merge-approval-rollout.md:6-8, 82`).
- **Advisory in fact (the live state on agent-grounding today).** Verified by the
  orchestrator via the GitHub API on 2026-07-10: agent-grounding's `master` is
  **not branch-protected**, so `merge-approval` is **not** a required check. The
  Check-Run still posts and can go red, but **a red merge-approval does not block
  a merge** right now. The rollout doc correctly describes the hard-gate *end
  state*; it is not yet wired.

**How to tell which one is live:** inspect the branch's required status checks.

```bash
gh api repos/LanNguyenSi/agent-grounding/branches/master/protection \
  --jq '.required_status_checks.contexts'
```

If the call 404s / errors "Branch not protected", or the returned list does not
contain `merge-approval`, the gate is **advisory** — a red check is informational
and does not stop the merge. If the list contains `merge-approval`, it is a
**hard gate**. To promote it to a hard gate, add `merge-approval` (alongside the
existing `ci`) to the required checks per `merge-approval-rollout.md:40-67`
(requires Admin).

## How to make it pass legitimately

Do the review, then add each label only when its dimension is genuinely met
(reviewer cheat sheet, `merge-approval-rollout.md:69-82`):

1. CI green → `review:tests-pass`.
2. Walk the full checklist (correctness, security/scope, permissions, minimal
   diff, open questions from the task, backend invariants, docs coherence, test
   coverage of risky bits, integration touchpoints) → `review:checklist-complete`.
3. No unresolved review comments → `review:comments-resolved`.
4. Diff stays inside task scope → `review:scope-matches-task`.
5. Log ≥1 evidence-ledger entry under `session = <branch-name>` (e.g.
   `ledger add --session feat/foo --type fact --content "…"`), or in iteration 2
   commit `.agent-grounding/evidence/<branch-name>.jsonl` → `review:evidence-logged`.

The Check-Run flips to ALLOWED once all five labels are present.

## Reading a BLOCKED verdict

A `merge-approval` Check-Run scored **0/100 BLOCKED** with **"Evidence entries: 0"**
almost always means **no evidence exists under the branch-name key** (no
committed `.agent-grounding/evidence/<branch>.jsonl`, no ledger rows for
`session = <branch>`, and `review:evidence-logged` not applied) — **not that the
gate is broken.** Because the key is the branch name, evidence logged under a
grounding-session id (e.g. `gs-agent-grounding-…`) will not be found; use
`review-claim-gate export --task-id <branch-name> --from-session <gs-id>` to
rewrite it under the branch key without re-logging (`README.md:74-78`). Missing
prereqs are also listed in the verdict's `next_steps` (`README.md:36`).

## How to re-trigger after backfilling

The workflow triggers on these `pull_request` types (`merge-approval.yml:4-11`):
`opened`, `reopened`, `synchronize`, `labeled`, `unlabeled`, `ready_for_review`.
So a **new event** is required to re-evaluate — either:

- a **new/removed label** (`labeled` / `unlabeled`) — the normal path after you
  add `review:*` labels; or
- a **new commit** (`synchronize`).

A previously finished `pull_request` run **cannot be "Re-run" into passing**:
re-running replays the original event payload (same labels), so it re-reads the
same flags. After backfilling evidence or fixing a dimension you must generate a
fresh `labeled`/`unlabeled`/`synchronize` event. `concurrency` is keyed per PR
number with `cancel-in-progress: true` (`merge-approval.yml:19-21`), so the
newest event's run supersedes any in-flight one. (Re-trigger claim verified
against the `on:` block: `labeled`/`unlabeled`/`synchronize` are all present.)
