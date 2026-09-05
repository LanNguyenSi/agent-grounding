# solution_evaluate call lifecycle: timeout, retrieval, and retry

Document date: 2026-09-05. Status: design, no code changed by this document.

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
protocol, and none of it is introspectable further from local material.
Run evidence (`t006-client-capabilities.md`) records this per client as
"unknown (not verifiable locally)" rather than asserting support either
way. No live long-running job was executed against any of them to observe
actual behavior; this document reasons from the SDK's own documented
contract only.

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
| Claude Code (stdio) | Yes, `~/.claude.json` `mcpServers.grounding-mcp` | unknown (not verifiable locally) | unknown (not verifiable locally) | Yes (in production use today) |
| Codex (stdio) | Yes, `~/.codex/config.toml` `[mcp_servers.grounding-mcp]` | unknown (not verifiable locally) | unknown (not verifiable locally) | Yes (in production use today) |
| opencode | No (`~/.config/opencode/opencode.json` has no MCP registrations at all on this machine) | unknown (not verifiable locally) | unknown (not verifiable locally) | Not currently wired to this tool |

Full detail, exact file paths, and the reasoning behind each "unknown" is in
the run-evidence file `t006-client-capabilities.md` (referenced, not
duplicated here per this workspace's placement convention: host paths and
per-machine specifics live in the run artifact, not in this product
document).

No client capability was asserted as supported anywhere in this document
without a config or SDK file backing it. Every capability this design
requires works over ordinary MCP tool calls (see section 4), which all
three clients demonstrably use today; nothing here depends on progress
reset or the experimental tasks protocol being supported by any client.

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
  timeout on receiving one (`resetTimeoutOnProgress`). Both are
  unconfirmed for every client actually registered against grounding-mcp
  in this workspace (section 2).
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

1. Every file in `dist/esm/experimental/tasks/` is marked `@experimental`,
   "may change without notice" verbatim in the SDK's own source. Anchoring
   an anti-hacking trust boundary's call lifecycle to an interface the
   library itself disclaims stability for is a bad trade for a small,
   single-tool feature.
2. Adopting it is not a configuration tweak. The current registration
   (`server.ts`, `server.tool('solution_evaluate', ...)`) uses the SDK's
   legacy shorthand, whose config shape has no `execution` field at all.
   Even the newer `registerTool` config in this installed version
   (`dist/esm/server/mcp.d.ts`, the `registerTool` overload) has no
   `execution` field either; only `registerToolTask` exposes
   `execution.taskSupport`. Adopting task support means migrating the
   registration shape and implementing or wiring a `RequestTaskStore` and
   `TaskMessageQueue` (the SDK's own persistence interfaces,
   `dist/esm/experimental/tasks/interfaces.d.ts`), which grounding-mcp has
   none of today.
3. Whether any of the three clients registered against grounding-mcp in
   this workspace understand the experimental tasks protocol messages at
   all is unknown from local material (section 2). Committing the sole
   completion-gate producer's call lifecycle to a capability no locally
   verifiable client supports is a bet this design declines to make.

Revisit this option once the feature graduates out of `@experimental` in a
future SDK release and client support can be verified against a real
session, not before.

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
- `unknown`: terminal-ish, reserved for a lookup by `attemptId` after the
  server process that tracked it has restarted and lost the in-memory
  record (section 8). Once an attempt is reported `unknown`, it must
  remain `unknown` in any persisted attempt history forever; a later,
  successful marker for the same `id` is recorded as a new, distinct
  attempt and never retroactively treated as evidence that the `unknown`
  attempt itself succeeded ("retry never upgrades unknown to success",
  tracker acceptance criterion 3).

### Tools

- `solution_evaluate({ id, repoPath?, forceNewAttempt? })` (existing name,
  extended behavior): if no attempt is currently `running` for `id`, starts
  one. If an attempt for `id` is already `running`, this call joins it
  (section 7) instead of starting a second `preflight` process, unless
  `forceNewAttempt: true` is set, which is only honored when no attempt for
  `id` is currently `running` (see section 7 for why "force while running"
  is refused rather than honored). The call then waits, optionally
  emitting standard progress notifications on the section 3 layer, up to
  an internal bound safely under the client's likely timeout (a
  configuration value for the implementation to set, comfortably below the
  SDK's 60 s default, for example 45 s). If the attempt reaches a terminal
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
  `solution_evaluate_status`.

`solution_gate` is unchanged: it still only reads the signed marker file
and never reasons about attempts.

### Poll rules

- Reconnect/query of the same attempt: calling `solution_evaluate_status`
  or `solution_evaluate_result` with a known `attemptId`, or calling
  `solution_evaluate({ id })` again while that id's attempt is still
  `running` (the join case, section 7), are all reconnects to the SAME
  attempt. None of them start a new `preflight` process.
- Explicit new retry: calling `solution_evaluate({ id })` (with or without
  `forceNewAttempt`) after the prior attempt for `id` has reached a
  terminal state (`completed`, `failed`, or `unknown`) starts a genuinely
  new attempt with a new `attemptId` and a new `preflight` process.
- A caller may always ask "what happened to `id`" via
  `solution_evaluate_status({ id })` / `solution_evaluate_result({ id })`
  without an `attemptId`, resolving to the latest attempt. This closes the
  case where a caller's own request timed out with no payload at all
  (section 3) and it never learned any `attemptId`.

### Timeout vs. process lifetime vs. disconnect/cancel behavior

- The internal wait bound inside `solution_evaluate` governs only how long
  that ONE request blocks; it must stay safely under the observed client
  default (60 s for the SDK default, unless a future client is confirmed
  to use a different one) so the caller gets a handle back before its own
  timeout fires, not after.
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

- Restart: grounding-mcp's in-memory attempt registry (the per-`id`
  "currently running attempt" lock and any status cache) does not survive
  a process restart. A `solution_evaluate_status`/`_result` lookup for an
  `attemptId` issued before a restart must return `unknown`, never hang or
  silently report `running` forever. Whether the underlying orphaned
  `preflight` child process itself is killed when its parent
  `grounding-mcp` process exits (Node's `execFileAsync` without
  `detached: true`, platform-dependent process-group behavior) was not
  verified for this document and is listed as a blocker in section 9.
- Retention/cleanup: terminal attempts are pruned from the in-memory
  registry after a bounded retention window past their terminal timestamp
  (a configuration value, analogous in spirit to the SDK's own
  `TaskCreationParams.ttl`). Any on-disk, append-only attempt log (section
  6) needs its own bounded rotation or pruning policy (time- or
  count-based) so it cannot grow unbounded; the exact numbers are an
  implementation-brief decision (section 10), not fixed here.
- Log access: `solution_evaluate_status` and `solution_evaluate_result`
  are the log-access surface this design adds. They read the append-only
  attempt log (or the in-memory registry backing it), never the signed
  marker's gate authority.

## 6. Append-only retry history

A new, separate append-only attempt log records one entry per attempt
(`attemptId`, `id`, `head`, `startedAt`, terminal `status`, terminal
timestamp, and a short outcome summary; it does not need to duplicate the
full diagnostics payload). This log is DISTINCT from the single, signed,
overwritten verdict marker (`verdictPath(id)`, unchanged by this design):
the marker is gate authority for exactly one `id` at exactly one HEAD; the
log is an audit/history trail across every attempt ever made for that
`id`, mirroring the "diagnostics are advisory, never gate authority"
separation already established for the diagnostics field
(`docs/okf/solution-acceptance-verdict-contract.md`, "Advisory preflight
diagnostics").

This satisfies the tracker's requirement directly:

- Retry never overwrites a prior attempt/result: each attempt gets its own
  log entry, appended once terminal; an existing entry is never mutated.
- Retry never upgrades `unknown` to success: an `unknown` entry, once
  written, is never revised by a later attempt's outcome; the later
  attempt gets its own new entry.
- Retry never silently launches a duplicate process: guaranteed
  structurally by the join-in-flight rule (section 7), which makes a
  genuinely new attempt possible only once the prior one for that `id` is
  terminal.

## 7. Concurrency: join-in-flight, not duplicate

Two `solution_evaluate({ id })` calls that arrive while no attempt for
`id` is running race to become "the" new attempt. Node's single-threaded
event loop makes an atomic, synchronous check-and-set on an id-keyed
in-memory lock straightforward to implement correctly (check the lock,
and if free, set it, before the first `await` in the handler): exactly one
call wins and starts the `preflight` process; the other joins the winner's
attempt and returns the same `attemptId`, never starting a second process.

`forceNewAttempt: true` is refused (returns an error, starts nothing) while
an attempt for that `id` is already `running`. This is deliberate: honoring
a forced new attempt against a still-running one would reintroduce exactly
the race PR #211 documents as an accepted, NOT-closed residual ("This is a
sequential guarantee for writable marker storage; it does not serialize
concurrent writers", `packages/grounding-mcp/src/solution-verdict.ts`,
function `invalidateVerdict`, on the `fix/8e29ad58-verdict-hardening`
branch). Under this contract, a genuinely independent new attempt for the
same `id` is only ever created after the prior one reaches a terminal
state, so two `preflight` processes racing to invalidate and write the
same marker for the same `id` cannot happen. A "cancel the in-flight
attempt, then retry immediately" capability (killing the child process on
request) is a separate capability this document does not design; it is
listed as a dependency in the producer brief (section 10) for whoever
wants true force-retry-while-running later.

## 8. Trust boundary

- Retrieved attempt status or a terminal `EvaluateResult` obtained via
  `solution_evaluate_status`/`_result` grants no ready authority by itself.
  The only path to "done" remains the same as today: a `ready` signed
  marker at the current HEAD, checked by `solution_gate` (or the harness's
  own `readVerdict`). This design adds no new way to satisfy the gate.
- An `attemptId` is an opaque, server-generated token, never a command,
  path, or artifact; a caller cannot use it to invoke anything beyond the
  two read-only lookup tools above. It carries no secret metadata: no
  environment variable, signing key path, or filesystem location beyond
  what the caller already supplied (`repoPath`) is exposed through it.
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

1. Whether any of Claude Code, Codex, or opencode actually reset their
   request timeout on progress notifications, or would ever understand a
   future task-augmented capability, is unverified (section 2). Nothing in
   the chosen contract (section 4-C) depends on this, but the complementary
   progress layer (section 3) does, and its value should not be overstated
   in the producer brief.
2. Whether an orphaned `preflight` child process is reliably killed or
   reliably survives its parent `grounding-mcp` process exiting (crash or
   deliberate restart) was not verified against this platform's actual
   process-group behavior. This affects both the "restart" row of the
   acceptance matrix and the recommendation in section 5 not to kill child
   processes on disconnect; if orphaned processes turn out to accumulate
   unbounded, that recommendation needs revisiting together with the
   retention policy in section 5.
3. Whether a real MCP stdio session between grounding-mcp and Claude Code
   or Codex ever actually delivers a transport-level disconnect or
   `notifications/cancelled` mid-call (as opposed to the process pair
   simply persisting for the whole session) is unverified; no live
   long-running job was run to observe this.
4. The exact bound used inside `solution_evaluate` before it falls back to
   returning a handle (this document suggested "safely under 60 s, for
   example 45 s" as an illustration, not a fixed number) and the retention/
   rotation numbers for the in-memory registry and the on-disk attempt log
   are implementation-brief decisions, deliberately left open here.

## 10. Acceptance matrix and implementation split

| Scenario | Expected behavior under this contract | Where it is verified |
| --- | --- | --- |
| Run exceeds 30 s, caller stays connected, no progress opt-in | `solution_evaluate` blocks past the internal bound, returns `{status:"running", attemptId}`; caller polls `solution_evaluate_result` | Producer brief unit test with a stubbed slow `preflight`; see brief 01 |
| Run exceeds 30 s, caller opts into progress and its client resets the timeout | `solution_evaluate` blocks the whole duration, sends progress pings, returns the terminal result inline | Producer brief unit test using a fake `progressToken`/notification sink; see brief 01 |
| Caller times out (no progress), result completes afterward | `preflight` keeps running; a later `solution_evaluate_status`/`_result` (with or without a known `attemptId`) observes the terminal state; the signed marker is written exactly as it would be today | Producer brief integration test; see brief 01 |
| Transport disconnect / cancellation mid-run | Child process is not killed (section 5, flagged blocker); attempt remains queryable once terminal | Producer brief test plus blocker 3, section 9 |
| Process failure (crash, signal, unexpected exit) | Attempt terminal state `failed`; existing `preflightOutcomeError`/marker-invalidation behavior unchanged; new log entry `failed` | Existing `tests/solution-verdict.test.ts` cases (for example "keeps a signal termination visible in diagnostics...") plus new attempt-log assertions; see brief 01 |
| Malformed preflight output | Attempt terminal state `failed`, unchanged parser/diagnostics behavior (`parsePreflightJson`, `inspectPreflightPayload`) | Existing `tests/solution-verdict.test.ts` cases plus new attempt-log assertions; see brief 01 |
| Server restart mid-attempt | Old `attemptId` resolves to `unknown`; a later independent attempt for the same `id` is a new, unrelated entry (blocker 2, section 9, for the orphan-process question) | Producer brief test simulating registry loss; see brief 01 |
| Concurrent starts for the same id | Exactly one `preflight` process; the second caller joins and receives the same `attemptId` | Producer brief unit test asserting a single child-process invocation across two concurrent calls; see brief 01 |
| Retry after a caller's own timeout | If the original attempt is still `running`, the retry joins it (no duplicate); if it is already terminal, the retry is a genuinely new attempt with its own log entry | Producer brief test covering both sub-cases; see brief 01 |
| Cleanup | Terminal attempts age out of the in-memory registry and the on-disk log after their retention window | Producer brief test with an injectable clock; see brief 01 |

Two narrow, independently reviewable implementation briefs follow this
document, both marked `blocked-on-<x>` where section 9's blockers apply:

1. `01-producer-attempt-lifecycle.md`: the attempt registry, join-in-flight
   logic, `attemptId` generation, the append-only attempt log, and the two
   new tools' server-side logic in `solution-verdict.ts` / `server.ts`.
2. `02-client-polling-integration.md`: the harness policy-pack prompt text
   and README updates that teach a solving agent when to poll versus retry,
   plus the standard-progress ergonomics layer from section 3 (the sibling
   task `8c9a99fc`'s scope, sequenced after brief 01 lands).

Both live in this task's run directory
(`.ai/runs/2026-09-05-open-pool-batch37/t006-briefs/`), outside this repo,
as instructed by the task assignment; they are not committed here.

## 11. For the reviewer

Every factual claim about existing code in this document cites a
repo-relative path and a function or heading name (never a bare line
number) so it can be checked directly: `packages/grounding-mcp/src/server.ts`
(`solution_evaluate` registration, `jsonResponse`),
`packages/grounding-mcp/src/solution-verdict.ts` (`evaluateSolution`,
`writeVerdict`, `invalidateVerdict` on the verdict-hardening branch,
`evaluateGate`), `harness/src/policy-packs/builtin/
solution-acceptance-runtime.ts` (`readVerdict`), and the installed
`@modelcontextprotocol/sdk@1.30.0` `.d.ts` files cited in
`t006-client-capabilities.md`. Claims about local client configuration
cite the exact config file and key path. Where a claim could not be
settled from locally available material, it is written as "unknown (not
verifiable locally)" rather than asserted.
