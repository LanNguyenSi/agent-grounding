# solution_evaluate call lifecycle: timeout, retrieval, and retry

Document date: 2026-09-05. Status: design, no code changed by this document.

Revision: Revised after architectural review round 1 (cross-process lock,
measured client capabilities, restart and retention semantics,
result-retrieval authority).

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
boundary: broader parser/error-hardening (follow-up 3, in flight as PR #211,
branch `fix/8e29ad58-verdict-hardening`) and provenance-/snapshot-bound
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
`t006-client-capabilities.md` (run evidence) for the exact SDK file
citations.

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

The sibling task (agent-grounding tracker id `8c9a99fc`, not yet started as
of this document; no branch or PR exists for it, checked via
`git log --all` and `gh pr list`) proposes adding standard MCP progress
notifications during `solution_evaluate`, mirroring the pattern already
shipped in `agent-preflight/src/mcp.ts` (`withProgressPings`,
`DEFAULT_PROGRESS_INTERVAL_MS = 10_000`): if the caller supplied
`_meta.progressToken`, ping it periodically while the child process runs.

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
   the registration shape and wiring a `RequestTaskStore`
   (`dist/esm/shared/protocol.d.ts`, around line 119) and a task
   message queue for the tool handler to use. This is real, non-trivial
   work, but it is cheaper than this document previously stated: the SDK
   ships ready-made implementations of both roles,
   `InMemoryTaskStore` and `InMemoryTaskMessageQueue`
   (`dist/esm/experimental/tasks/stores/in-memory.d.ts`), so a v1 adoption
   would not need to build persistence from scratch, only wire the
   registration migration around an existing in-memory store. The
   objection here is the migration itself, not a from-scratch
   persistence build.
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
  once PR #211 lands, the stricter outcome-validation failures) maps
  directly onto this state; no new failure modes are introduced by this
  document.
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
- `solution_evaluate_result({ id, attemptId? })` (new): returns the
  terminal `EvaluateResult` once the attempt is `completed` or `failed`; if
  the attempt is still `running`, returns `{ status: "running", attemptId
  }` rather than blocking (unlike `solution_evaluate`'s own bounded wait).
  Same `attemptId`-omitted fallback to "latest attempt for id" as
  `solution_evaluate_status`. Every response also carries `isLatestForId`
  (is this the latest recorded attempt for its sanitized id, re-checked
  against the attempt log at read time) and `markerPresent` (does a marker
  file actually still exist at `markerPath`, re-checked with a fresh
  filesystem read at response time, not cached from when the attempt
  finished). When `isLatestForId` is false, meaning the marker this attempt
  wrote has since been invalidated and replaced by a newer attempt for the
  same `id` (`invalidateVerdict`, section 7), the response omits (or
  nulls) the
  `verdict` object and `markerPath` entirely and returns only `status`, the
  terminal outcome class, and `diagnostics`' summary fields; it never hands
  back a `verdict`/`markerPath` pair that could point at a file
  `invalidateVerdict` has already removed. See section 8.

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
  entry itself is `running` with a dead holder PID (reconciled at startup,
  section 6), never merely because this process's own in-memory cache is
  cold. A restart must never silently report `running` forever, and must
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

A new, separate append-only attempt log records one entry per attempt
(`attemptId`, `id`, `head`, `startedAt`, holder PID, current `status`,
terminal timestamp once terminal, and a short outcome summary; it does not
need to duplicate the full diagnostics payload). This log is DISTINCT from
the single, signed, overwritten verdict marker (`verdictPath(id)`,
unchanged by this design): the marker is gate authority for exactly one
`id` at exactly one HEAD; the log is an audit/history trail across every
attempt ever made for that `id`, mirroring the "diagnostics are advisory,
never gate authority" separation already established for the diagnostics
field (`docs/okf/solution-acceptance-verdict-contract.md`, "Advisory
preflight diagnostics"). Because this log is the cross-process source of
truth for what happened to an `id` (section 7's lock only tells a caller
that an attempt is currently live, not what any past attempt did), it must
itself live on disk, shared the way `verdictDir()` already is.

Its entry lifecycle has exactly two writes per attempt, never more:

1. START: written the moment an attempt's lock is acquired (section 7),
   before the `preflight` child process is spawned. Status `running`,
   carrying the holder PID and start time. This is the fix for the prior
   round's gap: without a START write, an `unknown`/never-observed-running
   invariant had no writer at all; the attempt log went straight from
   nothing to a terminal entry, so a lookup mid-run before that terminal
   write existed had nothing to read. The component responsible is the
   same module that owns the lock, `solution-attempt-log.ts` (suggested
   name, brief 01), invoked synchronously in the same call that acquires
   the lock.
2. TERMINAL UPDATE: the same entry (same `attemptId`, found by key, never
   a second row) is updated exactly once, to `completed` or `failed`, when
   that attempt's own `evaluateSolution` invocation resolves. This is the
   attempt's own single, controlled, one-time transition of its own row;
   it is not "mutating a log entry" in the sense the append-only guarantee
   below forbids, because no OTHER attempt ever touches a row it did not
   create.

Reconciliation: a `reconcileOrphanedAttempts()` pass (suggested name, in
`solution-attempt-log.ts`) runs once at `grounding-mcp` process startup,
before the transport connects (`server.ts`, `main()`), and scans the
on-disk log for entries still `running`. For each, it checks whether the
recorded holder PID is alive; if the PID is dead, it writes the THIRD kind
of update this log ever makes, to `unknown`, exactly once, and only for a
`running` entry whose holder is confirmed dead. This is what actually
assigns `unknown`; it is never inferred at read time from "we have no
opinion."

This satisfies the tracker's requirement directly:

- Retry never overwrites a prior attempt/result: each attempt gets
  exactly one row, created at start and updated to its own terminal status
  once; no attempt's row is ever touched by a different attempt.
- Retry never upgrades `unknown` to success: an `unknown` entry, once
  written by reconciliation, is never revised again; a later, independent
  attempt for the same `id` gets its own new row.
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
see below for why), a start timestamp, and the `attemptId`.

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
  not attempt-terminal write events.
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
- Stale-lock timeout: a PID-liveness check alone is not fully reliable
  (an OS can reuse a PID after the original process exits, and a crash can
  leave a lock behind with no process left to release it). A lock older
  than a configurable stale-lock window, independent of and comfortably
  longer than any real `preflight` run is expected to take, is treated as
  stale regardless of what the PID-liveness check reports, and may be
  reclaimed by a subsequent `solution_evaluate` call, which then acquires
  it as if it had been free.
- Named failure modes: (a) the lock file exists but is malformed or
  unparseable: treated as stale, reclaimed, and a diagnostic is logged;
  (b) the recorded PID is alive but belongs to an unrelated process due to
  PID reuse: indistinguishable from a live legitimate holder by the
  liveness check alone, bounded only by the stale-lock timeout, which is
  exactly why that timeout exists independent of PID liveness; (c) the
  holding `grounding-mcp` process dies after acquiring the lock but before
  its `preflight` child exits: the lock's PID (the parent) is now dead,
  the child may still be running orphaned per section 5's recommendation
  not to kill it, and there is genuinely no live process left that will
  ever call `writeVerdict` for that child's eventual output; this is not
  fully resolved by this design (see blocker 2, section 9), it is bounded:
  the lock is dead-but-not-yet-stale for up to the stale-lock window, and
  only after that window elapses is a new attempt licensed, at which point
  the orphaned child's eventual write (if any) racing the new attempt's
  own write is the same residual risk PR #211 already discloses (below),
  not a new one; (d) two acquisition attempts race at the OS-call level:
  resolved by the exclusive-create primitive above, not by any
  application-level check-then-set.
- The holder PID recorded is the `grounding-mcp` process's own PID, not
  the `preflight` child's PID: the liveness check's purpose is "is any
  process still alive that is responsible for eventually finishing this
  attempt and writing its result," which is the parent, not the child;
  tracking the child's PID would make the lock read as live for as long
  as an orphaned child survives even though nothing will ever act on its
  output, which is a worse signal for callers deciding whether to wait.

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
`invalidateVerdict`, on the `fix/8e29ad58-verdict-hardening` branch). The
on-disk lock in this section closes the "does not serialize concurrent
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
  only `status`, the terminal outcome class, and a summary; it never
  returns a `verdict` object or a `markerPath` that could point at a file
  that no longer exists or that has been superseded.
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
  respected, not replaced: every terminal `failed` attempt under this
  design still goes through the same `invalidateExisting`/
  `preflightOutcomeError` path PR #211 adds (or, if that PR has not yet
  merged when this is implemented, the equivalent pre-#211 overwrite
  behavior it will replace); the new attempt log is purely additive
  bookkeeping alongside that invalidation, never a substitute for it.

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
   stale-lock timeout, after which a new attempt is licensed; the orphaned
   child's own eventual write, if any, racing that new attempt is the same
   un-closed residual PR #211 already discloses for concurrent marker
   writers (quoted in full in section 7), not a new one this design
   introduces. This affects both the "restart" and the new "two client
   sessions, same id" rows of the acceptance matrix and the recommendation
   in section 5 not to kill child processes on disconnect; if orphaned
   processes turn out to accumulate unbounded even under the stale-lock
   bound, that recommendation needs revisiting together with the retention
   policy in section 5.
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
| Server restart mid-attempt | Old `attemptId` resolves to `unknown` ONLY once reconciliation confirms the holder PID is dead (section 6); a later independent attempt for the same `id` is licensed only once the on-disk lock is confirmed free (blocker 2, section 9, for the orphan-process question), never merely because the reported status reads `unknown` | Producer brief test simulating registry loss plus reconciliation; see brief 01 |
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
   The brief's own label was already "implementation-ready" before this
   review round, but that assessment predated the review catching H1 (the
   in-memory lock's cross-process unsoundness); it was correct in its own
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
   2). Neither brief was actually marked `blocked-on-<x>` in the prior
   round's own text despite this document's summary claiming so; this is
   the correction to that summary.

Both live in this task's run directory
(`.ai/runs/2026-09-05-open-pool-batch37/t006-briefs/`), outside this repo,
as instructed by the task assignment; they are not committed here.

## 11. For the reviewer

Every factual claim about existing code in this document cites a
repo-relative path and a function or heading name (never a bare line
number) so it can be checked directly: `packages/grounding-mcp/src/server.ts`
(`solution_evaluate` registration, `jsonResponse`, `StdioServerTransport`,
`main`), `packages/grounding-mcp/src/solution-verdict.ts`
(`evaluateSolution`, `writeVerdict`, `invalidateVerdict` on the
verdict-hardening branch, `evaluateGate`, `verdictDir`,
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
