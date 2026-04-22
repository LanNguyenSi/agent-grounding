# MCP lifecycle smoke scenarios — agent-grounding project

Three manual scenarios that exercise the agent-tasks MCP surface (and its
REST peer) against tasks that belong to the **agent-grounding project**
inside agent-tasks. Run once when the MCP contract changes or when a
new project-level precondition is added.

> **Scope note.** These scenarios do **not** test `packages/grounding-mcp`
> (the grounding session MCP server). They test the agent-tasks task
> lifecycle transitions when applied to agent-grounding-project tasks.
> The branch-precondition and claim-race semantics live in agent-tasks'
> backend, not in grounding-mcp.

Recorded: 2026-04-22 under agent-tasks task
[`e795c327`](https://agent-tasks.opentriologue.ai/tasks/e795c327-5393-4bf4-aded-fcab244dcc6e).

---

## Scenario 1 — Golden path

End-to-end: `task_create` → `tasks_update` (branchName) → `task_start` →
work (PR created, reviewed, fixes applied) → `task_finish` → PR merged.
Every transition must return 2xx.

**Evidence** — trace for the CI-hotfix task `b56be05f` (PR #7) on
2026-04-22 05:08–05:10 UTC:

1. `task_create` (MCP): task created, `status: "open"`, HTTP 200.
2. `tasks_update` (MCP) with `branchName`: HTTP 200.
3. `task_start` (MCP): `status: "in_progress"`, `expectedFinishState: "review"`, HTTP 200.
4. `pull_requests_create` (MCP): PR #7 returned, task auto-patched with
   `prUrl`/`prNumber`, HTTP 200.
5. `task_finish` (MCP) with `prUrl`: `status: "review"`, HTTP 200.
6. `pull_requests_merge` (MCP): `merged: true`, task `status: "done"`
   atomic with merge, HTTP 200.

Same flow also executed cleanly for tasks `3ec17bd1`, `865d98cb`,
`1c7b9107`, `8f36ee80` in the same session — five confirmations of the
canonical path, zero 4xx.

**Verdict: PASS.**

---

## Scenario 2 — Branch precondition

`task_start` (MCP) on an agent-grounding-project task without first
setting `branchName` is expected to return a clean 4xx citing the rule,
not a silent 200.

**MCP path — 2a**:

```text
mcp__agent-tasks__task_start({ taskId: "a4464c48-…" })
→ HTTP 422
{
  "error": "precondition_failed",
  "message": "Transition blocked — No branch recorded on this task. PATCH /api/tasks/:id with branchName first.",
  "failed": [
    { "rule": "branchPresent",
      "message": "No branch recorded on this task. PATCH /api/tasks/:id with branchName first." }
  ],
  "canForce": false
}
```

Clean 4xx, actionable guidance. **PASS.**

**REST path — 2b** (same task, same state):

```text
curl -X POST https://…/api/tasks/a4464c48-…/claim
  -H "Authorization: Bearer $AGENT_TASKS_TOKEN"
→ HTTP 200
{ "task": { "status": "in_progress", "branchName": null … } }
```

**Gate not enforced.** REST `/claim` placed the task into `in_progress`
with `branchName: null` — a state that breaks downstream assumptions
(PR creation, merge step).

**MCP path after PATCH — 2c**:

```text
PATCH HTTP 200   # set branchName
task_start → HTTP 200   # happy path
```

**Verdict: PASS with caveat.** Divergence between MCP and REST paths
is filed as agent-tasks follow-up
[`610ca95d`](https://agent-tasks.opentriologue.ai/tasks/610ca95d-f757-4da2-af39-ead8adfc3d6f)
(MEDIUM, *REST /claim bypasses branchPresent*).

A parallel finding surfaced during this smoke-test writeup:
`task_finish` also enforces a `prPresent` precondition on the MCP path
(`prUrl` must be set before transitioning to `review`). Follow-up
[`610ca95d`](https://agent-tasks.opentriologue.ai/tasks/610ca95d-f757-4da2-af39-ead8adfc3d6f)
is expected to cover it under the same shared-checker refactor.

---

## Scenario 3 — Claim race

Two parallel claims on the same open task should result in exactly one
winner (200) and one loser (409 / `conflict`).

**Same-token parallel REST claim — reproduced:**

```text
(curl … /claim &) ; (curl … /claim &) ; wait

--- Response A ---  HTTP 200
{ "task": { "status": "in_progress", "claimedByAgentId": "db8eb865-…",
            "claimedAt": "…05:43:24.970Z" … } }
--- Response B ---  HTTP 200
{ "task": { "status": "in_progress", "claimedByAgentId": "db8eb865-…",
            "claimedAt": "…05:43:24.970Z" … } }
```

Both returned 200 with identical `claimedAt` — idempotent same-agent
re-claim. Correct behaviour, not a bug: claiming a task already claimed
by the caller is a no-op.

**Cross-agent race** (the scenario's actual intent) requires two
distinct `claimedByAgentId`s. Only one token was available in this
environment, so the exclusion path could not be reproduced directly.

**Adjacent evidence** — the 409 path IS observable during a session
that already holds a claim:

```text
mcp__agent-tasks__task_start({ taskId: "<other-task>" })
→ HTTP 409
{ "error": "already_claimed",
  "message": "You already hold an active claim. Call task_finish or task_abandon on it before starting another.",
  "activeClaim": { "taskId": "…", "title": "…", "role": "author" } }
```

That proves the exclusion mechanism exists; it just triggered off the
"one-active-claim-per-agent" rule rather than the "cross-agent
contention" rule.

**Verdict: INCOMPLETE** — reproducible cross-agent race requires a
second credential. Filed follow-up
[`eba3cd52`](https://agent-tasks.opentriologue.ai/tasks/eba3cd52-4ca5-4843-a9fe-5fea927bd392)
(LOW, *two-token test fixture*).

---

## Running the smoke yourself

Minimal checklist:

- `AGENT_TASKS_TOKEN` exported (see `reference_agent_tasks_api.md` memory).
- `curl` + `node` for JSON parsing.
- An agent-grounding-project throwaway task with a description long
  enough to clear the confidence gate (score ≥ 60).

The full session transcript (including the throwaway task ids that
were created and released) lives in the comments on task
[`e795c327`](https://agent-tasks.opentriologue.ai/tasks/e795c327-5393-4bf4-aded-fcab244dcc6e).
