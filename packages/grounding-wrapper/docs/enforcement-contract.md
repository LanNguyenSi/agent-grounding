# Public API for enforcement

The contract grounding-wrapper's plan output owes a downstream enforcer, with a worked harness Policy example.

A typical pipeline that wants to *enforce* what this package recommends consumes the planner output and writes to a separate signal store (e.g. the evidence-ledger) that a Policy then reads.

A worked example for a harness Policy author:

```ts
// 1. The agent (or a session-start hook) computes the plan once
const session = initSession({ keyword, problem });

// 2. The hook emits one ledger entry per planned step, prefixed for grep-ability:
//    grounding:plan:<sessionId>:<stepIndex>:<tool>
//      payload: { phase, mandatory, description }
//
//    plus one entry per active guardrail:
//    grounding:guardrail:<sessionId>:<guardrailId>
//
// 3. A harness PreToolUse Policy then blocks a tool call until the
//    clearance entry for the guardrail exists:
//
//    policies:
//      - name: enforce-grounding-sequence
//        description: Block gh pr merge until the no-step-skipping clearance entry exists.
//        trigger:
//          event: PreToolUse
//          match: "Bash"
//          bash_match: "^gh pr merge"
//        requires:
//          ledger_tag: "<clearance tag the caller writes>"
//        hook: <name of the hooks[] entry that runs the policy>
//        enforcement: block
```

A variable in `ledger_tag` must be a harness built-in (`${SESSION_ID}`, `${REPO}`, `${BRANCH}`, `${TOOL_NAME}`, `${CWD}`) or be declared under `trigger.extract`; see [Writing custom policies](https://github.com/LanNguyenSi/harness/blob/master/docs/writing-custom-policies.md) for the authoritative schema.

The contract this package owes a downstream enforcer:

- **Stable shape**: `GroundingSession` is the source of truth; fields are not renamed without a major-version bump.
- **Pure**: `initSession` is deterministic in `keyword`+`problem` modulo `id` and `started_at`. No filesystem or network.
- **Input invariants**: `initSession` rejects keywords that would produce a degenerate session id or `resolved_scope`. A valid keyword is a non-empty string of at most `KEYWORD_MAX_LENGTH` (64) characters whose slug-normalised form (`toLowerCase()`, `[^a-z0-9]+` collapsed to `-`, leading/trailing `-` trimmed) is non-empty. So empty, whitespace-only, pure-CJK / pure-symbol, and oversize keywords throw a typed `Error`; `validateKeyword` is exported for callers that want to pre-flight the same check.
- **Idempotent advance**: `advancePhase` past `complete` is a no-op (covered by tests).
- **Terminal phase status**: when `advancePhase` transitions to `complete`, `phase_status.complete` is set to `'done'` (not left at `'pending'`). Consumers reading `phase_status` over the wire see a shape symmetric with every other transitioned-out phase.

The contract this package does **not** owe:

- Writing to the evidence-ledger. That is the caller's job.
- Knowing about harness, agent-tasks, or any specific enforcer. The output is plain JSON.
