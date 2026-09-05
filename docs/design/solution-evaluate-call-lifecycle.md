# solution_evaluate call lifecycle: timeout, retrieval, and retry

Document date: 2026-09-05. Status: design, no code changed by this document.

Revision: Revised after architectural review round 1 (cross-process lock,
measured client capabilities, restart and retention semantics,
result-retrieval authority).

Revision (round 2 review response): Revised again after a second
architectural review round that found new issues in the cross-process
mechanisms round 1 introduced: the stale-lock reclaim was check-then-act
across two processes (now an atomic takeover, section 7); the attempt
log had no file layout or concurrent-write discipline (now specified,
section 6); the cross-process result payload silently promised diagnostics
no other process actually has (now a documented, narrower shape, section
5); startup-only reconciliation could not catch a holder dying later (now
also checked on the read path, section 6); write order and crash windows
between the marker write, the log write, and the lock release were
unstated (now fixed, section 7); the "orphaned child's eventual write
races the new attempt" claim did not hold given the parent-only
`writeVerdict` call already established in section 1 (corrected, section
7 and section 9); a single-host assumption for the on-disk lock was
unstated (now explicit, section 7); and five documentation corrections
(PR #211's merge, the sibling task's actual branch state, a bare line
number, an out-of-repo run artifact's first reference, and `markerPresent`'s
exact meaning).

## Why this document exists

`solution_evaluate` (`packages/grounding-mcp/src/server.ts`, tool
registration `'solution_evaluate'`) is a single ordinary MCP tool call that
runs the `preflight` CLI as a child process
(`packages/grounding-mcp/src/solution-verdict.ts`, function
`evaluateSolution`) and can legitimately run past the MCP SDK's default
60 second request timeout on a large repository. Today there is no lifecycle
around that call: no way for a caller to recover a result after its own
client-side timeout fires, no defined behavior when two calls for the same
id overlap, and no record of what a retry actually did to a prior attempt.
This is exactly ordered follow-up 2 from
`agent-dx/packages/agent-engineering-playbook/references/verification-handoff-first-slice.md`
("Specify caller/transport handles, terminal polling, timeout preservation,
and append-only retry history"), which this document is scoped to.

Out of scope, by the same source document's ordering and by explicit task
boundary: broader parser/error-hardening (follow-up 3, merged as PR #211,
master `eefd18fe`, 2026-09-05 18:40Z) and provenance-/snapshot-bound
result reuse (follow-up 4, owned by tracker tasks `dd7f8b18` / `65f86c2a`).
This document records the interfaces the lifecycle needs from an eventual
evidence ledger without designing that ledger.

## 1. Source map: who does what today

**Producer** (`packages/grounding-mcp/src/solution-verdict.ts`):
`evaluateSolution` validates the id and git HEAD, then shells out to the
`preflight` binary with `execFileAsync` (no `timeout` option, only
`maxBuffer: 16 * 1024 * 1024`), parses its JSON, folds in
orchestrator-workflow blockers, and calls `writeVerdict` to sign and persist
the marker at `verdictPath(id)`. There is no timeout, no cancellation
handling, and no notion of a "run" separate from the final `id`-keyed
marker: a second call for the same `id` starts a second, fully independent
`execFileAsync` invocation with no coordination between them.

**Server / MCP transport** (`packages/grounding-mcp/src/server.ts`): the
`solution_evaluate` tool registration is a plain
`server.tool('solution_evaluate', description, schema, handler)` call (the
SDK's legacy shorthand). The handler awaits `evaluateSolution` fully and
returns its result as one JSON-in-text response
(`jsonResponse(result)`, defined near the top of `server.ts`). No progress
notifications are sent, no `_meta.progressToken` is read, and the SDK's
default per-request timeout (60 s, `DEFAULT_REQUEST_TIMEOUT_MSEC` in the
installed `@modelcontextprotocol/sdk@1.30.0`,
`dist/esm/shared/protocol.js`) is therefore unmodified for this call. See
`t006-client-capabilities.md` (this task's run-evidence file, kept
out-of-repo under this workspace's `.ai/runs/` tree, not part of the
agent-grounding repository) for the exact SDK file citations.

**Client**: the three MCP clients actually registered against grounding-mcp
in this workspace (Claude Code, Codex, and, not currently, opencode) all
speak ordinary MCP tool calls over stdio; none of their local configuration
opts into progress-based timeout extension or the SDK's experimental tasks
protocol. Claude Code's own client-side behavior IS introspectable locally
(its installed binary's own strings reveal its MCP client implementation)
and is now measured, not assumed: see section 2. Codex's and opencode's
client-side behavior remains unverified (Codex's binary yields no matching
strings, which is inconclusive rather than negative for a stripped Rust
binary; opencode is not registered for this tool in this workspace at
all). Run
evidence (`t006-client-capabilities.md`) records the method and the exact
findings per client. No live long-running job was executed against any of
them to observe request/response behavior end-to-end; the Claude Code
findings come from static inspection of its installed binary, not from
watching a live session.

**Harness** (`harness` repository,
`src/policy-packs/builtin/solution-acceptance-runtime.ts`, function
`readVerdict`, and `src/policy-packs/builtin/solution-acceptance.ts`): the
harness is not a party to the `solution_evaluate` MCP call at all. It
instructs the solving agent (in its policy-pack prompt text, see
`solution-acceptance.ts`) to call
`mcp__grounding-mcp__solution_evaluate({ id })` itself, then separately
reads the signed marker file directly off disk
(`solution-acceptance-runtime.ts`, `readVerdict`, using the same
`verdictDir()` resolution order as the producer) to decide whether to allow
task-finishing tools. The harness never receives an MCP response from
`solution_evaluate` and never calls it. Any lifecycle contract for the MCP
call itself is therefore invisible to the harness gate as long as the
marker file it reads is still written correctly once the call eventually
finishes; the harness path is unaffected by everything in section 3 below.

## 2. Client capability table

| Client | Registered here | Progress reset on timeout | Experimental tasks protocol | Ordinary tool calls |
| --- | --- | --- | --- | --- |
| Claude Code (stdio) | Yes, via local client config | Measured: implemented but defaults to off, and not enabled by this workspace's config; separately, this client's own per-server tool timeout is documented as a hard wall-clock limit that progress notifications do not extend regardless of the reset setting | Measured: this client's own MCP implementation speaks `tasks/get`, `tasks/result`, `tasks/list`, `tasks/cancel`, gated behind a server-advertised capability | Yes (in production use today) |
| Codex (stdio) | Yes, via local client config | unknown (inconclusive: a binary-strings scan found no match, which does not rule support out for a stripped Rust binary) | unknown (same reason) | Yes (in production use today) |
| opencode | No (not registered for this tool in this workspace's local-LLM lane config) | unknown (not registered, so not locally verifiable for this tool) | unknown (same reason) | Not currently wired to this tool |

Full detail, exact file/binary paths, the measurement method (a
`strings`-based scan of the installed Claude Code binary; see
`t006-client-capabilities.md`), and the reasoning behind each remaining
"unknown" is in the run-evidence file `t006-client-capabilities.md`
(referenced, not duplicated here per this workspace's placement convention:
host paths, binary locations, and per-machine specifics live in the run
artifact, not in this product document).

Claude Code's per-server tool-call timeout is a distinct mechanism from the
MCP SDK's own `DEFAULT_REQUEST_TIMEOUT_MSEC` (section 1): it is resolved
from a per-server config value (when at least 1000 ms) falling back to an
environment variable and then a client-side default, clamped to a fixed
range, and is documented by the client itself as a hard wall-clock limit
per call that progress notifications do not extend. Treat this as the
governing deadline for Claude Code specifically, not the SDK's 60 s
constant (section 5 revises the internal-bound guidance accordingly).

No client capability is asserted as supported anywhere in this document
without a config, SDK, or (for Claude Code) client-binary citation backing
it. The chosen contract (section 4-C, section 5) still works over ordinary
MCP tool calls only, which all three clients demonstrably use today, and
depends on neither progress reset nor the experimental tasks protocol being
supported by any client, even though Claude Code is now confirmed to
support the latter.

## 3. What "standard progress" solves, and what it does not

The sibling task (agent-grounding tracker id `8c9a99fc`) proposes adding
standard MCP progress
notifications during `solution_evaluate`, mirroring the pattern already
shipped in `agent-preflight/src/mcp.ts` (`withProgressPings`,
`DEFAULT_PROGRESS_INTERVAL_MS = 10_000`): if the caller supplied
`_meta.progressToken`, ping it periodically while the child process runs.
Its own state, checked with `git branch -a --list '*8c9a99fc*'` and
`gh pr list`: a local branch `feat/8c9a99fc-evaluate-progress` exists on
this machine, but neither command found a corresponding commit reachable
from any remote ref (`git log --all` shows no unique commits on it at the
time of this check) nor an open PR; treat the task as not yet landed
anywhere shared, not as untouched.

This is a real, low-risk, additive improvement, and this design treats it
as a complementary layer, not a substitute:

- It solves nothing unless the caller both opted in with a
  `progressToken` and the caller's own client implementation resets its
  timeout on receiving one (`resetTimeoutOnProgress`). For Claude Code this
  is now measured, not unconfirmed, and the answer is negative under
  today's config: `resetTimeoutOnProgress` defaults to off and nothing in
  this workspace's client config turns it on; independently, Claude Code
  documents its per-server timeout as a hard wall-clock limit that progress
  notifications do not extend regardless (section 2). Progress pings
  therefore do NOT extend Claude Code's own deadline for this call today.
  For Codex and opencode both remain unconfirmed (section 2).
- It gives the caller no identifier to recover a result if it disconnects,
  its client crashes, or it simply did not opt in and hit the 60 s
  default. There is no handle in a progress ping; a progress notification
  carries no attempt or run id.
- It does nothing for retry semantics: nothing about progress pings
  prevents, coordinates, or records a second `solution_evaluate` call
  arriving for the same id while the first is still running.
- It does nothing for restart, disconnect-then-reconnect, or an
  append-only history of attempts.

Standard progress is therefore the right mechanism for keeping a single
patient, still-connected caller's timeout from firing during the common
case (a run that finishes in, say, 90 seconds and the caller stays
connected the whole time). It is not, by itself, a call lifecycle. Section
4 below builds the lifecycle underneath it, and recommends still sending
progress pings on the synchronous fast path as an ergonomics layer over
that lifecycle, not instead of it.

## 4. Alternatives considered for the lifecycle contract

Three candidates were compared, per the tracker's acceptance criterion 2.

### A. Standard progress only

Described in section 3. Rejected as the sole contract: does not address
retrieval after a timeout with no progress opt-in, does not address
retry/concurrency, does not address restart. Kept as a complementary,
additive layer over whichever contract is chosen.

### B. SDK experimental "tasks" feature

The installed SDK (`@modelcontextprotocol/sdk@1.30.0`) ships a real,
working implementation of task-augmented tool calls:
`McpServer.experimental.tasks.registerToolTask` with a
`ToolTaskHandler { createTask, getTask, getTaskResult }`, states
`working | input_required | completed | failed | cancelled`
(`dist/esm/types.d.ts`, `TaskStatusSchema`), and protocol messages
`tasks/get`, `tasks/result`, `tasks/list`, `tasks/cancel`. This is
conceptually the closest match to what this document ends up
recommending.

Rejected for a v1 lifecycle contract on this specific tool, for three
compounding reasons, not because the shape is wrong:

1. Most of `dist/esm/experimental/tasks/` is marked `@experimental`, "may
   change without notice" verbatim in the SDK's own source
   (`interfaces.d.ts`, `server.d.ts`, `mcp-server.d.ts` all carry the tag).
   The wire-level type definitions in `dist/esm/experimental/tasks/types.d.ts`
   (which declare `TaskStatusSchema` and the protocol message shapes) do
   NOT themselves carry an `@experimental` tag, so the disclaimer is
   narrower than "everything under this path is unstable"; it still covers
   the high-level registration API (`registerToolTask`) and the
   persistence interfaces this design would actually have to code against,
   so the objection stands for those surfaces even though the wire types
   are not separately flagged.
2. Adopting it is not a configuration tweak. The current registration
   (`server.ts`, `server.tool('solution_evaluate', ...)`) uses the SDK's
   legacy shorthand, whose config shape has no `execution` field at all.
   Even the newer `registerTool` config in this installed version
   (`dist/esm/server/mcp.d.ts`, the `registerTool` overload) has no
   `execution` field either; only `registerToolTask` exposes
   `execution.taskSupport`. Adopting task support still means migrating
   the registration shape and wiring the `RequestTaskStore` interface
   (`dist/esm/shared/protocol.d.ts`) and a task message queue for the tool
   handler to use. This is real, non-trivial work, but it is cheaper than
   this document previously stated: the SDK ships ready-made
   implementations of both roles, `InMemoryTaskStore` and
   `InMemoryTaskMessageQueue`
   (`dist/esm/experimental/tasks/stores/in-memory.d.ts`), so a v1 adoption
   would not need to build persistence from scratch, only wire the
   registration migration around an existing in-memory store. The
   objection here is the migration itself, not a from-scratch persistence
   build.
3. Whether Codex or opencode understand the experimental tasks protocol
   messages at all is unknown from local material (section 2; Codex's
   binary yields no matching strings, inconclusive for a stripped Rust
   binary; opencode is not registered for this tool). Claude Code's OWN
   client, however, is now confirmed to implement `tasks/get`,
   `tasks/result`, `tasks/list`, and `tasks/cancel` behind a
   server-capability gate (section 2); this specific "no client supports
   it" objection no longer holds for Claude Code. Committing the sole
   completion-gate producer's call lifecycle to a capability confirmed for
   only one of the (at most) two clients in active use, with the other's
   support still unknown, remains a partial-coverage bet this design
   declines to make for v1.

Revisit this option once the feature graduates out of `@experimental` for
the registration/persistence surfaces in reason 1, or once Codex's (and,
if wired, opencode's) support can be verified, whichever comes first; not
before either one.

### C. Ordinary start/status/result tool API (chosen)

Add two new, ordinary MCP tools, `solution_evaluate_status` and
`solution_evaluate_result`, alongside the existing `solution_evaluate`
(which keeps its name and its fast synchronous path, but gains a bounded
wait and a handle for the slow path). This is deliberately shaped like the
experimental tasks API's three-verb split (`createTask` /
`getTask` / `getTaskResult`) but implemented as our own explicit tools
using only ordinary MCP tool calls, so it depends on no experimental
protocol feature and no unverified client capability. Chosen because it
works with every client that can already call `solution_evaluate` today,
keeps the existing verdict/marker/gate contract completely unchanged, and
gives this design full control over the exact retry and concurrency rules
required by acceptance criteria 3 and 5 (sections 6 to 8 below), which the
experimental API's own generic task semantics do not specify for this
particular producer.

Trade-off accepted: two new tool names add to grounding-mcp's tool surface
and need their own documentation (README, this design's briefs); the retry
vs. poll distinction has to be taught to the calling agent (via the
harness policy-pack prompt text and the README), rather than enforced by
protocol-level capability negotiation the way option B would.

## 5. Chosen contract

### Identifiers

- `id` (existing, unchanged): caller-supplied, scopes the signed verdict
  marker exactly as today (`verdictPath(id)`,
  `packages/grounding-mcp/src/solution-verdict.ts`). One live marker per
  `id`. Signing, the 7 pinned `Verdict` fields, `evaluateGate`, and
  `solution_gate` are untouched by this design.
- `attemptId` (new): server-generated (for example `crypto.randomUUID()`),
  opaque, never derived from caller input. Scopes exactly one physical
  `evaluateSolution` invocation (one `preflight` child process). Many
  attempts accumulate over time for one `id`; at most one attempt per `id`
  may be in the `running` state at a time (enforced by the join rule in
  section 7). Because it is never caller-supplied, `attemptId` needs no
  path-traversal or injection guard analogous to `sanitizeVerdictId`; an
  unrecognized `attemptId` simply resolves to the `unknown` state (section
  6), never to a file-system or command lookup.
- Keying: the in-flight lock, the in-memory attempt registry, and the
  append-only attempt log (sections 6, 7) are all keyed on
  `sanitizeVerdictId(id)`, the same sanitized form `verdictPath(id)`
  already uses, not on the raw caller-supplied `id`. This matches today's
  marker-path keying exactly: two distinct raw ids that sanitize to the
  same string already share one verdict marker file today
  (`sanitizeVerdictId`, `packages/grounding-mcp/src/solution-verdict.ts`),
  and under this design they also share one lock, one registry slot, and
  one attempt-log stream. Repairing that id-collision surface (making
  `sanitizeVerdictId` collision-free, or detecting and rejecting colliding
  ids) is explicitly OUT OF SCOPE for this document: it is a pre-existing
  property of the marker path this design inherits unchanged, not a new
  defect this design introduces, and PR #211 already discloses it as a
  known, un-closed residual (quoted in full in section 7). No tracker task
  currently owns closing it; this document does not create one, since
  id-collision repair is orthogonal to the call-lifecycle contract itself.

### States

Per attempt, not per verdict (a `Verdict.ready` of `true` or `false` is
orthogonal to attempt status; a `false`-ready verdict is still a
`completed` attempt):

- `running`: non-terminal. A response reporting `running` for an attempt
  must always carry its `attemptId`; a `running` result without a handle is
  a contract violation, not a valid response shape (per the tracker's
  acceptance criterion 2 wording).
- `completed`: terminal. Carries the existing `EvaluateResult` shape
  (`verdict`, `markerPath`, `diagnostics`) unchanged. A synchronous,
  same-call terminal result (the common, fast case) needs no `attemptId`
  at all; the response is identical to today's `solution_evaluate`
  response, with an added `status: "completed"` field an existing caller
  can ignore.
- `failed`: terminal. Carries the existing `EvaluateResult.error` shape.
  Every path that already returns `EvaluateResult.error` today (invalid
  id, unresolved HEAD, missing `preflight` binary, unparseable output, and,
  since PR #211 merged (master `eefd18fe`), the stricter outcome-validation
  failures) maps directly onto this state; no new failure modes are
  introduced by this document.
- `unknown`: terminal-ish, reserved for a lookup by `attemptId` (or by
  `id`, resolving to a lookup's own recorded attempt) that no in-memory
  registry, on-disk lock (section 7), or on-disk attempt-log entry (section
  6) can account for; typically because the `grounding-mcp` process that
  tracked it restarted and lost the in-memory record while the log entry
  itself was still `running` and its holder's PID is now dead (the
  reconciliation pass in section 6 is what actually assigns this status;
  it is never inferred merely from "we don't have an opinion"). Once an
  attempt is reported `unknown`, it must remain `unknown` in any persisted
  attempt history forever; a later, successful marker for the same `id` is
  recorded as a new, distinct attempt and never retroactively treated as
  evidence that the `unknown` attempt itself succeeded ("retry never
  upgrades unknown to success", tracker acceptance criterion 3).
  Critically, `unknown` does NOT by itself license starting a new attempt
  for that `id` (section 7 corrects this: the license to start a new
  attempt is governed by the on-disk lock's liveness, not by what the
  prior attempt's reported status happens to be).
- `expired` (new): terminal-ish, reserved for an attempt whose full log
  entry has been pruned by the retention/rotation policy (section 5,
  "Restart, retention, cleanup, log access") after it had already reached
  a genuine terminal state (`completed` or `failed`). Distinct from
  `unknown` on purpose: `expired` means the attempt's outcome IS known to
  have been terminal, the detail was simply not retained long enough for
  this lookup; `unknown` means the attempt's fate was never established at
  all. `expired` carries none of `unknown`'s "never upgrade" bookkeeping
  requirement (there is nothing to protect against upgrading, since the
  attempt's terminal-ness is already established), but it participates in
  the same "does not license a bypass" rule as `unknown`: an `expired`
  prior attempt does not itself license a new attempt for that `id`; the
  lock-liveness check in section 7 still governs.

### Tools

- `solution_evaluate({ id, repoPath?, forceNewAttempt? })` (existing name,
  extended behavior): if no attempt is currently `running` for `id`, starts
  one. If an attempt for `id` is already `running`, this call joins it
  (section 7) instead of starting a second `preflight` process, unless
  `forceNewAttempt: true` is set, which is only honored when no attempt for
  `id` is currently `running` (see section 7 for why "force while running"
  is refused rather than honored). The call then waits, optionally
  emitting standard progress notifications on the section 3 layer, up to
  an internal bound safely under the calling client's actual governing
  deadline (a configurable value with a documented default; see "Timeout
  vs. process lifetime" below for why this must not simply assume the
  SDK's 60 s constant). If the attempt reaches a terminal
  state within the bound, the response is the terminal `EvaluateResult`
  exactly as today, plus `status` and, when useful for later lookup,
  `attemptId`. If the bound elapses first, the response becomes
  `{ status: "running", attemptId, id, pollAfterMs }`; the caller now has a
  handle to poll even though its own request already returned.
- `solution_evaluate_status({ id, attemptId? })` (new): read-only, always
  fast, never blocks. Returns `{ attemptId, id, head, status, startedAt,
  lastUpdatedAt }` for the named attempt, or, when `attemptId` is omitted,
  for the latest attempt recorded for `id`. This is the "the client's own
  request already timed out and it has no handle" recovery path: a caller
  that never received an `attemptId` (because its client gave up before
  the response arrived, with no progress opt-in) can still ask "what is the
  latest attempt for this id" without knowing an `attemptId` at all.
- `solution_evaluate_result({ id, attemptId? })` (new): returns a
  terminal-outcome payload once the attempt is `completed` or `failed`; if
  the attempt is still `running`, returns `{ status: "running", attemptId
  }` rather than blocking (unlike `solution_evaluate`'s own bounded wait).
  Same `attemptId`-omitted fallback to "latest attempt for id" as
  `solution_evaluate_status`.

  The exact SHAPE of a terminal payload depends on which process answers
  the call, because `diagnostics` and an `error` string exist only in the
  memory of the process whose own `evaluateSolution` invocation produced
  them (`solution-verdict.ts`, `evaluateSolution`); neither is persisted
  verbatim across a process boundary (section 6 persists only a short
  summary, an `outcomeClass`, and, for a failure, the `error` string
  itself, never the full diagnostics payload):
  - When the answering process is the SAME process whose in-memory attempt
    registry created this attempt (the common case: the same
    `grounding-mcp` process the caller originally reached, still holding
    the attempt in memory), the response is the FULL, existing
    `EvaluateResult` shape (`verdict`, `markerPath`, `diagnostics`,
    `error?`) unchanged, plus `status`, `attemptId`, `isLatestForId`,
    `markerPresent`.
  - When the answering process does NOT own the attempt in its in-memory
    registry (a different process than the one that ran it, the same
    process after a restart that only reconciled the attempt log, or a
    process that only ever saw a foreign-held on-disk lock, section 7),
    the response uses a documented, REDUCED shape:
    `{ status, attemptId, isLatestForId, markerPresent, outcomeClass,
    summary, error? }`, with `verdict` and `markerPath` included only when
    BOTH `isLatestForId` and `markerPresent` hold (re-checked at read
    time, below), re-read from the marker file itself, never from any
    in-memory or logged copy. `outcomeClass` (`ready` / `not-ready` /
    `error`) and `summary` are the same fields persisted in the attempt
    log (section 6); `error`, when present, is the persisted error STRING,
    not the full `EvaluateResult.error` object a same-process answer might
    carry if that shape ever differs.

  This narrowing for a cross-process answer is intentional, not an
  oversight: full `EvaluateResult.diagnostics` never crosses a process
  boundary through this design, because nothing in this design persists it
  in full. A caller that needs the full diagnostics payload for an attempt
  some OTHER process ran must accept the reduced shape or arrange to ask
  the owning process. Brief 01 adds a test asserting the exact payload for
  both a same-process lookup and a cross-process (or post-restart) lookup,
  for a completed and for a failed attempt.

  Every response also carries `isLatestForId` (is this the latest recorded
  attempt for its sanitized id, re-checked against the attempt log at read
  time) and `markerPresent` (does a marker file actually exist right now at
  `markerPath`, re-checked with a fresh filesystem read at response time,
  not cached from when the attempt finished). `markerPresent` asserts only
  that a marker file exists at this attempt's sanitized id; it makes no
  claim about AUTHORSHIP (that this attempt is the one that wrote the
  marker currently there, as opposed to a newer attempt having overwritten
  it) either way. The only authority for whether a marker is valid to gate
  on remains `solution_gate` re-reading the marker at the current HEAD
  (section 8); `isLatestForId`/`markerPresent` are read-only lookup
  conveniences for this attempt-history surface, never a substitute for
  that check. When `isLatestForId` is false, meaning the marker this
  attempt wrote has since been invalidated and replaced by a newer attempt
  for the same `id` (`invalidateVerdict`, section 7), the response omits
  (or nulls) `verdict` and `markerPath` entirely, regardless of which
  process answers, and returns only `status`, `outcomeClass`, and
  `summary`; it never hands back a `verdict`/`markerPath` pair that could
  point at a file `invalidateVerdict` has already removed. See section 8.

`solution_gate` is unchanged: it still only reads the signed marker file
and never reasons about attempts.

### Poll rules

- Reconnect/query of the same attempt: calling `solution_evaluate_status`
  or `solution_evaluate_result` with a known `attemptId`, or calling
  `solution_evaluate({ id })` again while that id's attempt is still
  `running` (the join case, section 7), are all reconnects to the SAME
  attempt. None of them start a new `preflight` process.
- Explicit new retry: calling `solution_evaluate({ id })` (with or without
  `forceNewAttempt`) starts a genuinely new attempt with a new `attemptId`
  and a new `preflight` process ONLY when the on-disk lock for that `id`
  (section 7) is not currently held by a live process. A prior attempt's
  reported STATUS (`completed`, `failed`, `unknown`, or `expired`) is
  informational, not the gate: in particular, an attempt reported
  `unknown` or `expired` because this process's in-memory registry lost
  track of it does NOT by itself license a new attempt while an orphaned
  `preflight` process might still be running and might still hold the
  lock (this closes the restart-race in section 9, blocker 2, and in the
  producer brief). The one override is an explicit `forceNewAttempt: true`
  while a live lock exists, which is refused by default (section 7) and,
  if a future revision chooses to honor it under some operator-controlled
  condition, must be logged when honored.
- A caller may always ask "what happened to `id`" via
  `solution_evaluate_status({ id })` / `solution_evaluate_result({ id })`
  without an `attemptId`, resolving to the latest attempt. This closes the
  case where a caller's own request timed out with no payload at all
  (section 3) and it never learned any `attemptId`.

### Timeout vs. process lifetime vs. disconnect/cancel behavior

- The internal wait bound inside `solution_evaluate` governs only how long
  that ONE request blocks. It must be a configurable value with a
  documented default, not a number derived from an assumed constant: this
  document previously sized it against the SDK's 60 s
  `DEFAULT_REQUEST_TIMEOUT_MSEC`, but that constant is not the governing
  deadline for every client. For Claude Code specifically (section 2), the
  governing deadline is a per-server, client-side hard wall-clock limit
  per call, independent of the SDK's server-side default and NOT extended
  by progress notifications under any configuration; its exact value is a
  local client-config matter (documented range in
  `t006-client-capabilities.md`), not a fixed number this design can
  assume. The bound must therefore stay safely under whichever deadline
  actually governs the calling client, and the implementation must not
  hardcode "under 60 s" as if that were true for every client; it is
  configurable so an operator can tune it to the client(s) actually in
  use.
- The underlying `preflight` child process's lifetime is decoupled from
  any individual request's timeout or from a transport disconnect. This
  document recommends NOT killing the child process when the request that
  started it disappears (client-side timeout, or a genuine
  `notifications/cancelled` for that request id, or a transport
  disconnect): the entire point of an eventual-result guarantee is that
  the real, running verification keeps running and its result becomes
  observable later via `solution_evaluate_status` /
  `solution_evaluate_result` or, once terminal, via the signed marker
  itself. The accepted cost is that an abandoned caller's run keeps
  consuming CPU and IO until it finishes on its own; this is the same
  trade `execFileAsync`'s current lack of any `timeout` option already
  makes today, just now made deliberately instead of by omission.
- This recommendation is flagged as a blocker for confirmation, not an
  implementation-ready decision, because whether the SDK's stdio transport
  actually delivers a `notifications/cancelled` or an abrupt process exit
  for a real Claude Code / Codex session (as opposed to a short-lived
  streamable-HTTP test client) was not exercised against a live long-running
  job for this document (see section 9).

### Restart, retention, cleanup, log access

- Restart: grounding-mcp's in-memory attempt registry (the per-process
  "currently running attempt" cache) does not survive a process restart.
  An `attemptId` issued before a restart, looked up against the restarted
  process's now-empty in-memory registry alone, would incorrectly appear
  unknown even if the underlying `preflight` process (or the on-disk lock
  and log entry describing it, section 6, section 7) is still live; this
  is exactly the race H3 in the review round closed. A
  `solution_evaluate_status`/`_result` lookup therefore always falls back
  to the on-disk lock and attempt log, not only the in-memory registry,
  before concluding `unknown`; it resolves to `unknown` only when the log
  entry itself is `running` with a dead holder PID, confirmed and recorded
  either by the startup reconciliation pass or by this very lookup's own
  read-path liveness check (section 6, "Read-path liveness"), never merely
  because this process's own in-memory cache is cold, and never only at
  the next restart. A restart must never silently report `running`
  forever, and must
  never treat "in-memory registry has no record" as sufficient by itself
  to license starting a new attempt (see "Poll rules" above and section
  7). Whether the underlying orphaned `preflight` child process itself is
  killed when its parent `grounding-mcp` process exits (Node's
  `execFileAsync` without `detached: true`, platform-dependent
  process-group behavior) was not verified for this document; section 7's
  lock design bounds the resulting risk with a stale-lock timeout rather
  than resolving it outright, and it remains a listed blocker in section
  9.
- Retention/cleanup: terminal attempts are pruned from the in-memory
  registry and compacted in the on-disk attempt log after a bounded
  retention window past their terminal timestamp (a configuration value,
  analogous in spirit to the SDK's own `TaskCreationParams.ttl`). Fixed
  invariant (not an implementation-brief decision): the retention window
  MUST exceed the `pollAfterMs` value `solution_evaluate` advertises to a
  caller by a stated safety margin, so a caller that follows the
  advertised poll cadence can never have its target pruned out from under
  it before its next poll lands. Compaction does not fully delete a
  pruned, formerly-terminal entry; it replaces the full entry (outcome
  summary, diagnostics) with a small, much-longer-retained tombstone
  (`attemptId`, `id`, terminal-outcome class, prune timestamp) so a later
  lookup can still distinguish "this attempt existed and finished, its
  detail was pruned" (`expired`, above) from "this attempt's fate was
  never established" (`unknown`, above); a pruned attempt resolves to
  `expired`, never `unknown`, and, like `unknown`, does not by itself
  license a new attempt (the lock-liveness check in section 7 still
  governs). The exact retention/rotation numbers themselves remain an
  implementation-brief decision (section 10); the invariant that retention
  exceeds `pollAfterMs`, and that pruning produces `expired` rather than
  `unknown`, is fixed here.
- Log access: `solution_evaluate_status` and `solution_evaluate_result`
  are the log-access surface this design adds. They read the append-only
  attempt log and, for a still-running attempt, the on-disk lock (section
  7), falling back to the in-memory registry only as a same-process fast
  path; none of these lookups touch the signed marker's gate authority.

## 6. Append-only retry history

A new, separate append-only attempt log records the history of every
attempt made for an `id`. This log is DISTINCT from the single, signed,
overwritten verdict marker (`verdictPath(id)`, unchanged by this design):
the marker is gate authority for exactly one `id` at exactly one HEAD; the
log is an audit/history trail across every attempt ever made for that
`id`, mirroring the "diagnostics are advisory, never gate authority"
separation already established for the diagnostics field
(`docs/okf/solution-acceptance-verdict-contract.md`, "Advisory preflight
diagnostics"). Because this log is the cross-process source of truth for
what happened to an `id` (section 7's lock only tells a caller that an
attempt is currently live, not what any past attempt did), it must itself
live on disk, shared the way `verdictDir()` already is.

### Log file layout (closes review round 2 finding H3)

One file per sanitized id, alongside that id's lock and verdict marker:
`path.join(verdictDir(), \`${sanitizeVerdictId(id)}.attempts.jsonl\`)`.
Each line is one self-contained JSON record, appended via an `O_APPEND`
open; a record already written is NEVER mutated in place, only ever
superseded by a LATER record for the same `attemptId`. A reader loads the
whole file, groups records by `attemptId`, and for each id takes the LAST
record appended (last-record-wins); "the latest attempt for `id`" is the
attempt whose `start` record has the latest `startedAt` among the
attemptIds still present (not yet compacted away, below).

Every record carries `attemptId`, `id`, and a `kind`. Exactly four kinds
exist:

1. `start`: `head`, `startedAt`, holder PID, status `running`. Written
   once, the moment an attempt's lock is acquired (section 7), before the
   `preflight` child process is spawned, by the attempt's own process.
   Without this write, a lookup mid-run, before any terminal record
   exists, has nothing to read at all; this is the fix for a prior
   round's gap. The component responsible is the same module that owns
   the lock, `solution-attempt-log.ts` (suggested name, brief 01), invoked
   synchronously in the same call that acquires the lock.
2. `terminal`: `status` (`completed` or `failed`), terminal timestamp,
   `outcomeClass` (`ready` / `not-ready` / `error`), a short `summary`
   (counts, not the full diagnostics payload), and, for a `failed`
   terminal write, the persisted `error` string (section 5). Written
   exactly once, by the SAME process that wrote the `start` record for
   this `attemptId`, when that attempt's own `evaluateSolution` invocation
   resolves; before appending, that process re-reads the log for its own
   attemptId and skips the append if a `reconciled-unknown` record for it
   is already present (see kind 3; this is what keeps a late-arriving
   terminal write from ever overriding an already-reconciled `unknown`,
   section 9's corrected residual explains when this can actually occur).
3. `reconciled-unknown`: written for an `attemptId` whose last record is
   still `start` (`running`) and whose recorded holder PID is confirmed
   dead, by either `reconcileOrphanedAttempts()` at startup or the
   read-path liveness check described below; exactly one
   `reconciled-unknown` record may ever exist for a given `attemptId`,
   guarded the same way (re-read immediately before append, skip if one is
   already present, so two liveness checks racing each other cannot both
   append it). Once written, that attemptId's outcome is `unknown` forever
   (its own attempt log entry list will never again change kind).
4. `tombstone`: written only during compaction (below), replacing an
   entire attempt's records (`start` plus `terminal`, or `start` plus
   `reconciled-unknown`) with one small record (`attemptId`, `id`,
   terminal-outcome class, prune timestamp) once the retention window has
   elapsed.

No writer other than an attempt's own process may ever append a `start` or
a `terminal` record for that attempt. The two narrow exceptions, named
explicitly because they are the only records one attempt's process
appends on another attempt's behalf: reconciliation (startup pass or
read-path check) may append ONLY a `reconciled-unknown` record, and only
for an attempt whose holder is confirmed dead; compaction may append ONLY
a `tombstone` record, and only while holding that id's on-disk lock
(section 7), so it cannot race a concurrently-appending attempt for the
same id. Compaction rewrites the whole per-id file via a temp file plus an
atomic rename (`fs.rename`, same directory, same filesystem), never an
in-place truncate-and-rewrite: everything not yet past its retention
window is carried over unchanged, and each triplet past its window is
replaced by its `tombstone`.

Reword the prior round's own vocabulary: this design guarantees "at most
one live outcome per attempt, reached through a bounded set of
transitions" (`start` -> `terminal` XOR `start` -> `reconciled-unknown`,
then either -> `tombstone`), not "exactly two writes per attempt, never
more" (the prior round's phrasing, already contradicted by the third and
fourth record kinds that same round's own text went on to describe).
"Append-only" means no attempt's row is ever REWRITTEN or REMOVED by a
DIFFERENT attempt's write; it does not mean literally two bytes on disk
ever, since reconciliation and compaction both append additional,
narrowly-scoped records under the rules above.

### Reconciliation and read-path liveness (closes review round 2 finding M1)

Reconciliation: a `reconcileOrphanedAttempts()` pass (suggested name, in
`solution-attempt-log.ts`) runs once at `grounding-mcp` process startup,
before the transport connects (`server.ts`, `main()`), and scans every
per-id log file for an `attemptId` whose last record is `start`
(`running`). For each, it checks whether the recorded holder PID is
alive; if the PID is dead, it appends a `reconciled-unknown` record,
exactly once, per the guard in kind 3 above. It additionally sweeps for an
on-disk LOCK file (section 7) whose `attemptId` has no corresponding log
row at all (a crash between lock-acquisition and the `start` record's
append) and treats that lock exactly as a stale lock once its age exceeds
the stale-lock window, through the same atomic-takeover procedure section
7 defines, never a separate code path.

Startup-only reconciliation cannot stop a `running` row whose holder died
AFTER the last startup; nothing would re-check it until the next restart,
which may be arbitrarily far off. `solution_evaluate_status`,
`solution_evaluate_result`, and `solution_evaluate`'s own join path
therefore each run the IDENTICAL liveness check (holder PID alive on this
host, and the lock's age against the stale-lock window, section 7) as
part of every lookup or join attempt against a `running` row, not only
once at process startup; every `solution_evaluate` lock-acquire attempt
that finds an existing lock runs the same sweep too (lock present with no
matching log row, or a log row `running` with a dead holder), so the
atomic takeover in section 7 can fire promptly rather than waiting for the
next process restart. When any of these checks finds the holder dead, it
appends the SAME one-time `reconciled-unknown` record reconciliation would
have appended, guarded identically.

This narrows, rather than removes, the invariant from the prior round:
"never inferred at read time" forbids only inferring `unknown` from "we
have no opinion" (a lookup that finds no in-memory record must NOT
conclude `unknown` on that basis alone; section 5's "Restart" bullet). It
does not forbid the read path from RUNNING the same liveness check and
APPENDING the same kind of record reconciliation would; a `reconciled-
unknown` record is always evidence-backed (a confirmed-dead holder PID),
regardless of which pass wrote it. Section 5's "Restart" bullet is worded
to match: a lookup resolves to `unknown` only once some liveness check,
whichever process or pass ran it, has confirmed the holder dead and
appended the record, never merely because an in-memory registry happens to
be cold.

This satisfies the tracker's requirement directly:

- Retry never overwrites a prior attempt/result: each attempt owns exactly
  one `start` record and, once it reaches an outcome, exactly one
  `terminal` OR `reconciled-unknown` record, appended only by its own
  process (or, for `reconciled-unknown` only, by a reconciliation pass);
  no attempt's outcome record is ever touched by a different attempt.
- Retry never upgrades `unknown` to success: a `reconciled-unknown`
  record, once written, is never followed by a `terminal` record for the
  same `attemptId` (the write-order guard in kind 2 above); a later,
  independent attempt for the same `id` gets its own new `attemptId` and
  its own new records.
- Retry never silently launches a duplicate process: guaranteed
  structurally by the join-in-flight rule (section 7), which makes a
  genuinely new attempt possible only once the on-disk lock for that `id`
  is confirmed free, not merely once a prior attempt's log row reads
  terminal.

## 7. Concurrency: join-in-flight, not duplicate

### Same-process concurrency (in-memory, unchanged in substance)

Two `solution_evaluate({ id })` calls that arrive in the SAME
`grounding-mcp` process while no attempt for `sanitizeVerdictId(id)` is
running race to become "the" new attempt. Node's single-threaded event
loop makes an atomic, synchronous check-and-set on an id-keyed in-memory
lock straightforward to implement correctly (check the lock, and if free,
set it, before the first `await` in the handler): exactly one call wins
and starts the `preflight` process; the other joins the winner's attempt
and returns the same `attemptId`, never starting a second process. This
guarantee holds ONLY within one process's event loop; it is not, by
itself, a cross-process guarantee (see below).

### Cross-process concurrency (on-disk lock, new in this revision)

grounding-mcp uses `StdioServerTransport` (`server.ts`, imported at the
top of the file and instantiated in `main()`): every client registered
against it (Claude Code, Codex, and, if wired, opencode) spawns its OWN,
separate `grounding-mcp` OS process. Those processes share no memory, so
an id-keyed in-memory lock in one process cannot see or coordinate with
another process's in-memory lock for the same `id`. The prior round of
this document claimed the in-memory lock alone made two preflight
processes for one id structurally impossible; that claim was unsound
across processes and is corrected here.

The fix is an on-disk advisory lock file, one per sanitized id, alongside
the verdict marker: suggested path
`path.join(verdictDir(), \`${sanitizeVerdictId(id)}.lock\`)`
(`packages/grounding-mcp/src/solution-verdict.ts`, `verdictDir`,
`sanitizeVerdictId`). Its contents: the holder's OS process id (the
`grounding-mcp` process that accepted the call, not the `preflight` child;
see below for why), a start timestamp, the `attemptId`, and a host
identifier (see "Single-host assumption" below).

- Acquisition: before spawning the `preflight` child process, the handling
  process attempts to CREATE the lock file with an exclusive,
  create-if-absent open (the platform's O_EXCL-equivalent), so that when
  two processes race to create it near-simultaneously exactly one create
  succeeds; the loser falls back to the join path below without ever
  spawning a child.
- Release: deleted by the same process when its own attempt reaches a
  terminal state (`completed` or `failed`); never deleted by a different
  process, and never "released" merely because a status query observed
  `unknown` or `expired`, since those are read-only reporting outcomes,
  not attempt-terminal write events. Release happens LAST, after the
  marker write and the attempt log's own terminal write, in the fixed
  order "Write order and crash windows" below specifies; it is never the
  first of the three terminal-path writes.
- Liveness check: a process that finds an existing lock checks whether the
  recorded holder PID is alive. A live PID means a genuinely running
  attempt; that process JOINS by treating the lock's `attemptId` as its
  own running handle (recording it in its own in-memory registry so its
  own `solution_evaluate_status`/`_result` calls can resolve it), and
  either polls the lock/log file at an interval within its own internal
  wait bound (mirroring the same-process join's synchronous wait, just
  over disk reads instead of an in-memory promise) or, if its own bound
  elapses first, returns `{status:"running", attemptId, id, pollAfterMs}`
  exactly as the winning process's own callers would.
- Stale-lock timeout and atomic takeover (closes review round 2 finding H1): a
  PID-liveness check alone is not fully reliable (an OS can reuse a PID
  after the original process exits, and a crash can leave a lock behind
  with no process left to release it). A lock older than a configurable
  stale-lock window, independent of and comfortably longer than any real
  `preflight` run is expected to take, is treated as stale regardless of
  what the PID-liveness check reports. Reclaiming a stale lock is itself a
  check-then-act sequence (read the lock, decide it is stale, remove it,
  create a new one), and two processes can both perform that sequence
  against the SAME stale lock at nearly the same time; without a further
  guard, both would observe it as stale and both would go on to spawn a
  `preflight` process, exactly the double-preflight failure this closes.
  This is closed by a second, narrower exclusive-create step, not by
  checking staleness more carefully:
  1. The reclaiming process first creates a takeover marker,
     `path.join(verdictDir(), \`${sanitizeVerdictId(id)}.lock.takeover\`)`,
     via the same exclusive, create-if-absent open used for the lock
     itself. Exactly one of any number of racing reclaimers succeeds;
     every other reclaimer's create fails, and that process falls back to
     the join path, since it no longer believes the lock is free.
  2. The process whose takeover marker was created re-reads the stale
     lock file's bytes and verifies they are byte-identical to the ones it
     originally observed as stale. A change here means a different
     process already completed a takeover (or the original holder is
     somehow still live and rewrote its own lock) in the interim; this
     reclaimer deletes its own takeover marker and re-joins as if the lock
     had been live all along, never proceeding to the next step.
  3. Only if the re-read matches does the reclaimer unlink the stale lock
     and create the new lock, again via exclusive create, with its own
     PID, start time, and new `attemptId`, then delete its takeover
     marker.
  4. Before spawning the `preflight` child, the reclaimer re-reads the
     lock file it just created and verifies the bytes are its own (its
     own PID and `attemptId`). Only on that confirmation does it spawn the
     child; a mismatch means another process won a race in some other
     window and this process instead joins that lock's `attemptId`.
  5. A takeover marker is itself subject to the same stale-lock window: a
     `.takeover` file older than the window (its own creator having died
     or hung between steps 1 and 3) is reclaimable by a later process
     through the identical exclusive-create procedure above, so a crash
     mid-takeover cannot permanently wedge the id.
  This makes "two processes both observe the same lock as stale" resolve
  to exactly one process spawning a `preflight` process, never two (see
  the acceptance-matrix row in section 10 and brief 01's added test).
- Named failure modes: (a) the lock file exists but is malformed or
  unparseable: treated as stale, reclaimed, and a diagnostic is logged;
  (b) the recorded PID is alive but belongs to an unrelated process due to
  PID reuse: indistinguishable from a live legitimate holder by the
  liveness check alone, bounded only by the stale-lock timeout, which is
  exactly why that timeout exists independent of PID liveness; (c) the
  holding `grounding-mcp` process dies after acquiring the lock but before
  its `preflight` child exits: the lock's PID (the parent) is now dead.
  Per the parent-only invocation shape already established in section 1
  (`evaluateSolution` itself calls `writeVerdict` synchronously after its
  own `execFileAsync` call resolves, inside the SAME process that spawned
  the child), NO process is ever left alive that could call `writeVerdict`
  for this child's output once its parent is gone; there is no "eventual
  write" for a later attempt's own write to race against, because nothing
  will ever attempt that write on the dead parent's behalf. The actual
  residual is simpler and total, not a race (corrected from a prior
  round's claim; see section 9, blocker 2, for the full correction): the
  orphaned child's output, whether it keeps running per section 5's
  recommendation not to kill it, or dies when its stdout pipe breaks on
  the parent's exit (platform-dependent, unverified here), is
  unrecoverable either way; the run itself is wasted, consuming CPU/IO
  until it exits, with nothing ever persisting its outcome. This is
  bounded, not eliminated, by the stale-lock timeout: the lock is
  dead-but-not-yet-stale for up to that window, after which a new,
  independent attempt is licensed through the atomic-takeover procedure
  above, entirely unaffected by whatever the orphan is still doing, since
  the orphan was never going to write anything regardless; (d) two
  acquisition attempts race at the OS-call level, whether acquiring a free
  lock or reclaiming a stale one: resolved by the exclusive-create
  primitive above (the lock file itself for a free-lock race, the
  `.lock.takeover` marker for a stale-lock race), not by any
  application-level check-then-set.
- The holder PID recorded is the `grounding-mcp` process's own PID, not
  the `preflight` child's PID: the liveness check's purpose is "is any
  process still alive that is responsible for eventually finishing this
  attempt and writing its result," which is the parent, not the child;
  tracking the child's PID would make the lock read as live for as long
  as an orphaned child survives even though nothing will ever act on its
  output, which is a worse signal for callers deciding whether to wait.
- Single-host assumption (closes review round 2 finding L2): this lock design is valid
  only when every `grounding-mcp` process sharing a given `verdictDir()`
  (section 1, `verdictDir`) runs on the SAME host, and that host's
  filesystem provides an atomic, create-if-absent (O_EXCL-equivalent)
  primitive for local files. This document makes no claim about a
  `verdictDir()` shared across hosts (for example a network filesystem
  whose create-if-absent semantics are not atomic, or are not even
  well-defined, under concurrent writers from different hosts); that
  configuration is out of scope. To make a cross-host mismatch detectable
  rather than silently assumed away, the lock's own contents (alongside
  PID, start time, `attemptId`) also record a host identifier (for
  example `os.hostname()`); a lock whose recorded host identifier does
  not match the CURRENT host is treated as stale regardless of its age or
  its PID's apparent liveness (a PID number is meaningless across hosts),
  and is reclaimed through the identical atomic-takeover procedure above,
  never a separate code path.

### Write order and crash windows (closes review round 2 finding M2)

When an attempt reaches a terminal state, the three writes involved happen
in this fixed order, never interleaved or reordered:

1. `writeVerdict` (existing code, `solution-verdict.ts`, unchanged by this
   design) persists the signed marker at `verdictPath(id)`, exactly as it
   does today.
2. The attempt log's `terminal` record (section 6) is appended for this
   `attemptId`.
3. The on-disk lock file for this `id` is deleted (released).

A crash between any two of these steps is a real, disclosed residual, not
a silently-ignored one:

- Crash between (1) and (2): the marker is written and correct, but the
  attempt log still shows `running`. The stale-lock window plus
  reconciliation/read-path liveness (section 6) eventually resolves this
  attempt's row to `unknown`, even though its marker was in fact written
  successfully; a caller relying on `solution_evaluate_result` for this
  specific `attemptId` sees `unknown` despite a real, valid marker on
  disk. `solution_gate` itself is unaffected (it reads the marker
  directly, not the attempt log); this attempt's own status lookup alone
  undercounts its own success. Not fully closed by this design; recorded
  here rather than silently assumed away.
- Crash between (2) and (3): the attempt log correctly shows the terminal
  outcome, but the lock file is left behind. The next process that finds
  it sees a dead holder PID against an already-terminal log row (not
  `running`), which the read-path liveness check or the next lock-acquire
  attempt's sweep (section 6, "Reconciliation") reclaims immediately,
  without waiting for the stale-lock window; there is no "maybe still
  running" ambiguity left to protect against once the log row itself
  already reads terminal.

Lookup for an id whose on-disk LOCK exists but whose attempt log has no
row at all for that lock's `attemptId` (a crash between lock-acquisition
and the log's own `start` record, or a lock for an id whose log file was
never created): resolves to a distinct outcome, `running-unconfirmed`, not
`running` and not `unknown`. A `running-unconfirmed` attempt is
reclaimable exactly like a stale lock once the stale-lock window elapses,
through the same atomic-takeover procedure, since there is no log row to
consult for a liveness-independent terminal outcome; before that window
elapses, a lookup by `id` still reports it (there is a live-looking lock,
after all) but a lookup by that specific `attemptId` has nothing to join,
since no in-memory registry entry exists either.
`reconcileOrphanedAttempts()` sweeps for exactly this shape (lock present,
no matching log row) at startup, per section 6, "Reconciliation".

`forceNewAttempt: true` is refused (returns an error, starts nothing)
while the on-disk lock for that `id` is held by a live (non-stale) holder.
This is deliberate: honoring a forced new attempt against a still-running
one would reintroduce exactly the race PR #211 documents as an accepted,
NOT-closed residual: "Remove the prior marker for an evaluation id. A
missing marker is already invalid. Other I/O errors are surfaced to the
caller because an old marker may still remain usable. This is a
sequential guarantee for writable marker storage; it does not serialize
concurrent writers or repair id collisions." (full comment,
`packages/grounding-mcp/src/solution-verdict.ts`, function
`invalidateVerdict`, master `eefd18fe`). The on-disk
lock in this section closes the "does not serialize concurrent
writers" half of that disclosure for THIS design's own preflight-spawn
race specifically: under this contract, a genuinely independent new
attempt for the same `id` is only ever created after the on-disk lock for
that `id` is confirmed free (live-holder check plus stale-lock timeout),
so two `preflight` processes racing to invalidate and write the same
marker for the same `id` cannot happen through this contract's own entry
points. The "repair id collisions" half of that same disclosure remains
explicitly out of scope (section 5, "Identifiers", "Keying"); this design
neither introduces nor repairs it. A "cancel the in-flight attempt, then
retry immediately" capability (killing the child process on request) is a
separate capability this document does not design; it is listed as a
dependency in the producer brief (section 10) for whoever wants true
force-retry-while-running later.

## 8. Trust boundary

- Retrieved attempt status or a terminal `EvaluateResult` obtained via
  `solution_evaluate_status`/`_result` grants no ready authority by itself.
  The only path to "done" remains the same as today: a `ready` signed
  marker at the current HEAD, checked by `solution_gate` (or the harness's
  own `readVerdict`). This design adds no new way to satisfy the gate.
- Result-retrieval authority for a SUPERSEDED attempt: a naive
  `solution_evaluate_result` could otherwise hand back a cached, apparently
  `ready` verdict together with a `markerPath` that PR #211's
  `invalidateVerdict` has already removed from disk, because a newer
  attempt for the same `id` invalidated and replaced it. This is closed by
  the `isLatestForId`/`markerPresent` fields described in section 5's
  "Tools" subsection: `solution_evaluate_result` re-checks, at read time,
  whether the attempt being retrieved is still the latest recorded attempt
  for its sanitized id, and whether a marker file is actually still present
  on disk right now, not merely at the moment the attempt itself finished.
  For any attempt that is not the latest for its id, the response carries
  only `status`, `outcomeClass`, and `summary`; it never returns a
  `verdict` object or a `markerPath` that could point at a file that no
  longer exists or that has been superseded.
- An `attemptId` is an opaque, server-generated token, never a command,
  path, or artifact; a caller cannot use it to invoke anything beyond the
  two read-only lookup tools above. Its own exposure is unchanged from
  today's `solution_evaluate`: `EvaluateResult` already returns `markerPath`
  and `diagnostics` today (`packages/grounding-mcp/src/solution-verdict.ts`,
  `EvaluateResult`), so this document does not claim "no filesystem
  location is exposed" through it, a claim the prior round of this
  document made and which was already false for today's behavior.
  `solution_evaluate_status`/`_result` inherit exactly that same exposure,
  unchanged and un-widened, narrowed only by the `isLatestForId` gating
  immediately above for a superseded attempt. No environment variable or
  signing key path is exposed through any of these tools, today or under
  this design.
- Joining an in-flight attempt is explicitly NOT the "cache reuse" the
  playbook document (`verification-handoff-first-slice.md`) and the OKF
  contract doc warn against. It dedupes only an already-physically-running
  process; it never serves a previous, already-terminal result in place of
  running a fresh one for a genuinely new retry, and it never lets a
  caller skip invoking `preflight` altogether. Provenance-/snapshot-bound
  reuse of a COMPLETED result across separate invocations is explicitly
  out of scope here and stays with tracker tasks `dd7f8b18` / `65f86c2a`;
  this document records only that those tasks will need the `attemptId`
  and attempt-log interfaces described above as inputs, without designing
  their evidence schema.
- Existing signed-verdict creation and PR #211's error hardening are
  respected, not replaced: PR #211 has merged (master `eefd18fe`,
  2026-09-05 18:40Z), so every terminal `failed` attempt under this design
  goes through the same `invalidateExisting`/`preflightOutcomeError` path
  it added; the new attempt log is purely additive bookkeeping alongside
  that invalidation, never a substitute for it.

## 9. Blockers (not implementation-ready without resolution)

These are named as open blockers, not settled decisions, per the tracker's
requirement that unresolved client/provider constraints be marked as
blockers rather than papered over:

1. Claude Code's own reset-on-progress and tasks-protocol behavior are no
   longer unverified: measured negative for progress-reset-extends-deadline
   under today's config, and measured positive for implementing
   `tasks/get`/`tasks/result`/`tasks/list`/`tasks/cancel` (section 2). What
   remains unverified is Codex's and opencode's equivalent behavior; the
   Codex binary yields no matching strings, which is inconclusive rather
   than negative for a stripped Rust binary, and opencode is not registered
   for this tool at all. Nothing in the chosen contract (section 4-C)
   depends on any of this, but the complementary progress layer (section 3)
   does for the clients where it remains unconfirmed, and its value should
   not be overstated in the producer brief for Codex/opencode, nor
   overstated as helpful for Claude Code, where it is now confirmed not to
   extend the deadline.
2. Whether an orphaned `preflight` child process is reliably killed or
   reliably survives its parent `grounding-mcp` process exiting (crash or
   deliberate restart) was not verified against this platform's actual
   process-group behavior. This risk is now bounded, not eliminated, by
   section 7's on-disk lock: if the parent dies while its child preflight
   survives orphaned, the lock is dead-but-not-yet-stale for at most the
   stale-lock timeout, after which a new attempt is licensed through the
   atomic-takeover procedure (section 7). CORRECTED from a prior round's
   claim (finding M3, review round 2): since `evaluateSolution` calls
   `writeVerdict` only inside the SAME process that spawned the child
   (section 1; section 7, failure mode (c)), an orphaned child never
   itself produces a competing marker write for a later attempt's write to
   race against; nothing is ever left alive to make that write on the dead
   parent's behalf. The actual, disclosed residual is total loss, not a
   race: the orphan's run is wasted (its output is unrecoverable once its
   parent is gone) and it consumes CPU/IO until it exits, or until its
   broken stdout pipe kills it first (platform-dependent, still unverified
   here). PR #211's own disclosed "does not serialize concurrent writers"
   residual (quoted in section 7) concerns a DIFFERENT scenario, two LIVE
   processes both calling `invalidateVerdict`/`writeVerdict` for the same
   id at nearly the same time, which this design's on-disk lock closes for
   its own entry points (section 7); it is not the same risk as an
   orphaned child, and this document no longer conflates the two. This
   affects both the "restart" and the "two client sessions, same id" rows
   of the acceptance matrix and the recommendation in section 5 not to
   kill child processes on disconnect; if orphaned processes turn out to
   accumulate unbounded even under the stale-lock bound, that
   recommendation needs revisiting together with the retention policy in
   section 5.
3. Whether a real MCP stdio session between grounding-mcp and Claude Code
   or Codex ever actually delivers a transport-level disconnect or
   `notifications/cancelled` mid-call (as opposed to the process pair
   simply persisting for the whole session) is unverified; no live
   long-running job was run to observe this. Regardless of disconnect
   behavior, another process reading the on-disk lock and attempt log
   (section 6, section 7) sees an accurate running/terminal state; this
   blocker concerns only whether the ORIGINAL caller's own transport
   delivers a cancellation signal, not whether the attempt's state is
   observable.
4. The exact bound used inside `solution_evaluate` before it falls back to
   returning a handle (configurable, with a documented default; section 5
   fixes only the invariant that it must not assume the SDK's 60 s
   constant, not a number), the stale-lock timeout (section 7), and the
   retention/rotation numbers for the in-memory registry and the on-disk
   attempt log (fixed only by the invariant in section 5 that retention
   exceeds `pollAfterMs`) are implementation-brief decisions, deliberately
   left open here.

## 10. Acceptance matrix and implementation split

| Scenario | Expected behavior under this contract | Where it is verified |
| --- | --- | --- |
| Run exceeds 30 s, caller stays connected, no progress opt-in | `solution_evaluate` blocks past the internal bound, returns `{status:"running", attemptId}`; caller polls `solution_evaluate_result` | Producer brief unit test with a stubbed slow `preflight`; see brief 01 |
| Run exceeds 30 s, caller opts into progress and its client resets the timeout | `solution_evaluate` blocks the whole duration, sends progress pings, returns the terminal result inline | Producer brief unit test using a fake `progressToken`/notification sink; see brief 01 |
| Caller times out (no progress), result completes afterward | `preflight` keeps running; a later `solution_evaluate_status`/`_result` (with or without a known `attemptId`) observes the terminal state; the signed marker is written exactly as it would be today | Producer brief integration test; see brief 01 |
| Transport disconnect / cancellation mid-run | Child process is not killed (section 5, flagged blocker); attempt remains queryable once terminal | Producer brief test plus blocker 3, section 9 |
| Process failure (crash, signal, unexpected exit) | Attempt terminal state `failed`; existing `preflightOutcomeError`/marker-invalidation behavior unchanged; new log entry `failed` | Existing `tests/solution-verdict.test.ts` cases (for example "keeps a signal termination visible in diagnostics...") plus new attempt-log assertions; see brief 01 |
| Malformed preflight output | Attempt terminal state `failed`, unchanged parser/diagnostics behavior (`parsePreflightJson`, `inspectPreflightPayload`) | Existing `tests/solution-verdict.test.ts` cases plus new attempt-log assertions; see brief 01 |
| Server restart mid-attempt | Old `attemptId` resolves to `unknown` ONLY once startup reconciliation OR a read-path liveness check confirms the holder PID is dead (section 6); a later independent attempt for the same `id` is licensed only once the on-disk lock is confirmed free (blocker 2, section 9, for the orphan-process question), never merely because the reported status reads `unknown` | Producer brief test simulating registry loss plus reconciliation; see brief 01 |
| Holder dies AFTER another process already reconciled a different, earlier attempt for the same id (holder death not caught by the last startup) | A read-path liveness check on the CURRENT lookup (not only the startup pass) catches the dead holder and appends `reconciled-unknown` for THIS attempt, exactly once, independent of when the last restart happened | Producer brief test simulating a second holder death observed only via a live lookup, not startup; see brief 01 |
| Two processes both observe the same stale lock at nearly the same time | Exactly one process completes the takeover (`.lock.takeover` exclusive create) and spawns a `preflight` process; the other re-reads, finds it lost the takeover race, and joins the winner's `attemptId` | Producer brief stale-lock double-takeover test; see brief 01 |
| Lock present, no corresponding attempt-log row (crash between lock-acquire and the log's own `start` record) | Lookup resolves to `running-unconfirmed`, never `running` forever and never `unknown`; reclaimable exactly like a stale lock once the stale-lock window elapses, via the same atomic-takeover procedure | Producer brief lock-without-log-row test; see brief 01 |
| `solution_evaluate_result` answered by a process that does not own the attempt in its in-memory registry (cross-process or post-restart), for a completed and for a failed attempt | Response uses the documented reduced shape (`outcomeClass`, `summary`, persisted `error` string for a failure; `verdict`/`markerPath` only when `isLatestForId` and `markerPresent` both hold), never the full same-process `EvaluateResult` shape | Producer brief cross-process payload-shape test (completed and failed); see brief 01 |
| Concurrent starts for the same id, SAME process | Exactly one `preflight` process; the second caller joins and receives the same `attemptId` | Producer brief unit test asserting a single child-process invocation across two concurrent calls; see brief 01 |
| Two client sessions, same id (cross-process) | Exactly one `preflight` process across BOTH processes; the second process's `grounding-mcp` finds the on-disk lock live, joins by returning the lock's `attemptId`, and never spawns its own child | Producer brief test with two real `grounding-mcp` processes, or one process plus a pre-written lock file simulating the other holder; see brief 01 |
| Retry after a caller's own timeout | If the on-disk lock for that id is still live, the retry joins it (no duplicate, same `attemptId`); if the lock is free (prior attempt terminal, or stale-lock timeout elapsed), the retry is a genuinely new attempt with its own log entry | Producer brief test covering both sub-cases; see brief 01 |
| Cleanup | Terminal attempts age out of the in-memory registry and are compacted in the on-disk log after their retention window, which exceeds the advertised `pollAfterMs` by a stated margin (section 5) | Producer brief test with an injectable clock; see brief 01 |
| Retention prunes a formerly-terminal attempt | Lookup resolves to `expired`, never `unknown`; does not license a new attempt bypass (lock-liveness still governs) | Producer brief pruned-before-poll test; see brief 01 |
| `solution_evaluate_result` for a superseded attempt | Response carries `isLatestForId: false` and omits `verdict`/`markerPath`; only status, outcome class, and summary are returned | Producer brief test asserting result-retrieval authority for a non-latest attempt; see brief 01 |

Two narrow, independently reviewable implementation briefs follow this
document. Their real labels, after this round's changes:

1. `01-producer-attempt-lifecycle.md`: the attempt registry, the
   cross-process lock, join-in-flight logic, `attemptId` generation, the
   append-only attempt log, and the two new tools' server-side logic in
   `solution-verdict.ts` / `server.ts`. Status: **implementation-ready**.
   The brief's own label was already "implementation-ready" before the
   first review round, but that assessment predated review round 1
   catching its own finding H1 (the in-memory lock's cross-process
   unsoundness; distinct from review round 2's finding H1, the stale-lock
   takeover race, closed in section 7 above); it was correct in its own
   terms only because it had not yet been checked against the fact that
   grounding-mcp runs one process per client. That design gap is now
   closed by section 7's on-disk lock, so the label is re-confirmed here,
   not merely carried forward. The one remaining open item is the orphan
   child-process kill-vs-survive question (blocker 2, section 9), which
   this brief ships against with a documented default (do not kill) and a
   bounded residual (the stale-lock timeout); that item was already
   flagged, unresolved, before this round and stays unresolved, but bounded
   rather than open-ended, after it. This is an explicit call, not an
   oversight: the lock design itself is accepted here; only the
   platform-behavior question around orphaned children remains open, and
   it does not block starting implementation.
2. `02-client-polling-integration.md`: the harness policy-pack prompt text
   and README updates that teach a solving agent when to poll versus retry,
   plus the standard-progress ergonomics layer from section 3 (the sibling
   task `8c9a99fc`'s scope, sequenced after brief 01 lands). Status:
   **split**, unchanged in kind from the prior round: section A
   (documentation) is implementation-ready; section B (progress pings) is
   safe to implement but its VALUE claim stays qualified per client (now
   confirmed unhelpful for Claude Code specifically, still unconfirmed for
   Codex/opencode; see the brief's own updated cross-reference to section
   2). Neither brief was marked `blocked-on-<x>` in review round 1's own
   revision of this text, despite an earlier draft's summary claiming so;
   that was the correction made in the prior round, scoped to that prior
   revision only. Brief 02's OWN header, as of this round, DOES carry an
   explicit `blocked-on-client-capability-verification` label, but only
   for section B's VALUE claim, not its safety, and not for section A,
   which stays implementation-ready; brief 02's own header text is
   authoritative over this summary paragraph should the two ever again
   appear to diverge.

Both live in this task's run directory
(`.ai/runs/2026-09-05-open-pool-batch37/t006-briefs/`), outside this repo,
as instructed by the task assignment; they are not committed here.

## 11. For the reviewer

Every factual claim about existing code in this document cites a
repo-relative path and a function or heading name (never a bare line
number) so it can be checked directly: `packages/grounding-mcp/src/server.ts`
(`solution_evaluate` registration, `jsonResponse`, `StdioServerTransport`,
`main`), `packages/grounding-mcp/src/solution-verdict.ts`
(`evaluateSolution`, `writeVerdict`, `invalidateVerdict` (merged, master
`eefd18fe`), `evaluateGate`, `verdictDir`,
`sanitizeVerdictId`, `verdictPath`, `EvaluateResult`),
`harness/src/policy-packs/builtin/solution-acceptance-runtime.ts`
(`readVerdict`), and the installed `@modelcontextprotocol/sdk@1.30.0`
`.d.ts` files cited in `t006-client-capabilities.md`. Claims about local
client configuration cite the exact config file and key path, kept in
`t006-client-capabilities.md` rather than this document (section 2). The
Claude Code capability claims in section 2 are measured, not assumed: the
method is a `strings`-based scan of the installed Claude Code binary,
recorded in full (binary path, exact matched strings, method caveats) in
`t006-client-capabilities.md`; this document cites only the method and the
resulting facts, not the host-specific binary path. Where a claim could
not be settled from locally available material, it is written as "unknown
(not verifiable locally)", with a stated reason it is inconclusive rather
than negative where that distinction matters (for example, Codex's
stripped Rust binary yielding no string match), rather than asserted
either way.
