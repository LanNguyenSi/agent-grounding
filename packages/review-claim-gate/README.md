# review-claim-gate

A claim-gate-shaped evaluator specialised for PR review / merge decisions.
Instead of asking *"has the agent verified enough to assert a diagnosis?"*
(that's `claim-gate`), this package asks *"has the reviewer done enough
to approve this merge?"* — and encodes that question as a policy the
review subagent must actually pass, not a checklist it can quietly skip.

## Why

Today's PR-review subagent workflow relies on the orchestrating Claude
session handing the reviewer a checklist in-prompt. Nothing enforces
that the reviewer actually covered every dimension — a shallow review
can return "APPROVE" after catching one obvious bug and missing four
subtle ones (see `feedback_review_briefing.md` for the 2026-04-14
Connect-Agent-Modal incident).

`review-claim-gate` closes that gap by turning the checklist into a
typed `merge_approval` policy with five prerequisites. The reviewer is
expected to collect evidence as it works (via `evidence-ledger`),
confirm the other four dimensions by passing flags, and only then the
gate returns `allowed: true`. A `--json` output makes the verdict
machine-parseable, so the parent session can refuse to proceed to
`task_finish(approve)` when the gate fails.

## The `merge_approval` policy

| Prerequisite                     | Meaning                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `tests_pass`                     | CI green or local `npm test` exit 0                                                       |
| `review_checklist_complete`      | Every rubric item (correctness, security/scope, tests, docs) ticked off                   |
| `no_unresolved_review_comments`  | Every review comment resolved or replied to                                               |
| `scope_matches_task`             | PR diff stays inside the task scope — no drive-by refactors                               |
| `evidence_logged`                | ≥1 evidence-ledger entry tagged with this PR's task id (session = task id)                |

All five must be true for `allowed: true`. Missing prereqs surface in
`next_steps` so the reviewer sees exactly what's left.

## Install

```bash
npm install review-claim-gate
```

## CLI

```text
review-claim-gate check --task-id <id> [--pr <url>]
  [--tests-pass]
  [--review-checklist-complete]
  [--comments-resolved]               # → no_unresolved_review_comments
  [--scope-matches-task]
  [--evidence-logged]                 # forces true; default derives from ledger
  [--ledger-db <path>]                # default $EVIDENCE_LEDGER_DB or ~/.evidence-ledger/ledger.db
  [--json]                            # machine-readable output
  [--claim <text>]                    # custom claim string

review-claim-gate describe            # print prereq keys + descriptions
```

Exit code: `0` if `allowed:true`, `1` otherwise.

### JSON shape

```json
{
  "taskId": "t-abc",
  "pr": "https://github.com/org/repo/pull/42",
  "evidenceEntries": 3,
  "result": {
    "claim": "PR for task t-abc is safe to merge",
    "type": "merge_approval",
    "allowed": false,
    "score": 80,
    "reasons": ["prerequisite not met: …"],
    "next_steps": ["…"],
    "prerequisites": {
      "tests_pass": true,
      "review_checklist_complete": true,
      "no_unresolved_review_comments": true,
      "scope_matches_task": true,
      "evidence_logged": false
    }
  }
}
```

## Programmatic

```typescript
import {
  evaluateMergeApproval,
  isMergeAllowed,
  type ReviewContext,
} from "review-claim-gate";

const ctx: ReviewContext = {
  tests_pass: true,
  review_checklist_complete: true,
  no_unresolved_review_comments: true,
  scope_matches_task: true,
  evidence_logged: true,
};

const result = evaluateMergeApproval(
  "PR #42 is safe to merge",
  ctx,
);
// result.allowed === true, result.score === 100
```

## Reviewer subagent template

Drop this into the review-subagent prompt you spawn from a parent Claude
session. After the reviewer completes its human-readable verdict, it
calls the CLI and returns the structured output so the parent can gate
on it.

```markdown
You are a rigorous PR reviewer. Review PR #<N> on branch `<BRANCH>` in
`<REPO>`. Task id: `<TASK-ID>`.

Walk the standard review checklist:
1. Correctness — effect/lifecycle bugs, race conditions, error paths.
2. Security / scope / least-privilege — scope creep, injection, secrets.
3. Permission gating — backend invariants for UI-surfaced controls.
4. Scope creep — anything unrelated to the task?
5. Open questions from the task description — each answered or deferred?
6. Backend invariants — does the called endpoint accept this shape?
7. Docs coherence — README/getting-started consistent?
8. Test coverage of the risky bits.
9. Integration touchpoints.

For every finding you surface, call `ledger add --session <TASK-ID>
--type <fact|rejected|unknown> --content "<one line>"` so the parent
session can audit the review.

When you finish the checklist, call:

    review-claim-gate check --task-id <TASK-ID> --pr <PR-URL> --json \
      --tests-pass                   # if CI is green
      --review-checklist-complete    # only if you actually walked every dim above
      --comments-resolved            # only if no open comments remain
      --scope-matches-task           # only if the diff stays inside the task

Print the JSON verdict as the LAST line of your response. If `allowed:
false`, your human-readable verdict MUST be REQUEST CHANGES regardless
of how minor the missing prereq looks. The parent session will parse
the JSON and refuse to proceed to `task_finish(approve)` when the gate
fails.
```

## Out of scope

- Wiring into `mcp__agent-tasks__task_finish(approve)` server-side — separately tracked.
- Auto-deriving `scope_matches_task` from a real diff — first pass is a manual flag.
- Multi-reviewer aggregation — one reviewer per claim today.

## Why a separate package and not a 10th `claim-gate` type?

The core `claim-gate` policies address *agent diagnostic claims* (root
cause, architecture, security, …) and share a single `ClaimContext`
shape (`readme_read`, `process_checked`, `has_evidence`, …). `merge_approval`
is a different ontology (`tests_pass`, `review_checklist_complete`, …).
Keeping it out of `claim-gate`'s core lets the CLI, evidence-ledger
integration, and policy evolve without churning the stable diagnostic
policies. The `MergeApprovalResult` shape intentionally mirrors
`ClaimResult`, so consumers that already parse claim-gate output do not
need a second parser.
