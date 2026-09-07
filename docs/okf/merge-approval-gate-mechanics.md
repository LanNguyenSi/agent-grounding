---
type: runbook
title: Merge-approval gate — labels, keys, and when it actually blocks
description: How the merge-approval Check-Run maps five review:* PR labels (OR'd with a data-driven pure-release exception) to merge_approval booleans, keys evidence by the PR HEAD BRANCH NAME, and blocks only when required by an applicable branch-protection rule or ruleset.
tags: [merge-approval, review-claim-gate, ci, runbook, labels]
timestamp: 2026-09-07T06:10:00Z
sources:
  - .github/workflows/merge-approval.yml
  - scripts/release-exception.js
  - packages/review-claim-gate/README.md
  - packages/review-claim-gate/action/action.yml
  - docs/testing/merge-approval-rollout.md
  - CONTRIBUTING.md
---

# Merge-approval gate — labels, keys, and when it actually blocks

## What it is

`.github/workflows/merge-approval.yml` is a `pull_request` workflow (job `gate`)
that reads five `review:*` PR labels, converts each to a boolean, and hands them
to the `review-claim-gate` composite action. The action evaluates the
`merge_approval` policy and posts a **`merge-approval` Check-Run** with a
0–100 score and an `allowed: true|false` verdict. All five prerequisites must be
true for `allowed: true` / score 100 (`README.md:36#"Missing prereqs surface in"`, `README.md:132#"result.allowed === true, result.score === 100"`).

The action is pinned by SHA, not a floating tag:

```
uses: LanNguyenSi/agent-grounding/packages/review-claim-gate/action@cd3971866e48050514bfa5056bcb7e1d79615bd7 # review-claim-gate-v0.1.6
```

(`merge-approval.yml:115#"review-claim-gate-v0.1.6"`; the referenced `packages/review-claim-gate/action/`
directory exists and contains `action.yml`.)

## What it reads: the five labels → booleans

The `Extract prereq flags from PR labels` step (`actions/github-script@v8`,
`merge-approval.yml:31-44#"core.setOutput('evidence_logged',"`) maps each label name to a `"true"|"false"` output,
which is passed into the action inputs, each OR'd with the release-exception
verdict below (`merge-approval.yml:119-123#"evidence-logged: ${{ steps.labels.outputs.evidence_logged == 'true' || steps.release_exception.outputs.pure_release == 'true' }}"`). Exact
mapping:

| PR label (apply on the PR)     | github-script output   | action input               | `merge_approval` prereq             |
| ------------------------------ | ---------------------- | -------------------------- | ----------------------------------- |
| `review:tests-pass`            | `tests_pass`           | `tests-pass`               | `tests_pass`                        |
| `review:checklist-complete`    | `checklist_complete`   | `review-checklist-complete`| `review_checklist_complete`         |
| `review:comments-resolved`     | `comments_resolved`    | `comments-resolved`        | `no_unresolved_review_comments`     |
| `review:scope-matches-task`    | `scope_matches_task`   | `scope-matches-task`       | `scope_matches_task`                |
| `review:evidence-logged`       | `evidence_logged`      | `evidence-logged`          | `evidence_logged`                   |

All five label names confirmed verbatim at `merge-approval.yml:40-44#"core.setOutput('evidence_logged',"`; the
prereq column matches the policy table at `README.md:28-34#"evidence-ledger entry tagged with this PR's task id"` and the rollout
table at `merge-approval-rollout.md:19-21#"review:tests-pass"`.

Apply labels **truthfully only.** Each label asserts that a real review step
happened. Four of the five (`tests-pass`, `checklist-complete`,
`comments-resolved`, `scope-matches-task`) are still honour-system ticks that
nothing in CI cross-checks. `review:evidence-logged` is different: as covered
above, a committed evidence file already satisfies `evidence_logged` in CI
without the label, so that prereq is only honour-system when the reviewer
uses the label's force-override instead of committing evidence
(`merge-approval-rollout.md:68-75#"for tracking history."`). Ticking a label you did not earn
defeats the whole gate.

## The pure-release exception: a sixth, data-driven path to all five `true`s

Between the label-extraction step and the gate action, a `Determine release
exception from the PR's real changed files` step
(`merge-approval.yml:46-91#"core.setOutput('pure_release', pure_release.toString());"`)
computes a `pure_release` boolean and OR's it into every one of the five
action inputs above
(`merge-approval.yml:119-123#"evidence-logged: ${{ steps.labels.outputs.evidence_logged == 'true' || steps.release_exception.outputs.pure_release == 'true' }}"`).
When `pure_release` is `true`, all five prereqs are satisfied regardless of
which `review:*` labels are on the PR: no label round needed.

`pure_release` comes from `scripts/release-exception.js`'s
`classifyPullFiles(files)`, called on the PR's actual `listFiles` API objects
obtained via `github.paginate(github.rest.pulls.listFiles, ...)` (paginated,
so a PR with more than one API page of files is read correctly). A file
entry is pure only when **all three** hold:

1. **Path shape.** The `filename` matches one of these exact shapes, and the
   file list is non-empty:
   - `package.json`, `package-lock.json`, `CHANGELOG.md` (root)
   - `packages/<one path segment>/package.json`
   - `packages/<one path segment>/CHANGELOG.md`

   Nothing else: not `src/**`, not `docs/okf/**`, not a workflow file, not a
   nested `packages/<a>/<b>/package.json`, and not a case-insensitive match
   (`PACKAGE.JSON` does not count). Any number of packages may appear in one
   pure PR; the allowlist has no per-PR cap on package count.
2. **File status.** `status` is `added` or `modified`. A `renamed` or
   `removed` entry is never pure, regardless of the shape of its `filename`,
   and a rename's old `previous_filename` is never itself checked against
   the allowlist, so a rename cannot qualify by virtue of what it used to be
   named either.
3. **Content, for `package.json`/`package-lock.json` only.** The file's
   unified diff `patch` text changes nothing but `"version": "…"` value
   lines: every added/removed line must match that shape once the leading
   `+`/`-` marker is stripped (trailing comma optional, any amount of
   leading indentation). This is what stops a root-`package.json`-only PR
   from smuggling in a `postinstall` script, a new `bin`/dependency entry,
   or a lockfile `resolved`/`integrity` repoint under a release-shaped path.
   A file entry with **no `patch` field at all** (GitHub omits it for a very
   large diff) is treated as NOT pure, fail-closed: there is nothing to
   verify, so nothing has been verified. `CHANGELOG.md` carries no content
   constraint: prose is expected to change.

**Residual:** this is a check on the PR's diff text as GitHub reports it,
not a semantic package/lockfile verification; it cannot tell a legitimate
version bump from a change that happens to land entirely on lines shaped
like a JSON `"version"` key. See `scripts/release-exception.js`'s own header
comment for the full rationale and `CONTRIBUTING.md`'s "Cutting a release"
section for what this looks like in practice, including the two path-level
disqualifiers that come up most often (a source version constant such as
`packages/grounding-mcp/src/server.ts`, and a `docs/okf/*.md` re-stamp
riding along with the bump).

**Pagination safety net.** The step also compares the number of files
`github.paginate` actually returned against the PR's own
`changed_files` count; on a mismatch it forces `pure_release: false` and
writes a step-summary note, rather than silently classifying a possibly
partial file list as pure.

When the exception applies, the step writes a step-summary note naming the
files it matched (`merge-approval.yml:102-111#".write();"`).

**Trust boundary.** The classifier and the workflow that `require()`s it
both come from the PR ref on `pull_request` events, so the exception is a
discipline mechanism, not an integrity boundary (fork PRs get a read-only
token).

This is additive, not a widening of what the five `review:*` labels mean:
the label semantics, the pinned action, and the job/check name are all
unchanged. A PR that touches anything outside the allowlist is unaffected by
this step and goes through the normal label path described above.

## The task-id key: PR HEAD BRANCH NAME, not a task UUID

Load-bearing correction. The action's `task-id` input is:

```
task-id: ${{ github.event.pull_request.head.ref }}
```

(`merge-approval.yml:117#"task-id: ${{ github.event.pull_request.head.ref }}"`.) That is the **PR head branch name** (e.g. `feat/foo`),
**not** an agent-tasks task UUID. The rollout doc confirms: "`task-id` is the
PR's head branch name — stable across commits on the branch"
(`merge-approval-rollout.md:31-32#"branch and visible in both the PR UI and the Check-Run summary."`). Everywhere the gate says "task id" for
evidence lookup, read **branch name**.

## Evidence-source precedence (used by `check`)

When the action evaluates `evidence_logged`, it resolves evidence from one of
three sources, highest precedence first (`README.md:69-80#"silent fallback would be misleading"`):

1. **Forced** — `--evidence-logged` (the `evidence-logged: true` input) forces
   `evidence_logged=true` regardless of any other signal.
2. **Committed evidence file** — `--evidence-file <path>` if given and it exists;
   otherwise auto-detect `./.agent-grounding/evidence/<task-id>.jsonl` relative
   to `process.cwd()`, counting valid JSON lines. (`<task-id>` = branch name.)
   An explicit `--evidence-file` pointing at a non-existent path **throws** rather
   than silently falling back (`README.md:80#"silent fallback would be misleading"`).
3. **Ledger fallback** — local evidence-ledger DB keyed by `session = <task-id>`
   (again, branch name).

`evidenceSource` in the JSON verdict is one of `"forced" | "file" | "ledger" |
"none"` (`README.md:109#"is set only when"`). The workflow wires the `review:evidence-logged`
label to the `evidence-logged` input, but that label is optional: absent it,
the action falls through to the committed-file auto-detect above, so a
committed `.agent-grounding/evidence/<task-id>.jsonl` in the PR branch,
with at least one valid JSONL entry, already satisfies `evidence_logged`
in CI today, no label required (`merge-approval-rollout.md:60-66#"for the task id."`,
follow-up task `5ea6d7cf` tracks history).

## When it actually blocks (two states — know which is live)

The Check-Run is **only** a hard merge gate when `merge-approval` is listed in
an applicable branch-protection rule or ruleset's **required status checks**
(`merge-approval-rollout.md:6-8#"until the gate returns"`, `README.md:180-185#"the verdict as a Check-Run lives in"`). There are two states:

- **Hard gate (end state the rollout doc describes).** `merge-approval` is a
  required check on `master`; a red / `allowed: false` verdict blocks the Merge
  button until all five prereqs are satisfied and the check flips to ALLOWED
  (`merge-approval-rollout.md:6-8#"until the gate returns"`, 99-100).
- **Advisory state.** When neither an applicable ruleset nor branch protection
  requires `merge-approval`, the Check-Run still posts and can go red, but **a
  red merge-approval does not block a merge**. The rollout doc correctly
  describes the hard-gate *end state*.

**How to tell which one is live:** inspect the branch's applicable rulesets and
branch-protection required status checks.

```bash
gh api repos/LanNguyenSi/agent-grounding/rules/branches/master \
  --jq '.[] | select(.type == "required_status_checks")'

gh api repos/LanNguyenSi/agent-grounding/branches/master/protection \
  --jq '.required_status_checks.contexts'
```

Treat a successful empty ruleset query and a successful legacy query without
`merge-approval` as evidence that the gate is **advisory**. If either response
lists `merge-approval`, it is a **hard gate**. A failed, unauthorized, or
otherwise incomplete query does not establish absence; a legacy-protection 404
only means legacy branch protection is unavailable and must be evaluated with
the ruleset result. To promote it to a hard gate, add `merge-approval` (alongside
the existing `ci`) to the required checks per
`merge-approval-rollout.md:77-105#"alongside it.)"` (requires Admin).

## How to make it pass legitimately

Do the review, then add each label only when its dimension is genuinely met
(reviewer cheat sheet, `merge-approval-rollout.md:107-119#"evidence-ledger entry under"`):

1. CI green → `review:tests-pass`.
2. Walk the full checklist (correctness, security/scope, permissions, minimal
   diff, open questions from the task, backend invariants, docs coherence, test
   coverage of risky bits, integration touchpoints) → `review:checklist-complete`.
3. No unresolved review comments → `review:comments-resolved`.
4. Diff stays inside task scope → `review:scope-matches-task`.
5. Satisfy `evidence_logged` one of two ways: commit
   `.agent-grounding/evidence/<branch-name>.jsonl` via `review-claim-gate
   export` (with at least one valid JSONL entry, no label needed), or add
   `review:evidence-logged` to force it.

The Check-Run flips to ALLOWED once all five prereqs are satisfied
(labels, or a committed evidence file for `evidence_logged`).

## Reading a BLOCKED verdict

A `merge-approval` Check-Run scored **0/100 BLOCKED** with **"Evidence entries: 0"**
almost always means **no evidence exists under the branch-name key** (no
committed `.agent-grounding/evidence/<branch>.jsonl`, no ledger rows for
`session = <branch>`, and `review:evidence-logged` not applied) — **not that the
gate is broken.** Because the key is the branch name, evidence logged under a
grounding-session id (e.g. `gs-agent-grounding-…`) will not be found; use
`review-claim-gate export --task-id <branch-name> --from-session <gs-id>` to
rewrite it under the branch key without re-logging (`README.md:75-78#"having to re-log the findings."`). Missing
prereqs are also listed in the verdict's `next_steps` (`README.md:36#"Missing prereqs surface in"`).

## How to re-trigger after backfilling

The workflow triggers on these `pull_request` types (`merge-approval.yml:4-11#"ready_for_review"`):
`opened`, `reopened`, `synchronize`, `labeled`, `unlabeled`, `ready_for_review`.
So a **new event** is required to re-evaluate — either:

- a **new/removed label** (`labeled` / `unlabeled`) — the normal path after you
  add `review:*` labels; or
- a **new commit** (`synchronize`).

A previously finished `pull_request` run **cannot be "Re-run" into passing**:
re-running replays the original event payload (same labels), so it re-reads the
same flags. After backfilling evidence or fixing a dimension you must generate a
fresh `labeled`/`unlabeled`/`synchronize` event. `concurrency` is keyed per PR
number with `cancel-in-progress: true` (`merge-approval.yml:19-21#"cancel-in-progress: true"`), so the
newest event's run supersedes any in-flight one. (Re-trigger claim verified
against the `on:` block: `labeled`/`unlabeled`/`synchronize` are all present.)
