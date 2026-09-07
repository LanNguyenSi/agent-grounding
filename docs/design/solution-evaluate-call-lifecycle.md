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

Revision (round 4, after review round 3 and an advisor consult): the
cross-process half of section 7 no longer derives a lock protocol of its
own. The advisor's recommendation, adopted as this round's decision, is to
delegate mutual exclusion to the primitive this codebase already depends
on elsewhere (`proper-lockfile`, wrapped as `withFileLock` in
`harness/src/io/lock.ts`) and to cite that library's documented semantics
rather than re-derive them in prose. Removed with it: the
`.lock.takeover` marker, the five-step takeover sequence, the
byte-identity re-read, the recursive stale reclamation, the
hand-specified mtime heartbeat, the PID-liveness authority, and the
hand-rolled host identifier. Acquisition, staleness, the heartbeat,
compromise detection, and ownership-checked release are now the library's
behavior, cited; this document states only the invariant, the join rule,
the compromise rule, and where the lock lives. Round 3's remaining
findings are closed in the same pass: the attempt log's reconciliation
append, its compaction, and its liveness check all run under the same id
lock (section 6); persisted records are size-bounded and an unparseable
line has a stated reader rule (section 6); a compacted `unknown` stays
`unknown` (section 5, section 6); the persisted error string's truncation
and the intended file modes are stated (section 8); the sibling task's
branch state is re-measured with a timestamp (section 3);
`EvaluateResult.error`'s actual type is corrected (section 5); and this
document's branch is merged with `master` at PR #211 (`eefd18fe`).
Section 7 and section 9 now also state the proportionality fact that
bounds this design's complexity budget: `evaluateGate` fails closed on
every duplicate-run outcome, so the lock buys wasted CPU and a single
in-flight handle, never gate safety.

Revision (round 5, bounded closing delta; the orchestrator has decided a
merge-hold after this round, leaving the dependency confirmation and the
merge itself to the operator): the round-4 headline invariant and the
"Release" bullet in section 7 overstated what `proper-lockfile` actually
guarantees; the library's `unlock` consults only its own in-process
registry, never the lock directory's on-disk identity, so a holder whose
heartbeat is starved past the stale window can have its release remove a
different, later holder's lock rather than its own (reproduced with two
real processes). The invariant is now scoped to hold only while every
holder's heartbeat keeps its lock fresh, and this residual, together with
the README's own "Compromised" section quoted in full, is recorded in
section 7. Section 6's "retry never upgrades unknown" guarantee is
corrected from a write-side check to a reader-side precedence rule: the
write-side re-read the attempt log's `terminal` record performed before
appending is an optimization, not the guarantee, because the writer no
longer holds the lock by the time it runs; the actual guarantee, that any
`reconciled-unknown` record for an `attemptId` supersedes a later
`terminal` record for the same `attemptId` regardless of order, is now
stated as a reader rule every consumer of the log must implement. The
sibling task (tracker `8c9a99fc`) is re-measured and found landed: PR #212
merged to master as `df9722d` (2026-09-05 20:02:33Z), adding progress-ping
support this document's section 1 and section 3 now cite instead of
describing as absent or as a coordination risk; section 10 and brief 02
are rescoped accordingly, from "implement progress pings" to "document
what shipped". A `running-unconfirmed` bullet is added to section 5's
state list (it already existed in section 7's prose; section 5's list was
missing it). Section 7's "Where the lock lives" now states plainly that
the anchor file exists only for parity with the harness's own
`ensureLockTarget` convention and path stability, that nothing reads it,
that it need not even exist for `lock()` to succeed under `realpath:
false`, and that no code may make behavior conditional on its existence.

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
SDK's legacy shorthand). Re-measured for round 5 (`gh pr view 212`, `git
log --oneline -1 df9722d`): the handler's await of `evaluateSolution` is
now wrapped, since PR #212 (master `df9722d`, merged 2026-09-05
20:02:33Z), in `withProgressPings` (`packages/grounding-mcp/src/progress.ts`,
`DEFAULT_PROGRESS_INTERVAL_MS`); if the caller's request carries
`_meta.progressToken`, the handler now DOES ping `notifications/progress`
on it periodically while `evaluateSolution` is still pending, and reads
`_meta.progressToken` to do so. A caller that supplies no token gets no
pings, per the SDK's own "not obligated" language (section 3). This
document's own prior claim, "No progress notifications are sent, no
`_meta.progressToken` is read", is corrected by this measurement; see
section 3 for the sibling task's now-landed state. The handler still
awaits `evaluateSolution` to a terminal result either way today (there is
no bounded-wait fallback yet; that is what this document's own section 4
and 5 add) and returns its result as one JSON-in-text response
(`jsonResponse(result)`, defined near the top of `server.ts`). The SDK's
default per-request timeout (60 s, `DEFAULT_REQUEST_TIMEOUT_MSEC` in the
installed `@modelcontextprotocol/sdk@1.30.0`,
`dist/esm/shared/protocol.js`) is unmodified by any of this: sending a
progress ping does not itself change any client's own timeout behavior,
and no client this document measures resets its deadline on them today
(section 2). See
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

The sibling task (agent-grounding tracker id `8c9a99fc`) proposed adding
standard MCP progress
notifications during `solution_evaluate`, mirroring the pattern already
shipped in `agent-preflight/src/mcp.ts` (`withProgressPings`,
`DEFAULT_PROGRESS_INTERVAL_MS = 10_000`): if the caller supplied
`_meta.progressToken`, ping it periodically while the child process runs.
Re-measured for round 5, 2026-09-05, with `gh pr view 212
--json number,title,mergedAt,createdAt,mergeCommit` and `git log --oneline
-1 df9722d`: that work has LANDED. PR #212, opened 2026-09-05 19:38:29Z
from branch `feat/8c9a99fc-evaluate-progress` (the same branch a prior
round of this document found only locally present, never pushed), merged
2026-09-05 20:02:33Z as master `df9722d`, adding exactly
`packages/grounding-mcp/src/progress.ts` (`withProgressPings`,
`DEFAULT_PROGRESS_INTERVAL_MS`) and `_meta.progressToken` handling wired
into the `solution_evaluate` handler in `server.ts` (section 1), plus its
own test coverage in `tests/grounding-gate-mcp-roundtrip.test.ts`. A prior
round of this document reported the branch as started but not landed
anywhere shared; this round's re-measurement supersedes that finding
rather than merely restating it. There is no longer a sibling task to
coordinate with; the coordination need this section previously described
is closed.

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
4 below builds the lifecycle underneath it; the progress pings themselves
already ship today (PR #212, above), independently of and ahead of that
lifecycle, as an ergonomics layer over the synchronous fast path, not a
substitute for it.

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
  itself was still `running` and no process holds that id's lock any more
  (the reconciliation pass in section 6 is what actually assigns this
  status, and section 7's lock is the liveness authority it consults; it
  is never inferred merely from "we don't have an opinion"). Once an
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
  a genuine terminal state (`completed` or `failed`). Compaction of an
  attempt that reached `unknown` rather than a genuine terminal state does
  NOT produce `expired`: its tombstone records the `unknown` outcome class
  and the attempt keeps resolving to `unknown` after compaction, so
  pruning can never launder an unestablished fate into an established one
  (section 6, record kind 4). Distinct from
  `unknown` on purpose: `expired` means the attempt's outcome IS known to
  have been terminal, the detail was simply not retained long enough for
  this lookup; `unknown` means the attempt's fate was never established at
  all. `expired` carries none of `unknown`'s "never upgrade" bookkeeping
  requirement (there is nothing to protect against upgrading, since the
  attempt's terminal-ness is already established), but it participates in
  the same "does not license a bypass" rule as `unknown`: an `expired`
  prior attempt does not itself license a new attempt for that `id`; the
  lock-liveness check in section 7 still governs.
- `running-unconfirmed` (new): non-terminal, an `id`-level status only,
  never carries an `attemptId` (there is nothing to name: this is exactly
  the case where the log has no `start` record to answer with). Reserved
  for a lock that cannot be acquired while no `running` log row for that
  sanitized id can be found to name it (section 7, "Acquisition, and what
  joining means"): a crash between an acquisition and the log's own
  `start` record, a lock currently held by a reconciliation pass rather
  than an attempt, or an abandoned lock whose newest attempt row already
  carries an outcome record. Carries a poll hint (`pollAfterMs`), the same
  as `running` does, so a caller sees this is not an error; it is not a
  licence to retry either, since a `solution_evaluate` call still cannot
  acquire the lock while this state holds and must not spawn a second
  process (section 7). It resolves by itself on a later poll: either the
  holder appends its `start` record and the next poll reads `running` with
  a real handle, or the lock goes stale and the library reclaims it on the
  next acquisition. See section 7 for the full derivation.

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
  summary, an `outcomeClass`, and, for a failure, a size-bounded copy of
  the `error` string, never the full diagnostics payload):
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
    `error` / `compromised`) and `summary` are the same fields persisted
    in the attempt log (section 6); `error`, when present, is the
    persisted error string. `EvaluateResult.error` is itself already a
    string today (`error?: string`,
    `packages/grounding-mcp/src/solution-verdict.ts`, `EvaluateResult`),
    so the difference between the two is not a shape difference but a
    LENGTH one: what a cross-process answer returns is the persisted,
    size-bounded copy (section 6, "Record size bound"), which may be a
    truncated prefix of what the owning process holds in memory. A prior
    round of this document called the same-process value an "object",
    which was simply wrong about the existing type.

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
  attempt. None of them start a new `preflight` process. An id reported
  `running-unconfirmed` (section 5 states, section 7 "Write order and
  crash windows") is the same reconnect case with no `attemptId` to name
  yet: keep polling with the returned hint; it is neither an error nor a
  licence to retry.
- Explicit new retry: calling `solution_evaluate({ id })` (with or without
  `forceNewAttempt`) starts a genuinely new attempt with a new `attemptId`
  and a new `preflight` process ONLY when its own attempt to acquire that
  `id`'s lock (section 7) actually succeeds. A prior attempt's
  reported STATUS (`completed`, `failed`, `unknown`, or `expired`) is
  informational, not the gate: in particular, an attempt reported
  `unknown` or `expired` because this process's in-memory registry lost
  track of it does NOT by itself license a new attempt while another
  process still holds that id's lock (this closes the restart-race in
  section 9, blocker 2, and in the
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
  entry itself is `running` and that id's lock is confirmed free (the
  lookup's own retry-free acquisition of it succeeds, section 7), recorded
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
  lock bounds the resulting risk with the lock library's own stale window
  rather than resolving it outright, and it remains a listed blocker in
  section 9.
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
  summary, persisted error string) with a small, much-longer-retained
  tombstone (`attemptId`, `id`, the pruned attempt's OUTCOME CLASS, prune
  timestamp) so a later lookup can still distinguish "this attempt existed
  and finished, its detail was pruned" (`expired`, above) from "this
  attempt's fate was never established" (`unknown`, above). The outcome
  class in the tombstone is what decides which of the two a compacted
  attempt resolves to: a compacted `completed`/`failed` attempt resolves
  to `expired`, a compacted `unknown` attempt keeps resolving to
  `unknown`, and compaction never converts one into the other. Neither
  status by itself licenses a new attempt; the lock acquisition in
  section 7 still governs. The exact retention/rotation numbers themselves remain an
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
record appended (last-record-wins), WITH ONE READER-SIDE EXCEPTION: if any
`reconciled-unknown` record exists anywhere among an `attemptId`'s
records, that attempt resolves to `unknown` regardless of what any record
appended later for the same `attemptId` says, superseding last-record-wins
for that one `attemptId` specifically. This is a READER rule, enforced by
every consumer of the log, not a write-order guarantee. The write-side
re-read described under record kind 2 below (a `terminal` write skips
itself when a `reconciled-unknown` record for its own `attemptId` is
already present) runs, on the ORDINARY path, while the writer still holds
that id's lock: `execute` releases only in its own `finally`, after this
write (re-read included) has already returned
(`src/solution-attempt-log.ts`). Holding the lock through the re-read is
exactly why it never actually finds a `reconciled-unknown` record on that
path in the first place: reconciliation can append one only after
acquiring the id's lock with no retries (section 7), which is impossible
while this process still holds it. The re-read is a genuine, non-atomic
check only for the two paths that fall OUTSIDE the ordinary one: a holder
that has already lost its lock (`compromised`, section 7, including the
starvation residual described later in the document, where the lock is
already gone before this process's own heartbeat reports it) before this
write runs, and any other process's terminal write for an attemptId a
reconciler has meanwhile settled while that writer was itself outside the
lock. Against those two, the read and the append are not atomic with each
other the way the reconciliation pass's own read-then-append, entirely
inside one lock acquisition, is. The reader rule above, not this
write-side check, is what actually closes "retry never upgrades unknown
to success". "The latest attempt for `id`" is the attempt whose `start`
record has the latest `startedAt` among the
attemptIds still present (not yet compacted away, below).

Every record carries `attemptId`, `id`, and a `kind`. Exactly four kinds
exist:

1. `start`: `head`, `startedAt`, the holder process's PID, status
   `running`. Written
   once, the moment an attempt's lock is acquired (section 7), before the
   `preflight` child process is spawned, by the attempt's own process.
   Without this write, a lookup mid-run, before any terminal record
   exists, has nothing to read at all; this is the fix for a prior
   round's gap. The recorded PID is a diagnostic aid for a human reading
   the log, NOT the liveness authority: since round 4, whether an attempt
   is still live is answered only by whether that id's lock can be
   acquired (section 7), never by probing the PID. The component
   responsible is the same module that owns
   the lock, `solution-attempt-log.ts` (suggested name, brief 01), invoked
   synchronously inside the same lock acquisition that authorized the
   attempt.
2. `terminal`: `status` (`completed` or `failed`), terminal timestamp,
   `outcomeClass` (`ready` / `not-ready` / `error` / `compromised`), a
   short `summary`
   (counts, not the full diagnostics payload), and, for a `failed`
   terminal write, the persisted, size-bounded `error` string (section 5
   for what a caller sees, "Record size bound and unparseable lines"
   below for the cap). `compromised` is the outcome class for an
   attempt whose holder lost its lock mid-run (section 7, "Compromise");
   it maps onto the `failed` attempt state, so section 5's state list is
   unchanged by it. Written
   exactly once, by the SAME process that wrote the `start` record for
   this `attemptId`, when that attempt's own `evaluateSolution` invocation
   resolves; before appending, that process re-reads the log for its own
   attemptId and skips the append if a `reconciled-unknown` record for it
   is already present (see kind 3). This re-read is an OPTIMIZATION, not
   the guarantee: on the ORDINARY path it runs while the writer still
   holds the id's lock (see the corrected ordering in "Log file layout"
   above for why it never actually races there); it is a genuine,
   non-atomic check only for the compromised-holder and
   reconciled-elsewhere paths that fall outside the ordinary one.
   The actual guarantee that a late-arriving terminal write can never
   upgrade an already-`reconciled-unknown` attempt is the READER-side
   precedence rule stated above under "Log file layout"; section 9's
   corrected residual explains when a late terminal write can actually
   occur despite this write-side check.
3. `reconciled-unknown`: written for an `attemptId` whose last record is
   still `start` (`running`) at a moment when that id's lock is provably
   free, by either `reconcileOrphanedAttempts()` at startup or the
   read-path liveness check described below. "Provably free" has exactly
   one meaning under this design: the writing process itself acquired
   that id's lock with no retries (section 7), which is why the append
   happens INSIDE that acquisition. Exactly one
   `reconciled-unknown` record may ever exist for a given `attemptId`,
   and the lock is what guarantees it: two liveness checks racing each
   other cannot both be inside the lock, so the second one to get in finds
   the record already there (re-read immediately before append, skip if
   one is already present) and appends nothing. Once written, that
   attemptId's outcome is `unknown` forever
   (its own attempt log entry list will never again change kind).
4. `tombstone`: written only during compaction (below), replacing an
   entire attempt's records (`start` plus `terminal`, or `start` plus
   `reconciled-unknown`) with one small record (`attemptId`, `id`, the
   attempt's OUTCOME CLASS, prune timestamp) once the retention window has
   elapsed. The outcome class recorded is the one the attempt actually
   reached, including `unknown`: a compacted `completed`/`failed` attempt
   resolves to `expired` afterwards, a compacted `unknown` attempt still
   resolves to `unknown` (section 5). Compaction is a retention
   mechanism, never a laundering step that turns an unestablished fate
   into an established one.

No writer other than an attempt's own process may ever append a `start` or
a `terminal` record for that attempt. The two narrow exceptions, named
explicitly because they are the only records one attempt's process
appends on another attempt's behalf: reconciliation (startup pass or
read-path check) may append ONLY a `reconciled-unknown` record, and only
inside a successful, retry-free acquisition of that id's lock; compaction
may append ONLY a `tombstone` record, and only inside a lock acquisition
some other operation on that id already holds.

Compaction never acquires the id lock on its own account. It runs as a
tail step inside a lock acquisition already made for another reason (an
attempt start, or a reconciliation pass), and only when that acquisition
succeeded; an acquisition that came back `ELOCKED` skips compaction
entirely and leaves it for a later pass. This is deliberate and closes a
race the join rule would otherwise have: section 7 treats `ELOCKED` as
"join, do not spawn", so a lock held by a compaction-only holder would
make a caller join an attempt that does not exist. Because compaction
never holds the lock by itself, the only non-attempt holder a joiner can
ever meet is a reconciliation pass, which does a bounded number of file
reads and at most one append; section 7's join rule states what a caller
sees in that window. Compaction rewrites the whole per-id file via a temp
file plus an atomic rename (`fs.rename`, same directory, same
filesystem), never an in-place truncate-and-rewrite: everything not yet
past its retention window is carried over unchanged, and each attempt's
records past its window are replaced by that attempt's `tombstone`.

### Record size bound and unparseable lines

Two rules keep the log's growth and its parsing failure mode bounded,
since it is the only place this design persists free-form text (an error
string) that a caller can influence indirectly (section 8):

- Size bound: every record is serialized as ONE line and written with ONE
  `O_APPEND` write, and the whole record is capped at 2 KiB of UTF-8. The
  variable-length fields are the persisted `error` string and the
  `summary`; both are truncated (with an explicit truncation marker) as
  far as needed for the serialized record to fit that cap, error string
  first. A single write per record is what keeps a concurrent append from
  interleaving inside a line on the platforms where `O_APPEND` writes up
  to that size are atomic; a record that could not be made to fit is a
  bug, not a reason to emit a longer line.
- Unparseable line: a reader that cannot parse a line SKIPS that line and
  keeps reading, and interprets each attempt by the records it can still
  read. It never aborts the whole file, never rewrites or truncates it,
  and never treats an unparseable line as an outcome. The consequence is
  stated rather than hidden: an attempt whose only outcome record is the
  damaged line reads as still `running` and is then resolved by the
  ordinary liveness path (the lock is free, so it becomes `unknown`,
  above), which fails safe in the same direction as everything else here.

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

The liveness check, in one sentence: try to acquire that id's lock with no
retries (section 7). Success means no process holds it, so any log row for
that id still reading `running` belongs to a holder that is gone. `ELOCKED`
means a holder is alive, so there is nothing to reconcile. The acquisition
IS the check; nothing else probes liveness, and in particular no PID is
probed any more (round 4; a PID cannot be checked reliably across PID
reuse, and the library's own stale window already covers a holder that
died without releasing).

Reconciliation: a `reconcileOrphanedAttempts()` pass (suggested name, in
`solution-attempt-log.ts`) runs once at `grounding-mcp` process startup,
before the transport connects (`server.ts`, `main()`), and scans every
per-id log file for an `attemptId` whose last record is `start`
(`running`). For each such id it acquires that id's lock with no retries;
on `ELOCKED` it moves on (the holder is alive), and on success it appends
a `reconciled-unknown` record for every still-`running` row of that id,
inside the acquisition, exactly once per attemptId per the guard in kind 3
above, then releases. Because the append happens under the lock, a holder
that is still alive can never have its own row reconciled out from under
it, and two reconcilers cannot both append for the same `attemptId`: the
second one to acquire the lock finds the `reconciled-unknown` record
already there and appends nothing (kind 3, "exactly one ... record may
ever exist"). That is the race this acquisition closes, the WRITER race
for the `reconciled-unknown` record itself; a separately-arriving
`terminal` write for the same `attemptId` is handled by the reader-side
precedence rule above ("Log file layout"), not by this acquisition. The
pass additionally sweeps for a LOCK whose id has no corresponding log row
at all (a crash between lock acquisition and the `start` record's append):
if that lock can be acquired, there is nothing to reconcile and the id is
simply free again; if it cannot, section 7's join rule describes what a
caller sees.

Startup-only reconciliation cannot stop a `running` row whose holder died
AFTER the last startup; nothing would re-check it until the next restart,
which may be arbitrarily far off. `solution_evaluate_status`,
`solution_evaluate_result`, and `solution_evaluate`'s own join path
therefore each run the IDENTICAL check, the same retry-free acquisition,
as part of every lookup or join against a `running` row, not only once at
process startup. When any of them acquires the lock and finds a stale
`running` row underneath it, it appends the SAME one-time
`reconciled-unknown` record reconciliation would have appended, guarded
identically and under the same lock. Read-path checks are therefore not a
weaker copy of the startup pass; they are literally the same operation
run from a different entry point.

This narrows, rather than removes, the invariant from the prior round:
"never inferred at read time" forbids only inferring `unknown` from "we
have no opinion" (a lookup that finds no in-memory record must NOT
conclude `unknown` on that basis alone; section 5's "Restart" bullet). It
does not forbid the read path from RUNNING the same liveness check and
APPENDING the same kind of record reconciliation would; a `reconciled-
unknown` record is always evidence-backed (a lock this process itself
acquired while the row still read `running`), regardless of which pass
wrote it. Section 5's "Restart" bullet is worded
to match: a lookup resolves to `unknown` only once some liveness check,
whichever process or pass ran it, has held the lock over a stale
`running` row and appended the record, never merely because an in-memory
registry happens to be cold.

This satisfies the tracker's requirement directly:

- Retry never overwrites a prior attempt/result: each attempt owns exactly
  one `start` record and, once it reaches an outcome, exactly one
  `terminal` OR `reconciled-unknown` record, appended only by its own
  process (or, for `reconciled-unknown` only, by a reconciliation pass);
  no attempt's outcome record is ever touched by a different attempt.
- Retry never upgrades `unknown` to success: guaranteed by the READER-side
  precedence rule ("Log file layout" above), not by the write-side
  re-read in kind 2 (which is an optimization only): once any
  `reconciled-unknown` record exists for an `attemptId`, every reader
  resolves that `attemptId` to `unknown` regardless of any `terminal`
  record physically appended afterward for the same `attemptId`. A later,
  independent attempt for the same `id` gets its own new `attemptId` and
  its own new records, unaffected either way.
- Retry never silently launches a duplicate process: guaranteed
  structurally by the join-in-flight rule (section 7), which makes a
  genuinely new attempt possible only when an acquisition of that `id`'s
  lock actually succeeds, not merely once a prior attempt's log row reads
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

### Cross-process concurrency (delegated to a lock library, revised in round 4)

The invariant, and the whole of what this design promises across
processes: AT MOST ONE LIVE `preflight` PROCESS PER SANITIZED ID PER HOST
WHILE EACH HOLDER'S HEARTBEAT KEEPS ITS LOCK FRESH. Nothing more is
claimed, and the qualifier is load-bearing, not decorative: a holder whose
heartbeat is starved (a busy event loop, laptop sleep, `SIGSTOP`) past the
stale window before it notices its own compromise can be reclaimed by a
second acquirer, producing two live `preflight` processes for the same id
plus a spurious `terminal` record with `outcomeClass: "compromised"` for
the first holder's attempt even though that attempt may still be
genuinely running (see "Residuals" below). In particular this is not a
gate-safety property (see "Proportionality and the complexity budget" at
the end of this section); it buys a caller a single in-flight handle to
join and saves the machine from running the same expensive verification
twice, in the common case where every holder's heartbeat keeps up.

An in-memory lock cannot provide it. grounding-mcp uses
`StdioServerTransport` (`server.ts`, imported at the top of the file and
instantiated in `main()`): every client registered against it (Claude
Code, Codex, and, if wired, opencode) spawns its OWN, separate
`grounding-mcp` OS process. Those processes share no memory, so an
id-keyed in-memory lock in one process cannot see or coordinate with
another process's in-memory lock for the same `id`. Round 1 of this
document claimed the in-memory lock alone made two preflight processes for
one id structurally impossible; that claim was unsound across processes
and was corrected in round 2.

#### The primitive

Mutual exclusion is DELEGATED to `proper-lockfile` (npm, 4.x), the same
library the harness already uses for cross-process file locking, wrapped
there as `withFileLock` in `harness/src/io/lock.ts`. This document does
not define a lock protocol; it names the primitive, states how this design
calls it, and cites the library's documented semantics for everything
else. The semantics below were read from 4.1.2's `README.md` and
`lib/lockfile.js`:

- Acquisition is a `mkdir` of the lock path, which is the locked file's
  path suffixed with `.lock` (`acquireLock`, `getLockFile`; README,
  "Design"). `mkdir` is the atomicity primitive, chosen by the library
  precisely because `O_EXCL` is unreliable on network filesystems. The
  lock is therefore a DIRECTORY, and it carries no payload: no PID, no
  attempt id, no host name, nothing this design has to parse or validate.
- A lock already held by a live holder fails the acquisition with error
  code `ELOCKED` (`acquireLock`).
- Liveness is an mtime heartbeat, not a process probe: the holder refreshes
  its lock's mtime on an interval (`updateLock`, `update` option,
  defaulting to half the stale window), and any acquirer treats a lock
  whose mtime is older than the stale window as stale (`isLockStale`,
  `stale` option, default 10 s), removes it, and acquires it itself, all
  inside the same `acquireLock` call. Reclaiming a stale lock is therefore
  the library's operation, not this document's.
- Compromise is detected and signalled: if the heartbeat finds the lock
  gone, or keeps failing to refresh it past the stale threshold, or finds
  the lock's mtime is no longer the one it wrote (`isMtimeOurs`, which is
  the library's own ownership check), it marks the lock compromised and
  calls the `onCompromised` callback with an
  `ECOMPROMISED` error (`updateLock`, `setLockAsCompromised`). A refresh
  failure that is neither of those is retried rather than escalated. The
  default callback rethrows; this design supplies its own (below).
- Release checks only this process's OWN in-memory record of holding the
  lock: `unlock` (`lib/lockfile.js`) looks up `locks[file]`, a per-process
  registry keyed by canonical path, never re-reading the lock directory's
  on-disk identity; a path this process's own registry has no entry for
  fails with `ENOTACQUIRED`, and a second release with `ERELEASED`. This
  is NOT the same guarantee as verifying, at release time, that the lock
  directory on disk is still the one this process created. If this
  process's heartbeat is starved long enough (a busy event loop, laptop
  sleep, `SIGSTOP`) that a second acquirer reclaims the lock as stale
  before this process's own heartbeat resumes and marks itself
  compromised, this process's later `release()` call still finds its own
  `locks[file]` entry, still calls through to the library's lock-removal
  path, and removes the SECOND holder's lock directory, not its own
  (reproduced with two real processes for this round; see "Residuals"
  below). "A process never deletes another process's lock" therefore does
  NOT hold unconditionally; it holds only while a holder's own heartbeat
  keeps discovering compromise before that holder releases, which is
  exactly the residual named below.
- On process exit the library removes the locks that process held, EXCEPT
  after `SIGKILL` or a VM fatal error such as out-of-memory (README,
  "Graceful exit"). Those two cases leave a lock behind, and the stale
  window above is what reclaims it.
- The library documents both what it does NOT detect and what it DOES
  detect (README, "Compromised"). NOT detected: a lock directory removed
  by hand, after which someone else acquires the lock; and two callers
  using different `stale`/`update` values for the same path. DETECTED,
  quoted in full: "Updates to the lockfile fail" and "Updates take longer
  than expected, possibly causing the lock to become stale for a certain
  amount of time." That second detected case is exactly the
  starved-heartbeat trigger named above: detection (the heartbeat noticing
  it is compromised) and this process's own release are two separate code
  paths, and the residual below is that release can run to completion
  before detection ever catches up. All four are inherited by this design
  as accepted residuals ("Residuals" below), cited rather than re-derived.

#### Where the lock lives

One lock per sanitized id, next to that id's marker and attempt log under
`verdictDir()` (`packages/grounding-mcp/src/solution-verdict.ts`,
`verdictDir`, `sanitizeVerdictId`). Because the library locks a PATH by
creating `<path>.lock` beside it, the design must say which path it locks:
a per-id ANCHOR FILE, suggested
`path.join(verdictDir(), \`${sanitizeVerdictId(id)}.attempt-lock\`)`,
created empty on first use, whose presence means nothing by itself and
whose contents are never read. The lock the library then manages is that
anchor's `.lock` directory.

Two paths were rejected as the lock target, for reasons worth recording:
the verdict marker itself (`verdictPath(id)`), because `invalidateVerdict`
unlinks it (`solution-verdict.ts`, `invalidateVerdict`), so the locked
path would come and go underneath the lock; and the attempt log
(`<sanitizedId>.attempts.jsonl`), because compaction replaces it via
`fs.rename` (section 6), which swaps the file out from under a
`realpath`-resolved target. An anchor file that nothing else ever unlinks
or renames avoids both. The harness's wrapper already establishes this
exact shape: `ensureLockTarget` in `harness/src/io/lock.ts` creates the
target file if absent and passes `realpath: false`, because the library's
`realpath` option (default true) requires the locked path to exist.

The anchor file's own existence exists for parity with the harness's
`ensureLockTarget` convention and for path stability, not because anything
in this design reads it: nothing ever opens, stats for content, or
branches on the anchor file itself, only on the `.lock` directory the
library manages beside it. Because this design passes `realpath: false`
(matching `ensureLockTarget`), the anchor need not even exist for `lock()`
to succeed; only its PARENT directory (`verdictDir()`) must, since
acquisition is a `mkdir` of `<anchor path>.lock`, not an open of the
anchor itself. Removing the anchor file while a lock is held is therefore
harmless. No code in this design may make any behavior conditional on the
anchor file's own existence; if a future revision wants to store anything
readable, it belongs in the attempt log (section 6), not in this file.

#### Acquisition, and what joining means

- Acquire with NO retries. Every acquisition in this design, whether by
  `solution_evaluate` starting an attempt, by a lookup running the
  liveness check, or by the startup reconciliation pass, uses the
  library's default `retries: 0`. Nothing in this design ever waits on a
  lock.
- Acquisition SUCCEEDS: this process owns the id. It appends the `start`
  record (section 6) and spawns the `preflight` child, in that order, and
  HOLDS the lock for the attempt's whole lifetime, releasing it only as
  step 3 of the terminal write order below. That is what makes `ELOCKED`
  mean "an attempt is live" for everyone else, and it is why the
  heartbeat matters: a run longer than the stale window stays protected
  only because the library keeps refreshing the lock's mtime underneath
  it.
- Acquisition fails with `ELOCKED`: a holder is alive. The caller JOINS.
  It does not wait, does not retry, and never spawns a `preflight`
  process. Joining means answering with the running attempt's `attemptId`,
  read from the attempt log's LATEST `start` record for that sanitized id
  (section 6), together with `status: "running"` and a `pollAfterMs`, so
  the caller has a handle to poll exactly as the holder's own callers do.
- Acquisition fails with `ELOCKED` but the log has no `start` record to
  answer with: the response is `running-unconfirmed` (see "Write order and
  crash windows" below), never a fabricated handle and never a second
  spawn. This covers three real situations, all of which resolve on a
  later poll: the holder acquired the lock and has not appended its
  `start` record yet; the holder is a reconciliation pass rather than an
  attempt (section 6, which is why compaction never takes the lock by
  itself); or the log's newest `start` record already carries an outcome
  record, which likewise means the current holder is not an attempt (an
  abandoned lock after a `SIGKILL`, "Write order and crash windows"
  below). This rule governs `solution_evaluate`'s spawn decision only. A
  `solution_evaluate_status`/`_result` lookup does not need the lock to
  answer a row that already carries an outcome record; it reads the log
  and reports what is there, and consults the lock only for a row that
  still reads `running` (section 6).
- Acquisition fails with any other error: it is surfaced to the caller as
  a failure of that call. An unreadable or unwritable `verdictDir()` is
  not something this design papers over, and it is the same directory the
  marker write already depends on.

#### Compromise

The design supplies an `onCompromised` callback rather than leaving the
library's default (which rethrows into whatever context the heartbeat
timer runs in). A holder whose lock is reported compromised has lost the
right to act on behalf of that id, and behaves accordingly:

1. It records a terminal outcome for its own attempt in the attempt log:
   one `terminal` record with `status: "failed"` and `outcomeClass:
   "compromised"` (section 6, record kind 2). The attempt's fate is
   established and honest: it ran, and it lost its exclusivity before
   finishing.
2. It does NOT write the marker for that attempt. `writeVerdict` is not
   called on behalf of a lock this process no longer holds. The check is a
   flag set by `onCompromised` and read immediately before the
   `writeVerdict` call in the terminal path (see the write order below).
3. It returns an explicit error to its own caller, saying the attempt lost
   its lock and no marker was written. It never returns a `completed`
   result for a compromised attempt.
4. It does not delete any lock. The lock it held is already gone or is now
   someone else's; the library has already marked it released internally
   (`setLockAsCompromised`), and a release call would return `ERELEASED`
   or `ENOTACQUIRED` rather than removing a foreign lock.

This is the honest form of the "ownership-checked release" a previous
round tried to specify by hand (re-reading the lock file's bytes to prove
they were still ours). The library already performs that check on every
heartbeat, using its own mtime rather than file contents, and reports the
answer through `onCompromised`; this design consumes that report instead
of re-implementing it.

One window is disclosed rather than closed: if the compromise
notification arrives AFTER `writeVerdict` has already returned, the marker
is already on disk and step 2 cannot un-write it. The attempt then records
its real terminal outcome, with the lost lock noted in the record's
`summary`. What that costs is bounded by the proportionality argument
below: the worst case is the same one a duplicate run produces, and
`evaluateGate` denies on every one of its outcomes.

#### Release

Release is the library's `release` function returned by its own `lock`
call, called once, in the fixed write order below. It removes only this
process's own lock (`unlock`, `ENOTACQUIRED` / `ERELEASED`), so no rule
about "never release someone else's lock" needs to be enforced by this
design at all.

#### What round 4 removed

Named explicitly, so a future revision does not reintroduce them by
accident: the `.lock.takeover` marker file and its five-step takeover
sequence; the byte-identity re-read of a stale lock; the recursive stale
reclamation; the hand-specified heartbeat and its interval; the lock's own
payload (PID, start time, `attemptId`, hand-rolled host identifier) and
every check that parsed it; and the PID-liveness probe as the authority
for whether an attempt is alive. Each of those
either duplicated something `proper-lockfile` already does, or existed
only to repair a race introduced by the previous item on the list. What
replaces all of them is one call with `retries: 0` and two outcomes,
acquired or `ELOCKED`.

#### Residuals

- A holder whose heartbeat is starved (a busy event loop, laptop sleep,
  `SIGSTOP`) past the `stale` window, while it is still logically running,
  can have its lock reclaimed as stale by a second acquirer before the
  starved holder's own heartbeat resumes and reports itself compromised.
  When the starved holder does resume, its own release call ("Release"
  above) does not re-verify on-disk ownership and removes the SECOND
  holder's lock directory instead of its own (reproduced with two real
  processes for this round). The result is two live `preflight` processes
  for one id, plus a spurious `terminal` record with `outcomeClass:
  "compromised"` for the first holder's attempt even though that attempt
  may still be genuinely running to a correct result of its own. This is
  bounded, not eliminated, by brief 01's `stale: 30_000` choice, whose own
  stated reasoning is to trade reclamation latency against tolerating a
  stalled event loop (brief 01, "Constraints", "Why 30 s"); a larger
  `stale` value narrows the starvation window this residual needs but
  cannot close it, since any finite window admits an arbitrarily long
  stall. `evaluateGate` still fails closed on whatever either attempt's
  marker outcome turns out to be (see "Proportionality and the complexity
  budget" above), which is what keeps this a wasted-run residual rather
  than a gate-safety one.
- `SIGKILL` or a VM fatal error leaves the lock directory behind (README,
  "Graceful exit"). The library's stale window reclaims it on the next
  acquisition attempt. Until then, callers join an attempt that is no
  longer running and see `running` or `running-unconfirmed`; nothing
  spawns a duplicate, and nothing writes a marker.
- A lock removed by hand, or by an unrelated cleanup of `verdictDir()`,
  followed by another acquirer, is not detected by the library and not
  detected here (README, "Compromised"). Two `preflight` processes for one
  id become possible in that case. It is bounded by the proportionality
  argument below, not by a mechanism.
- Mismatched `stale`/`update` values between two processes locking the
  same path are likewise undetected (README, "Compromised"). This design's
  mitigation is that every acquirer is the same code path with the same
  configured values (brief 01); a mixed-version deployment against one
  shared `verdictDir()` violates that assumption, and this document does
  not claim to cover it.
- The `grounding-mcp` process dies after acquiring the lock but before its
  `preflight` child exits. Per the parent-only invocation shape
  established in section 1 (`evaluateSolution` calls `writeVerdict`
  synchronously after its own `execFileAsync` call resolves, in the SAME
  process that spawned the child), no process is left alive that could
  ever call `writeVerdict` for that child's output. The residual is total
  loss, not a race: the orphan's run is wasted, consuming CPU and IO until
  it exits or its broken stdout pipe kills it (platform-dependent,
  unverified here, section 9 blocker 2), and its lock stops being
  refreshed, so the id becomes acquirable again after the stale window.

#### Single-host assumption (closes review round 2 finding L2)

This design's invariant is stated PER HOST: it holds when every
`grounding-mcp` process sharing a given `verdictDir()` (section 1,
`verdictDir`) runs on the same host. The library itself advertises
inter-machine locking on network filesystems (README, "Design"), and its
`mkdir` strategy is chosen for exactly that case, so a cross-host
deployment is not obviously broken; but its staleness test compares a
remote file's mtime against the local clock (`isLockStale`), which makes
the guarantee depend on clock agreement between hosts, and nothing about
a cross-host `verdictDir()` was measured for this document. So the claim
stays scoped to one host, and the previous round's hand-rolled host
identifier inside the lock's payload is dropped rather than reworked:
there is no payload any more, and a home-made host check would have been a
second, weaker copy of a question the library already answers with its own
strategy.

#### Proportionality and the complexity budget

Worth stating plainly, because successive review rounds of this document
went into a lock protocol that was growing faster than the problem it
solved: `evaluateGate` FAILS CLOSED on every outcome a duplicate run can
produce. Its deny branches, in `packages/grounding-mcp/src/solution-verdict.ts`,
function `evaluateGate`, are: no verdict marker readable for the id
(`readVerdict` returns null both when the file is absent and when it is
unparseable, `readVerdict`), the verdict is not `ready`, the current HEAD
cannot be resolved (`currentHead === null`), and the verdict's `head` does
not equal the current HEAD. A duplicated, interleaved, or half-written
marker lands in one of those branches or is a valid marker at the current
HEAD, which is the same answer a single run would have produced.

Therefore the lock buys avoided waste (one `preflight` run instead of two)
and a single in-flight handle callers can join. It does NOT buy gate
safety, and no amount of additional protocol here would, because the gate
does not consult the lock at all. That is this design's complexity budget:
the cited primitive plus the join, compromise and release rules above. A
future revision that finds a new residual should first ask whether the
gate already fails closed on it, and re-inflate the protocol only if the
answer is genuinely no.

#### Forced retry while an attempt is running

`forceNewAttempt: true` is refused (returns an error, starts nothing) when
the acquisition for that `id` comes back `ELOCKED`. This is deliberate:
honoring a forced new attempt against a still-running one would reintroduce
exactly the race PR #211 documents as an accepted, NOT-closed residual:
"Remove the prior marker for an evaluation id. A missing marker is already
invalid. Other I/O errors are surfaced to the caller because an old marker
may still remain usable. This is a sequential guarantee for writable marker
storage; it does not serialize concurrent writers or repair id collisions."
(full comment, `packages/grounding-mcp/src/solution-verdict.ts`, function
`invalidateVerdict`, master `eefd18fe`). The lock in this section closes
the "does not serialize concurrent writers" half of that disclosure for
THIS design's own preflight-spawn race specifically: a genuinely
independent new attempt for the same `id` is created only by a successful
acquisition, so two `preflight` processes racing to invalidate and write
the same marker for the same `id` cannot happen through this contract's
own entry points. The "repair id collisions" half of that same disclosure
remains explicitly out of scope (section 5, "Identifiers", "Keying"); this
design neither introduces nor repairs it. A "cancel the in-flight attempt,
then retry immediately" capability (killing the child process on request)
is a separate capability this document does not design; it is listed as a
dependency in the producer brief (section 10) for whoever wants true
force-retry-while-running later.

### Write order and crash windows (closes review round 2 finding M2)

When an attempt reaches a terminal state, the writes involved happen
in this fixed order, never interleaved or reordered:

0. The compromise flag is read (section 7, "Compromise"). If it is set,
   steps 1 and 2 are replaced by a single `terminal` record with
   `outcomeClass: "compromised"` and an explicit error to the caller, and
   step 3 is skipped (there is no lock left to release).
1. `writeVerdict` (existing code, `solution-verdict.ts`, unchanged by this
   design) persists the signed marker at `verdictPath(id)`, exactly as it
   does today.
2. The attempt log's `terminal` record (section 6) is appended for this
   `attemptId`.
3. The lock for this `id` is released, through the `release` function the
   lock library returned to this process (section 7, "Release").

A crash between any two of these steps is a real, disclosed residual, not
a silently-ignored one:

- Crash between (1) and (2): the marker is written and correct, but the
  attempt log still shows `running`. The lock library's stale window plus
  reconciliation/read-path liveness (section 6) eventually resolves this
  attempt's row to `unknown`, even though its marker was in fact written
  successfully; a caller relying on `solution_evaluate_result` for this
  specific `attemptId` sees `unknown` despite a real, valid marker on
  disk. `solution_gate` itself is unaffected (it reads the marker
  directly, not the attempt log); this attempt's own status lookup alone
  undercounts its own success. Not fully closed by this design; recorded
  here rather than silently assumed away.
- Crash between (2) and (3): the attempt log correctly shows the terminal
  outcome, but the lock is left behind (this is the `SIGKILL`/fatal-error
  case; an ordinary process exit removes it, section 7, "The primitive").
  Until the stale window elapses, an acquisition for that id comes back
  `ELOCKED`. No caller is told a false `running`: a
  `solution_evaluate_status`/`_result` lookup answers from the log, which
  already reads terminal, and a `solution_evaluate` call, which cannot
  acquire and must not serve a prior result in place of a fresh run
  (section 8), returns `running-unconfirmed` with a poll hint. Once the
  stale window elapses, the next acquisition reclaims the lock inside the
  library. This design does not shortcut that window by deleting a lock it
  does not hold, which is exactly the hand-rolled reclamation round 4
  removed.

`running-unconfirmed` is the outcome for an id whose lock cannot be
acquired while its attempt log has no `running` row to name (a crash
between the acquisition and the log's own `start` record, a lock held by
a reconciliation pass, an abandoned lock whose newest attempt already has
an outcome record, or an id whose log file was never created). It is
deliberately distinct from both `running` (this design will not invent an
`attemptId` it cannot read) and `unknown` (nothing has been established
about any attempt's fate). It resolves by itself: either the holder
appends its `start` record and the next poll reads `running` with a real
handle, or the holder was never an attempt and the next poll acquires the
lock, or the lock goes stale and the library reclaims it on the next
acquisition. No separate reclamation path exists for it, and none is
needed. `reconcileOrphanedAttempts()` covers the same shape at startup
(section 6, "Reconciliation"): a lock it can acquire has nothing running
under it, and a lock it cannot acquire is someone else's business.

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
  immediately above for a superseded attempt. No signing key path is
  exposed through any of these tools, today or under this design.
- Persisting the error string DOES widen one thing, and it is the
  durability rather than the content: two of today's error messages carry
  environment-derived text that currently lives only in one response, and
  section 6 writes it to a file that outlives the call. Both are in
  `packages/grounding-mcp/src/solution-verdict.ts`, `evaluateSolution`:
  on `ENOENT` the message embeds the resolved binary name, which is the
  value of `SOLUTION_PREFLIGHT_BIN` whenever that variable is set
  (`preflight binary not found (...)`); and on an invocation failure the
  message is the underlying `execFile` error's own `message`
  (`preflight invocation failed: ...`), which carries the command line
  and can carry captured stderr. Three requirements follow, and they are
  fixed here rather than left to the brief:
  1. The persisted copy is truncated to the record bound in section 6,
     which caps how much of an `execFile` message (stderr included) ever
     reaches disk.
  2. The attempt log file and the per-id lock anchor file (section 7) are
     created with mode `0600`. This is deliberately narrower than the
     verdict marker's own mode, which stays as it is: `writeVerdict`
     calls `fs.writeFileSync` without a `mode` option
     (`solution-verdict.ts`, `writeVerdict`), so the marker inherits the
     process umask default, and the harness reads it back through
     `readVerdict` (`harness/src/policy-packs/builtin/solution-acceptance-runtime.ts`).
     Changing the marker's mode is out of scope for this document; the
     new files this design adds do not inherit that choice by default.
  3. Nothing in the log is treated as sanitized for display. It is
     advisory history, like `diagnostics`, and never gate input.
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
   section 7's lock: if the parent dies while its child preflight
   survives orphaned, the lock stops being refreshed and the next
   acquirer reclaims it once the library's stale window elapses, inside
   the library (section 7, "The primitive"). CORRECTED from a prior round's
   claim (finding M3, review round 2): since `evaluateSolution` calls
   `writeVerdict` only inside the SAME process that spawned the child
   (section 1; section 7, "Residuals"), an orphaned child never
   itself produces a competing marker write for a later attempt's write to
   race against; nothing is ever left alive to make that write on the dead
   parent's behalf. The actual, disclosed residual is total loss, not a
   race: the orphan's run is wasted (its output is unrecoverable once its
   parent is gone) and it consumes CPU/IO until it exits, or until its
   broken stdout pipe kills it first (platform-dependent, still unverified
   here). PR #211's own disclosed "does not serialize concurrent writers"
   residual (quoted in section 7) concerns a DIFFERENT scenario, two LIVE
   processes both calling `invalidateVerdict`/`writeVerdict` for the same
   id at nearly the same time, which this design's lock closes for
   its own entry points (section 7); it is not the same risk as an
   orphaned child, and this document no longer conflates the two. This
   affects both the "restart" and the "two client sessions, same id" rows
   of the acceptance matrix and the recommendation in section 5 not to
   kill child processes on disconnect; if orphaned processes turn out to
   accumulate unbounded even under the stale-window bound, that
   recommendation needs revisiting together with the retention policy in
   section 5. Sizing this blocker against the proportionality fact in
   section 7: an orphaned child cannot produce a marker at all (nothing
   is left alive to call `writeVerdict`), and `evaluateGate` denies on a
   missing, unparseable, not-ready, or HEAD-mismatched marker, so what is
   at stake here is wasted CPU and a temporarily unacquirable id, never a
   gate that opens when it should not.
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
   constant, not a number), the `stale` and `update` values passed to the
   lock library (section 7), the dependency decision that adds that
   library to `@lannguyensi/grounding-mcp`, and the retention/rotation
   numbers for the in-memory registry and the on-disk
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
| Server restart mid-attempt | Old `attemptId` resolves to `unknown` ONLY once startup reconciliation OR a read-path liveness check has acquired that id's lock over a still-`running` row (section 6); a later independent attempt for the same `id` is licensed only by a successful acquisition (blocker 2, section 9, for the orphan-process question), never merely because the reported status reads `unknown` | Producer brief test simulating registry loss plus reconciliation; see brief 01 |
| Holder dies AFTER another process already reconciled a different, earlier attempt for the same id (holder death not caught by the last startup) | A read-path liveness check on the CURRENT lookup (not only the startup pass) acquires that id's lock over the still-`running` row and appends `reconciled-unknown` for THIS attempt, exactly once, independent of when the last restart happened | Producer brief test simulating a second holder death observed only via a live lookup, not startup; see brief 01 |
| Two processes both find the same abandoned lock | Reclamation happens inside `proper-lockfile`'s own acquisition (stale mtime, remove, re-acquire), so exactly one acquisition succeeds and the other gets `ELOCKED` and joins; this design contributes no reclamation code of its own | Library behavior, cited (section 7, "The primitive"); no test of this design's own is owed for it |
| Holder's lock is reported compromised mid-run (`onCompromised`) | The holder writes NO marker for that attempt, records a `terminal` record with `outcomeClass: "compromised"`, and returns an explicit error to its caller | Producer brief compromised-holder test; see brief 01 |
| Lock present, no corresponding attempt-log row (crash between acquisition and the log's own `start` record) | Lookup resolves to `running-unconfirmed`, never `running` forever and never `unknown`; it resolves by itself once the holder appends its `start` record, or once the library reclaims the lock as stale on a later acquisition | Producer brief lock-without-log-row test; see brief 01 |
| `solution_evaluate_result` answered by a process that does not own the attempt in its in-memory registry (cross-process or post-restart), for a completed and for a failed attempt | Response uses the documented reduced shape (`outcomeClass`, `summary`, persisted `error` string for a failure; `verdict`/`markerPath` only when `isLatestForId` and `markerPresent` both hold), never the full same-process `EvaluateResult` shape | Producer brief cross-process payload-shape test (completed and failed); see brief 01 |
| Concurrent starts for the same id, SAME process | Exactly one `preflight` process; the second caller joins and receives the same `attemptId` | Producer brief unit test asserting a single child-process invocation across two concurrent calls; see brief 01 |
| Two client sessions, same id (cross-process) | Exactly one `preflight` process across BOTH processes; the second process's acquisition returns `ELOCKED`, so it joins by answering with the `attemptId` from the log's latest `start` record and never spawns its own child | Producer brief test with two real `grounding-mcp` processes, or one process plus a lock held by the test itself; see brief 01 |
| Retry after a caller's own timeout | If the acquisition returns `ELOCKED`, the retry joins (no duplicate, same `attemptId`); if the acquisition succeeds (prior attempt terminal, or the lock reclaimed as stale by the library), the retry is a genuinely new attempt with its own log entry | Producer brief test covering both sub-cases; see brief 01 |
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
   unsoundness); it was correct in its own
   terms only because it had not yet been checked against the fact that
   grounding-mcp runs one process per client. That design gap is now
   closed by section 7's lock, so the label is re-confirmed here,
   not merely carried forward. Round 4 shrinks this brief rather than
   growing it: the hand-written lock protocol it was to implement is
   replaced by calls into `proper-lockfile`, and the tests for the
   takeover sequence go away with the sequence itself. Two open items
   remain. The first is the orphan
   child-process kill-vs-survive question (blocker 2, section 9), which
   this brief ships against with a documented default (do not kill) and a
   bounded residual (the library's stale window); that item was already
   flagged, unresolved, before this round and stays unresolved, but bounded
   rather than open-ended, after it. The second is new in round 4 and is
   an operator decision rather than a design gap: adding `proper-lockfile`
   as a runtime dependency of `@lannguyensi/grounding-mcp`. The brief
   states the fallback if that is refused (tolerate duplicates and detect
   them through the log alone, accepting the wasted run the
   proportionality argument in section 7 already bounds). Neither item
   blocks starting implementation.
2. `02-client-polling-integration.md`: the harness policy-pack prompt text
   and README updates that teach a solving agent when to poll versus retry,
   plus documentation of the standard-progress ergonomics layer from
   section 3, which has ITSELF now shipped independently of this design
   (PR #212, master `df9722d`, the sibling task `8c9a99fc`'s own scope,
   merged 2026-09-05 20:02:33Z, ahead of and independent from brief 01).
   Status: **split**, RESCOPED this round: section A (documentation) is
   still implementation-ready. Section B is NO LONGER an implementation
   task, because the ergonomics layer this document recommended already
   exists in master; brief 02's section B is rescoped from "implement
   progress pings" to "document what shipped" (README guidance for
   callers, and the per-client value caveats this section and section 2
   already state: Claude Code is measured NOT to extend its deadline on
   these pings, Codex/opencode remain unconfirmed). Brief 02's OWN header,
   as of this round, reflects the rescoping directly rather than carrying
   forward a stale `blocked-on-client-capability-verification`
   implementation label for work that already merged; brief 02's own
   header text is authoritative over this summary paragraph should the two
   ever again appear to diverge.

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
`.d.ts` files cited in `t006-client-capabilities.md`. Section 7's lock
semantics are cited the same way, against the library rather than
re-derived: `proper-lockfile` 4.1.2, `lib/lockfile.js` (`acquireLock`,
`getLockFile`, `isLockStale`, `updateLock`, `setLockAsCompromised`,
`unlock`, `check`) and its `README.md` sections "Design", "Compromised",
"Graceful exit", and the `.lock` option list; plus this org's existing
wrapper, `harness/src/io/lock.ts` (`withFileLock`, `ensureLockTarget`).
Every behavior section 7 attributes to the library is checkable in one of
those, and anything section 7 asserts beyond them is stated as this
design's own rule, not as library behavior. Claims about local
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
