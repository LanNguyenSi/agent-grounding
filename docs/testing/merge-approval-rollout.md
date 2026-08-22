# merge-approval: rollout notes

`.github/workflows/merge-approval.yml` runs the
[`review-claim-gate` action](../../packages/review-claim-gate/action/)
on every pull request and posts a `merge-approval` Check-Run. When the
`merge-approval` check is marked **Required** in branch-protection for
`master`, the Check-Run is a hard merge gate — a reviewer cannot click
"Merge" until the gate returns `allowed: true`.

## How the gate is driven

Four of the five prerequisites (`tests_pass`, `review_checklist_complete`,
`no_unresolved_review_comments`, `scope_matches_task`) come only from **PR
labels**. `evidence_logged` can be satisfied either way: by the
`review:evidence-logged` label (forces it true) or by a committed evidence
file, per the section below. As the reviewer confirms each dimension, they
add the corresponding label:

| Label                             | Gate prereq                        |
| --------------------------------- | ---------------------------------- |
| `review:tests-pass`               | `tests_pass`                       |
| `review:checklist-complete`       | `review_checklist_complete`        |
| `review:comments-resolved`        | `no_unresolved_review_comments`    |
| `review:scope-matches-task`       | `scope_matches_task`               |
| `review:evidence-logged`          | `evidence_logged`                  |

Any label change re-runs the workflow (the event types include
`labeled` / `unlabeled`), so the Check-Run updates as the reviewer
ticks boxes.

`task-id` is the PR's head branch name — stable across commits on the
branch and visible in both the PR UI and the Check-Run summary.

## What is enforced, and what is still honour-system

Iteration 2 has shipped on the CLI/action side: the `review-claim-gate`
action auto-detects a **committed evidence file**
(`.agent-grounding/evidence/<task-id>.jsonl`) in the checked-out workspace
and counts it, provided the file has at least one valid JSONL entry, with no
workflow wiring needed. When the reviewer commits that file via
`review-claim-gate export`, CI does cross-check that actual evidence exists
for the task id.

What remains honour-system is the `review:evidence-logged` label
force-override: adding that label sets `evidence_logged=true` regardless of
whether a committed evidence file backs it up, the same as the other four
label-driven prereqs (`tests_pass`, `review_checklist_complete`,
`no_unresolved_review_comments`, `scope_matches_task`), which still have no
CI-side check beyond the reviewer's own label tick. See follow-up task
[`5ea6d7cf`](https://agent-tasks.opentriologue.ai/tasks/5ea6d7cf-51ee-4669-9832-2f58a44d424c)
for tracking history.

## Making the check Required

One-off setup, after the workflow has run at least once on a PR (so the
check name appears in GitHub's settings UI):

1. Repo → Settings → Branches → Branch protection rules → Edit rule for `master`.
2. Enable **Require status checks to pass before merging**.
3. Add `merge-approval` to the required checks list.
4. Keep **Require branches to be up to date before merging** on (existing setting).

Equivalent via `gh api` (requires `Admin` access):

```bash
gh api -X PATCH repos/LanNguyenSi/agent-grounding/branches/master/protection \
  --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["ci", "merge-approval"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
JSON
```

(Leave the existing `ci` check in the list; add `merge-approval`
alongside it.)

## Reviewer flow — cheat sheet

1. CI goes green → add `review:tests-pass`.
2. Walk the checklist (correctness, security/scope, permissions,
   minimal diff, open questions from the task, backend invariants, docs
   coherence, test coverage of risky bits, integration touchpoints) →
   add `review:checklist-complete`.
3. Confirm no unresolved review comments → `review:comments-resolved`.
4. Confirm the diff stays inside the task scope → `review:scope-matches-task`.
5. Satisfy `evidence_logged` one of two ways: commit
   `.agent-grounding/evidence/<branch-name>.jsonl` via `review-claim-gate
   export` (with at least one valid JSONL entry, no label needed), or log
   ≥1 evidence-ledger entry under `session = <branch-name>` (e.g. `ledger
   fact "…" --session feat/foo`) and add `review:evidence-logged` to force
   it.

The Check-Run flips to `ALLOWED` once all five prereqs are satisfied
(labels, or a committed evidence file for `evidence_logged`). Merge.
