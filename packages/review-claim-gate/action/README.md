# merge-approval GitHub Action

Composite GitHub Action that evaluates the `merge_approval` claim-gate
(from [`review-claim-gate`](../)) and posts the verdict as a Check-Run
on the pull request. When combined with branch-protection's **Required
checks** setting, it turns the review checklist from a norm into a
mechanical merge gate — a reviewer who skips a dimension cannot click
merge.

## Usage

```yaml
# .github/workflows/merge-approval.yml in your consumer repo

name: merge-approval
on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]

permissions:
  checks: write          # required to post the Check-Run
  pull-requests: read

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: LanNguyenSi/agent-grounding/packages/review-claim-gate/action@master
        with:
          # Session key the reviewer has been logging evidence under.
          # Convention: the branch name or the agent-tasks task id.
          task-id: ${{ github.event.pull_request.head.ref }}
          pr-number: ${{ github.event.pull_request.number }}

          # Other prereqs — flip to `true` as reviewer confirms each.
          # Typically these are wired to other workflow jobs (e.g. the
          # test matrix sets tests-pass via an output).
          tests-pass: ${{ needs.test.result == 'success' }}
          review-checklist-complete: 'false'
          comments-resolved: 'false'
          scope-matches-task: 'false'

          # Evidence-ledger DB path, relative to workspace root.
          evidence-ledger-path: .evidence-ledger/db.sqlite

          github-token: ${{ secrets.GITHUB_TOKEN }}
```

Pin to a tag for stability: `@v1` once a release is cut; `@master`
tracks the latest until then.

## Required branch protection

To turn the Check-Run into a hard gate:

1. Repo → Settings → Branches → Branch protection rules → Add rule.
2. Apply to `master` (or `main`).
3. Enable **Require status checks to pass before merging**.
4. Add `merge-approval` to the required checks list (you may need to
   push one PR first so the check name appears in the search box).

After this is set, a PR with `BLOCKED` verdict cannot be merged via the
GitHub UI — even with an approving review.

## Inputs

| Input                        | Required | Default                          | Description                                                          |
| ---------------------------- | -------- | -------------------------------- | -------------------------------------------------------------------- |
| `task-id`                    | yes      |                                  | agent-tasks task id / ledger session key                             |
| `pr-number`                  | no       | (from event context)             | PR number for Check-Run context                                      |
| `evidence-ledger-path`       | no       | `.evidence-ledger/db.sqlite`     | Path to the evidence-ledger SQLite DB                                |
| `fail-on-block`              | no       | `true`                           | When `true`, the step exits non-zero if the gate blocks              |
| `tests-pass`                 | no       | `false`                          | Flip to `true` when the test suite is green                          |
| `review-checklist-complete`  | no       | `false`                          | Flip to `true` when every rubric item has been walked                |
| `comments-resolved`          | no       | `false`                          | Flip to `true` when every review comment is resolved                 |
| `scope-matches-task`         | no       | `false`                          | Flip to `true` when the PR diff stays inside task scope              |
| `evidence-logged`            | no       | `false`                          | Force `evidence_logged=true` even when the ledger is empty           |
| `github-token`               | yes      |                                  | `GITHUB_TOKEN` or a PAT with `checks:write`                          |

## Outputs

| Output        | Description                                                     |
| ------------- | --------------------------------------------------------------- |
| `verdict`     | `ALLOWED` or `BLOCKED`                                          |
| `score`       | Readiness score 0–100                                           |
| `report-path` | Path to the full JSON report in `$RUNNER_TEMP`                  |

## Evidence sources — committed file vs. local ledger

`evidence_logged` can come from three places, in this priority order:

1. **`--evidence-logged` input is `'true'`** — forces the flag. Documented in the label table. Honor-system.
2. **Committed evidence file** at `./.agent-grounding/evidence/<task-id>.jsonl` in the checked-out workspace. The CLI auto-detects this path relative to `$GITHUB_WORKSPACE` and counts valid JSON lines as the evidence count. This is the **high-integrity path** — reviewer exports their local ledger into the PR branch.
3. **Local evidence-ledger DB** at `$EVIDENCE_LEDGER_PATH` (default `.evidence-ledger/db.sqlite`). On a fresh CI runner this is always empty; only useful for local `act` runs.

### Reviewer workflow for committed evidence

```bash
# During review, log findings to your local evidence-ledger with
# session = <branch-name-or-task-id>:
ledger add --session feat/foo --type fact --content "CI green, all 94 tests pass"
ledger add --session feat/foo --type fact --content "Reviewed security/scope dimensions"

# When finishing the review, export to the convention path:
mkdir -p .agent-grounding/evidence
review-claim-gate export --task-id feat/foo \
  --out .agent-grounding/evidence/feat/foo.jsonl

# Commit it with the PR:
git add .agent-grounding/evidence/feat/foo.jsonl
git commit -m "evidence: attach ledger for merge_approval gate"
git push
```

On the next workflow run, the action finds the file, counts entries, and the Check-Run summary shows `evidence entries: N (file: /path/to/…)` instead of `(ledger)` or `(none)`. A committed `evidence_logged` signal is tamper-evident in git history in a way a PR label is not.

## Local dry-run with `act`

```bash
# Install: https://github.com/nektos/act
act pull_request -W .github/workflows/merge-approval.yml \
    -s GITHUB_TOKEN=<a PAT with checks:write>
```

Expected behaviour:
- All prereqs `true` + ≥1 evidence entry → `::group::`Run merge-approval gate` shows `allowed: true`, step succeeds, Check-Run `success`.
- Any prereq `false` → step exits 1, Check-Run `failure`, summary body lists the missing prereq verbatim.

Check-Run creation against a real repo requires a GitHub token that can
write checks; `act` with a PAT works.

## How the action works

1. `actions/setup-node@v4` — Node 22 with `npm` cache.
2. `npm ci && build:deps && build -w review-claim-gate` at the monorepo
   root (relative to the action path). Reuses the exact `merge_approval`
   policy from `review-claim-gate`; the action is a thin transport
   wrapper, never a duplicated policy.
3. Invokes `review-claim-gate check ... --json`, captures stdout into
   `$RUNNER_TEMP/merge-approval.json`.
4. `actions/github-script@v7` reads the report and calls
   `github.rest.checks.create` to post the `merge-approval` Check-Run,
   attached to the PR's head SHA.
5. If `fail-on-block=true` and the gate blocked, the final step exits 1
   so the workflow fails alongside the Check-Run.

## Out of scope

- Auto-merge on success — the consumer workflow owns that.
- GitLab / Bitbucket variants.
- Server-side integration with the agent-tasks merge webhook —
  separately tracked in agent-tasks.

## Why it is composite, not a bundled JS action

The action runs the existing `review-claim-gate` CLI end-to-end. A
bundled JS action would need to inline `better-sqlite3` (a native
module) and publish a pre-bundled `dist/index.js` — higher maintenance
overhead for no behavioural gain. Composite keeps the CLI as the single
source of truth and the consumer pays ~30s of install time per PR.
