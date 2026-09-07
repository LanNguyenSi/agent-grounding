# grounding-mcp

MCP server that exposes the [agent-grounding](../../) stack, `grounding-wrapper`, `evidence-ledger`, `claim-gate`, `runtime-reality-checker`, as tools a long-running Claude Code session can call directly. Sits between the agent and the framework so a debug task can be framed, tracked, and gated without subprocess plumbing.

## Why

The other packages in this repo are CLI-first. That works fine for scripted invocations but is awkward inside a live Claude Code session: each call is a fresh subprocess, sessions don't survive across turns, and there's no shared evidence ledger between phases. This server keeps a single ledger DB open and persists each grounding session to its own JSON file so the agent can resume across hours and process restarts.

## Tool catalog

| Tool | Wraps | What it does |
|---|---|---|
| `grounding_start` | `grounding-wrapper.initSession` | Open a new session for `(keyword, problem)`. Returns the session id, mandatory tool sequence, and active guardrails. |
| `grounding_advance` | `grounding-wrapper.advancePhase` | Mark current phase done, move to next. |
| `grounding_guardrail_check` | `grounding-wrapper.isGuardrailActive` | Is a specific guardrail active right now? |
| `ledger_add` | `evidence-ledger.addEntry` | Append a fact / hypothesis / rejected / unknown to the session's ledger namespace. |
| `ledger_summary` | `evidence-ledger.getSummary` | Return all entries for a session, grouped by type, with counts. |
| `ledger_status` | `ledger-bridge.ledgerStatus` | No-arg ledger reachability + stats probe (entry count, db path, last-write timestamp) for harness MCP health checks; no session required. |
| `claim_evaluate` | `claim-gate.evaluateClaim` | Run a claim through the gate with caller-supplied context. |
| `claim_evaluate_from_session` | claim-gate + grounding-wrapper + evidence-ledger | Same, but auto-derive the context from the session's phase status + ledger entries. The default path. |
| `solution_evaluate` | `solution-verdict` + `solution-attempt-log` + `preflight` CLI | Run preflight against a repo and record a HEAD-pinned solution-acceptance verdict for an id, derived from preflight's real results. Earn "done" instead of claiming it. Sends `notifications/progress` pings while it runs, if the request carries a progressToken. Waits up to an internal bound and then hands back `{status:"running", attemptId, pollAfterMs}` instead of blocking further. See below. |
| `solution_gate` | `solution-verdict.evaluateGate` | Allowed only if a ready verdict exists at the current git HEAD; else a precise deny reason (no verdict / not ready / HEAD drift). |
| `solution_evaluate_status` | `solution-attempt-log` | Read-only status of a `solution_evaluate` attempt for an id: `running`, `completed`, `failed`, `unknown`, `expired`, or `running-unconfirmed`. Never starts preflight, never blocks. Omit `attemptId` to ask about the latest attempt for that id. |
| `solution_evaluate_result` | `solution-attempt-log` | Read-only outcome of an attempt once it is terminal, `{status:"running"}` while it is not. The process that ran the attempt answers with the full `solution_evaluate` payload, until its own in-memory record of that attempt ages out (the same retention window as the on-disk log); once pruned, even the owning process answers with the reduced, persisted payload, same as any other process. Not gate authority: `solution_gate` still reads only the signed marker. |
| `verify_memory_reference` | `runtime-reality-checker.verifyMemoryReference` | Check whether a memory-referenced path / symbol / flag still exists in the repo. Call before recommending anything from a memory that cites a concrete file, function, or flag. |
| `hypothesis_record` | `hypothesis-tracker.addHypothesis` | Add a competing hypothesis with required checks. Use when you can name more than one possible cause. |
| `hypothesis_list` | `hypothesis-tracker.getSummary` | List all hypotheses for a session plus summary counts. Use before claiming a root cause. |
| `hypothesis_evidence` | `hypothesis-tracker.addEvidence` | Attach evidence to a hypothesis (auto-promotes unverified to supported). |
| `hypothesis_check_done` | `hypothesis-tracker.completeCheck` | Mark a required check as done. |
| `hypothesis_reject` | `hypothesis-tracker.rejectHypothesis` | Reject a hypothesis with a reason, the rejection is appended as an audit entry rather than a silent delete. |
| `hypothesis_support` | `hypothesis-tracker.supportHypothesis` | Explicitly mark a hypothesis as supported. Usually `hypothesis_evidence` is enough. |
| `hypothesis_reset` | (store purge) | Purge all hypotheses for one session. Use before reusing a grounding sessionId for a new debug task so stale hypotheses do not leak in. |

## Storage

| What | Where | Override |
|---|---|---|
| Session JSON | `~/.grounding-mcp/sessions/<id>.json` | `GROUNDING_MCP_SESSIONS_DIR` |
| Evidence ledger | `~/.evidence-ledger/ledger.db` (owned by `evidence-ledger`) | `EVIDENCE_LEDGER_DB` |
| Solution verdicts | `~/.local/state/agent-grounding/solution-verdicts/<id>.json` (`$XDG_STATE_HOME` honored) | `SOLUTION_VERDICT_DIR` |
| Attempt log | `<verdict dir>/<id>.attempts.jsonl`, one append-only JSONL file per sanitized id, mode `0600` | `SOLUTION_VERDICT_DIR` |
| Attempt lock anchor | `<verdict dir>/<id>.attempt-lock`, mode `0600`; the lock itself is the `<id>.attempt-lock.lock` directory `proper-lockfile` manages beside it | `SOLUTION_VERDICT_DIR` |
| Verdict signing key | `$SOLUTION_VERDICT_SIGNING_KEY` (absolute key-file path, projected by harness at apply time) when set; else `<harness-home>/harness.generated/.approval-signing.key` (`<harness-home>` resolves like the harness consumer: `~/.harness` if it exists, else `~/.claude` if it already carries harness state, else `~/.harness` created on first use) | `SOLUTION_VERDICT_SIGNING_KEY`, `HARNESS_HOME` |

A phase that ends up with `'skipped'` status (because no steps mapped to it for the chosen keyword, e.g. a non-service domain skips runtime-inspection) counts as satisfied for `claim_evaluate_from_session`. Otherwise the gate would block forever on prerequisites the agent can't actually complete.

## Solution-acceptance gate

Verifier-gated "done": completion is **earned from a real preflight run, not claimed**. `solution_evaluate` runs `preflight run <repoPath> --json` (the agent-preflight check battery: lint / typecheck / test / audit / secret) and records a verdict marker for an id, pinned to the git HEAD it was produced at. `solution_gate` then allows only when a ready verdict exists at the *current* HEAD.

The verdict marker is the contract a consumer (e.g. harness, gating task-finishing tools) reads:

```json
{ "id": "task-42", "head": "<40-hex sha>", "ready": true, "confidence": 0.9, "blockers": [], "timestamp": "...", "source": "preflight", "alg": "hmac-sha256-v1", "signature": "<64-hex HMAC-SHA256>" }
```

`solution_evaluate`'s MCP response returns the verdict as it looked *before* signing (the 7-key shape above, minus `alg`/`signature`); the on-disk marker file additionally carries `alg` and `signature`, added by `writeVerdict` (see "Verdict marker signing" below) after the response value was already built.

The MCP response also includes advisory `diagnostics` for that same fresh preflight invocation. `diagnostics.payload` preserves the original parsed JSON, including additive fields, while `availability`, `complete`, `execution` (`exitCode`, `signal`, and an optional error), and `issues` explain whether the documented preflight result shape was present. A complete diagnostic requires `ready`, `confidence`, `checks`, `blockers`, `warnings`, `limitations`, `durationMs`, and `timestamp`, with valid nested check fields. It also records execution anomalies such as an unexpected exit code or signal. `complete` does not mean `ready`, sufficient coverage, independently trusted evidence, or cacheability; acknowledged and skipped checks remain visible in the payload.

Verdict production has a smaller mandatory core: the payload must be an object with a boolean `ready`, a finite `confidence` in `[0,1]`, and a string-array `blockers`; a ready result must have no blockers. The only accepted execution pairings are exit `0` with `ready:true` and exit `1` with `ready:false`, with no signal or execution error. Any other exit, signal, invocation error, malformed JSON, or malformed core returns an error and cannot produce a ready verdict. Advisory-field incompleteness stays in diagnostics and does not create another verdict policy.

Diagnostics are response-only: they are neither part of the verdict nor written into, signed in, or consumed from the marker. `solution_evaluate` starts one preflight process only after its id and HEAD checks pass; it does not rerun preflight to produce diagnostics.

When a caller already has complete diagnostics, it may omit a duplicate run only when the repository, working directory, configuration, required coverage, tool, and environment scope are identical and unchanged, and all installed requirements remain honored. This does not authorize caching or reusing diagnostics as evidence.

Anti-hacking contract:

1. **Derived, not claimed**: `ready` comes from preflight's real run; the caller supplies no result.
2. **Producer != solver**: `solution_evaluate` runs preflight; evaluation arguments supply neither check results nor configuration overrides. preflight loads the repository's configured policy, including its clean-state checks.
3. **HEAD-pinned**: a verdict counts only at the HEAD it was produced at; any rework shifts HEAD and invalidates a green verdict.
4. **No stale green**: each valid-id evaluation removes its prior same-id marker before returning an error or writing its new verdict. This is a sequential guarantee when marker storage is writable; a deletion I/O error is returned explicitly and the old marker may remain. It does not serialize concurrent writers or repair id collisions.

The marker lives outside the agent-writable evidence-ledger on purpose (a ledger row is forgeable via `ledger_add`). Requirements / knobs: the `preflight` binary on `PATH` (override with `SOLUTION_PREFLIGHT_BIN`). For writable marker storage, a failed valid-id evaluation removes its earlier same-id marker before returning an error; if deletion fails, the error says the old marker may remain.

### Verdict marker signing (0.8.0)

Since 0.8.0, `writeVerdict` signs the marker unconditionally (HMAC-SHA256, no unsigned fallback) before writing it: `alg` is the versioned tag `hmac-sha256-v1`, and `signature` is computed over the marker's fields with the key at the path `SOLUTION_VERDICT_SIGNING_KEY` points to (projected by harness at apply time; primary since 0.8.0), else at `<harness-home>/harness.generated/.approval-signing.key` (see Storage above; the key is created on first use if absent, at whichever path is in effect). A signature-checking consumer (e.g. harness) rejects a naive hand-typed JSON file, one with no `alg`/`signature` at all or a wrong signature, as forged.

This closes casual/accidental forgery, and it closes silent tampering: mutating any signed field after signing (intentionally or by a bug) invalidates the signature and is rejected. It does **not** close a shell-capable, same-UID forger: the signing key is read (and, on a fresh machine, first created) under the SAME UID that runs `grounding-mcp` and the same UID a shell-capable agent runs under, so such an agent could still read that key and compute a valid signature itself, exactly the same same-UID threat model the harness consumer's own signing already documents. This is pragmatic defense-in-depth, not a new authorization boundary. Composing additional ground-truth (CI, review, unresolved hypotheses from the session) into the verdict is the next layer.

The verdict pins to the committed HEAD, so edits made after a green `solution_evaluate` do not shift HEAD: re-run it after any change. preflight's own clean-worktree check fails a dirty tree, so a fresh `solution_evaluate` on uncommitted work yields a not-ready verdict.

### Progress notifications while `solution_evaluate` runs

`solution_evaluate` runs one real preflight invocation in-band with the request (awaited, not backgrounded: lint / typecheck / test / audit / secret detection against the target repo), which can easily take longer than the MCP SDK's default 60s request timeout. While that invocation is pending, the tool sends a `notifications/progress` ping roughly every 10s (mirrors agent-preflight's own `preflight_run`/`preflight_batch` convention) — but **only** when your client attaches a `progressToken` to the request; passing an `onprogress` callback (e.g. `client.callTool(..., { onprogress })` in the TypeScript SDK) does that automatically. Each ping's `progress` is a plain monotonically increasing tick count meaning "still running" — never a fabricated percentage, and never a signal about any check's outcome.

Attaching `onprogress` alone only gets you the pings. For the heartbeat to actually help a slow run survive, your client also needs to **reset (or otherwise extend) its own request timeout on progress** — pass `resetTimeoutOnProgress: true` in the same call's request options (TypeScript SDK), or raise the request's own `timeout` outright. Without one of those two, the pings arrive but the client's timeout still fires on schedule regardless.

What this heartbeat does **not** fix, and does not claim to fix:

- A client-side hard total deadline (the SDK's own `maxTotalTimeout`, or an equivalent enforced elsewhere) is not extended by progress at all, by design — it is a ceiling, not a soft timeout.
- A client that drops the connection, or otherwise never sees the ping, gets no benefit; a disconnect mid-run is not repaired by this feature.
- Some clients treat their tool timeout as a hard limit that progress does not extend, regardless of `resetTimeoutOnProgress` on the underlying MCP request. This heartbeat cannot repair that: it is scoped to the MCP request/response layer this server controls, not every host's own tool-call timeout policy layered on top of it.
- None of this changes what "done" means: a slow but eventually-`ready` verdict is exactly as durable, and exactly as re-runnable after HEAD moves, as a fast one. The heartbeat only helps a well-behaved, progress-aware client avoid abandoning the call before that verdict comes back — it does not make a timed-out call's result durable, and it does not retry or resume one on your behalf.

### Attempt lifecycle: when to poll, and when to retry

A `preflight` run can outlive the deadline of the call that started it. Since the attempt lifecycle landed, `solution_evaluate` waits only up to an internal bound and then hands back a handle instead of blocking further:

```json
{ "status": "running", "attemptId": "<server-generated uuid>", "id": "task-42", "pollAfterMs": 5000 }
```

The `preflight` process keeps running to completion in the background; only that one request stopped waiting. When the run finishes inside the bound, the response is exactly today's `solution_evaluate` payload plus `status` (`completed` or `failed`) and `attemptId`, which an existing caller can ignore.

**The bound is 45 seconds by default and it is configurable.** The governing deadline is your CLIENT's own per-call wall-clock limit, not a constant this server can know: the MCP SDK's 60s default request timeout is one such limit, but a host may enforce a shorter one that progress notifications do not extend. 45s keeps a deliberate margin under that SDK default while leaving room for a slower client wall; lower it (`createServer({ attemptWaitBoundMs })`) if the client in use cuts calls earlier.

**Polling.** Ask `solution_evaluate_status` or `solution_evaluate_result` with the SAME `id` you evaluated. Pass the `attemptId` you were given, or omit it to resolve the latest attempt for that id, which is the recovery path when your own call timed out before it ever returned a handle. Wait `pollAfterMs` between polls. Both tools are read-only: neither ever starts a `preflight` process.

**Ids too long to use.** All three tools, `solution_evaluate` included, bound `id` at 200 characters: the same bound is enforced on all three tools up front, in each tool's own schema and, belt and braces, again at the registry's own entry point so a library caller that bypasses the MCP schema still gets refused before any filesystem call. 200 is what a verdict id has to fit into, since every id becomes a file name (marker, attempt log, lock anchor, compaction temp file) inside the verdict dir, and the longest of those names runs about 48 characters past the id itself. An id over the bound is a schema rejection on every tool, not a payload. An id that passes the bound but is still unusable, `..` for instance, comes back as `{"status":"unknown","id":"..","error":"..."}` on the two lookups (and as the ordinary `{status:"failed", error}` payload from `solution_evaluate`) rather than as a tool error: `unknown`/`failed` is the honest answer (no attempt could be identified, and none was recorded). An id is never a path: `sanitizeVerdictId` reduces it to one safe segment first, so `../../etc/passwd` is simply an id that nothing ever ran.

**Never re-call `solution_evaluate` as a stall workaround.** A second call for an id whose attempt is still live joins that attempt and returns its `attemptId`; it does not start a second `preflight` run, in this process or in another one. `forceNewAttempt: true` is refused while an attempt is live (`{status:"refused", error}`) rather than honored, because honoring it would put two runs on the same marker. A genuinely new attempt becomes possible only once the previous one is terminal and the id's lock is free again, at which point an ordinary `solution_evaluate` call starts one with a new `attemptId`.

| Status | Meaning | What to do |
| --- | --- | --- |
| `running` | An attempt is live and named by `attemptId`. | Keep polling after `pollAfterMs`. |
| `running-unconfirmed` | The id's lock is held but no attempt row names it yet (a holder that has not written its start record, a reconciliation pass, or a lock left behind by a killed process). | Keep polling. It resolves by itself, either into `running` or once the lock library reclaims the lock as stale. It is neither an error nor a licence to retry. |
| `completed` / `failed` | Terminal. `failed` covers every error path `solution_evaluate` already had, plus an attempt whose holder lost its lock (`outcomeClass: "compromised"`, no marker written). | Read the result; re-run only after fixing something. |
| `unknown` | The attempt's fate was never established: its row still read `running` when a liveness check found the id's lock free. Never upgraded to a success afterwards. | Start a fresh attempt. The `unknown` status alone does not license one; the lock does. |
| `expired` | The attempt finished, and its detail has since been pruned by the retention window. | Start a fresh attempt if you still need a verdict. |

**What the lock does and does not buy.** Mutual exclusion is delegated to `proper-lockfile`, acquired with no retries against a per-id anchor file next to the marker. Acquired means this process runs the attempt; `ELOCKED` means a holder is alive, so the caller joins instead of spawning. The invariant is scoped: at most one live `preflight` process per sanitized id per HOST while each holder's heartbeat keeps its lock fresh. It buys avoided waste and one in-flight handle to join. It does NOT buy gate safety, and it is not needed for it: `solution_gate` fails closed on a missing, unparseable, not-ready, or HEAD-mismatched marker, which is where every duplicate-run outcome lands.

**Retention.** An attempt's records are compacted into a small tombstone once they are older than the retention window (24h by default, and always at least 100x the advertised `pollAfterMs`, so a caller polling at the advertised cadence can never have its target pruned between two polls). A pruned terminal attempt reads `expired`; a pruned `unknown` attempt keeps reading `unknown`, because pruning must never launder an unestablished fate into an established one.

### Orchestrator-workflow (OW) process-completeness arm

Beyond preflight's technical checks, `solution_evaluate` also folds in **OW process-completeness**: it reads the repo's active OW run and requires the handoff to be accepted, the review to recommend accept, and no unresolved high/critical findings. This flows into the **same** verdict fields, `ready` and `blockers` (each OW blocker is prefixed `orchestrator-workflow: `), so the OW arm adds no verdict field of its own. `ready` is true only when **both** preflight is ready **and** there are no OW blockers.

**Active-run resolution is pointer-first.** The worktree root (found by walking up from the repo path for the nearest `.git` entry) may carry a `.ai/run` file — plain text, first non-empty line is the absolute path of the run directory OW is actively working. An optional second pointer line (for example `base=<sha>`) is ignored; the named run directory's own `00-goal.md`/`06-handoff.md`/`05-review-findings.md` files are the source of truth, never the pointer file itself. When present, that pointer **wins outright** over the newest-run scan of `<repoPath>/.ai/runs/`: a run is session-shaped (the worktree the agent is sitting in), while the newest-by-date scan is only a best-effort proxy, and the scan is consulted only when no `.ai/run` file exists at all. A pointer file that exists but does not resolve (unreadable, empty, a relative path, or a target that is missing / not a directory / not a dated run directory) is a **distinct fail-closed blocker** — it never silently falls back to the scan, since a broken pointer left behind is itself a signal something is wrong. A symlinked pointer target is resolved to its real directory before those checks run, and the worktree root itself is found by the presence of any `.git` entry, including a dangling symlink. `.ai/run` is written by the orchestrator-workflow kit at run creation, alongside `.ai/runs/`, and should be gitignored the same way.

The active run must also **claim the current change** (0.6.0): a run whose `00-goal.md` carries a `<!-- solution-acceptance: run-base = <sha> -->` marker (the repo HEAD at run creation) binds precisely — the recorded base must resolve, be an ancestor of the current HEAD, and not lie behind the fork point of the current change (merge-base with the remote default branch). The marker may also be **keyed per repo**, `<!-- solution-acceptance: run-base[<repo-basename>] = <sha> -->`, since a monorepo/fleet run can bind more than one repo. Keyed markers follow a **grammar**, not a single regex: a well-formed keyed marker must be a WHOLE LINE (leading/trailing whitespace only) matching that exact HTML-comment shape. The strict shape is exact — lowercase `solution-acceptance:` and `run-base`, no whitespace before the colon, exactly two dashes in the comment opener — the same exactness the legacy unkeyed matcher already demands. The separate loose net that decides whether a line was an *attempt* at a keyed marker is deliberately more tolerant: case-insensitive (`RUN-BASE[`), whitespace allowed around the colon (`solution-acceptance : run-base[`) and before the bracket (`run-base [alpha]`), one or more dashes in the comment opener (`<!--- `). A line the loose net catches but the strict shape rejects is **malformed** and is collected as its own explicit blocker instead of silently degrading to the legacy date heuristic. A strict match whose key is itself a placeholder (`<repo-basename>`-style, angle brackets around the whole key) is a documentation example, not a marker, and is ignored entirely — not counted as present, not malformed; an example that itself deviates from the strict shape (case, colon spacing, comment opener) is an attempt like any other and blocks as malformed. Both nets stay anchored at the LINE START and require the literal tokens `solution-acceptance`, a colon and `run-base[`; that anchoring and exactness widen the strict shape's own tokens (case, spacing, dash count), not the line position. A THIRD, position-independent check closes the line-position residual: **any line anywhere in the file** (a list bullet (`- <!-- ... -->`), a marker embedded in prose, a bare `run-base[alpha] = <sha>` with no comment wrapper, an attempt preceded by leading text, or a whole-line comment deviating in those tokens, the colon omitted) that names BOTH exact, case-sensitive tokens `solution-acceptance` and `run-base` is also collected as **malformed**, unless it is already accepted as a well-formed keyed or unkeyed marker. The rationale: an attempted-but-unreadable marker is worse than no marker at all, so it must block rather than fall through silently. **Quotation exemption is a heuristic, not a CommonMark parser:** a phrase occurrence that is entirely inside a single-backtick inline code span (the span may cross one or more consecutive non-blank line breaks, but never a blank line, a code span cannot contain a paragraph break) or entirely inside a fenced code block (a fence closes only on a later line whose delimiter is the same character and at least as long as the opener's; an opener with no matching closer fences nothing, fail-closed; a blockquoted fence's `> ` prefix is not recognised as a fence at all) reads as a quotation of the marker syntax, not an attempted marker, and does not trip this check. Only this third, phrase-level net is quoting-aware; this is a deliberate asymmetry: a genuine keyed-attempt at the line start, well-formed or malformed, is read or blocked inside a fence exactly as outside it. A phrase occurrence that survives quoting removal, including a second, unquoted mention on a line that also carries a code span, still blocks. A purely quoted unkeyed marker that is the only occurrence of the marker tokens in the file is still resolved by the legacy substring matcher (`matchMarker`), which is not quote-aware at all; that is an accepted residual. A well-formed legacy unkeyed marker line is explicitly exempt from this check: exemption tracks what the legacy resolver actually reads a value from (a line starting with the HTML comment opener, `solution-acceptance:`, `run-base`, `=`, and a non-whitespace value, whatever follows on the line, an unkeyed marker whose value is followed by a trailing annotation included), not a stricter whole-line-only shape, so an ordinary unkeyed marker that resolves a value is never ALSO reported malformed for it, and is never misread as an attempted-but-broken keyed one merely for naming both tokens. Anchored by a corpus measurement, see CHANGELOG [Unreleased]. A malformed line reports one of two distinct reasons: a keyed-shape attempt (`run-base[` at the line start) keeps the keyed-grammar hint; a bare phrase mention (prose, a quoted marker, a bullet-wrapped attempt) gets a different message naming the tokens found, so it does not point an operator at bracket syntax they never attempted. A well-formed marker (keyed or unkeyed) that still carries the `TODO` placeholder stays fail-open, per the orchestrator-workflow kit's own documented contract. With NO UNQUOTED line anywhere naming both marker tokens, the run stays truly **markerless** and falls through to the legacy date heuristic below (fail-open by design, the kit's documented markerless path). Resolution of well-formed keyed markers tries the worktree's own basename first, then — for a linked git worktree — the main repository's basename (resolved via the worktree's `.git` `gitdir:` file), matching each candidate key against the recorded keys case-insensitively, and the first key whose well-formed keyed marker is present decides, without falling through to a later key or to the legacy unkeyed marker. A keyed marker that IS selected but still carries the `TODO` placeholder resolves to absent (the legacy heuristic path below) exactly like an unkeyed `TODO` marker — it does not fall through to a later key or to the unkeyed marker either. Only when no well-formed keyed marker matches any candidate key does the unkeyed marker apply; when keyed markers exist but none matches any candidate key and no unkeyed marker exists either, the reader itself blocks with an explicit reason naming the keys found and the keys tried (each bounded — keys truncated to 64 chars / 10 shown, malformed-line excerpts truncated to 80 chars with up to 5 excerpts shown per reason category — so a goal file with many or very long keys cannot blow up the message), and the binding check below skips its date heuristic for that case — one blocker, never two, and never a silent fall-through to the date heuristic. The same skip applies when malformed marker lines were found and nothing else resolved a value (`malformed` takes priority over the unmatched-keyed case); when a malformed line coexists with a value that WAS selected, that value is still used, but the malformed blocker is reported alongside it, so the run is still incomplete. Documented asymmetry: the legacy unkeyed `run-base` marker is matched as a substring anywhere in the file (not line-anchored) and resolves values exactly as before; only the keyed grammar itself was hardened; a well-formed unkeyed marker line is exempt from the phrase check above. A legacy run without any applicable marker (or with one still carrying `TODO`) is downgraded tolerantly to a day-granular date check: it blocks only when the run dir's date prefix is older than the author date of the first commit of the current change. Either way a stale accepted run can no longer keep the gate green for later, unrelated work; the fail directions and residuals (same-day staleness for legacy runs, no fork-point check without a remote, deliberate false-block when evaluating at an already-pushed default-branch tip — the gate is pre-merge by design) are documented on `owBindingBlockers` in `src/solution-verdict.ts`. The `run-base` marker (keyed and unkeyed) is written by the orchestrator-workflow kit; markerless runs stay on the heuristic path.

Knob, `<repoPath>/.ai/solution-acceptance.json`:

```json
{ "orchestratorWorkflow": "auto" }
```

| Value | Behavior |
| --- | --- |
| `auto` (default) | Gate on OW completeness only when an active run is found (via the pointer or the scan); a repo with no run is unaffected. |
| `on` | As `auto`, and additionally block when no active run is found at all — no `.ai/run` pointer and no `.ai/runs/` run directory. |
| `off` | Never gate on OW; preflight alone decides. |

Fail-SAFE: a missing, unreadable, unparseable, or invalid config resolves to `auto` (never silently `off`), so a malformed file cannot disable the gate. A repo with no active run under the default `auto` knob produces a verdict byte-identical to the pre-OW output.

## Install + register

```bash
npm install -g @lannguyensi/grounding-mcp
```

Then add to your Claude Code `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "grounding": {
      "command": "grounding-mcp"
    }
  }
}
```

You can also invoke it without a global install via `npx`:

```json
{
  "mcpServers": {
    "grounding": {
      "command": "npx",
      "args": ["-y", "@lannguyensi/grounding-mcp"]
    }
  }
}
```

After restart, the tools appear as `mcp__grounding__grounding_start`, etc.

## Round-trip example

```jsonc
// 1. Start a session — pick a keyword that matches your domain
mcp__grounding__grounding_start({
  keyword: "deploy-panel",
  problem: "frontend went 502 after the last release"
})
// → { sessionId: "gs-deploy-panel-l7k...", currentPhase: "scope-resolution", ... }

// 2. As you investigate, log evidence
mcp__grounding__ledger_add({
  sessionId: "gs-deploy-panel-l7k...",
  type: "fact",
  content: "nginx error log shows upstream timeout from backend container",
  source: "/var/log/nginx/error.log",
  confidence: "high"
})

// 3. Reject the alternatives you ruled out
mcp__grounding__ledger_add({
  sessionId: "gs-deploy-panel-l7k...",
  type: "rejected",
  content: "DNS misconfiguration [rejected: dig resolves correctly from host]"
})

// 4. Advance through phases as you complete them
mcp__grounding__grounding_advance({ sessionId: "..." })

// 5. Before stating a root cause, gate the claim
mcp__grounding__claim_evaluate_from_session({
  sessionId: "gs-deploy-panel-l7k...",
  claim: "the root cause is the backend container's missing OPENAI_API_KEY env var"
})
// → { allowed: true, score: 100, ... } — safe to surface
//   or { allowed: false, next_steps: [...] } — go finish the listed checks first
```

## Hypothesis tracking

The `hypothesis_*` verbs wrap `hypothesis-tracker` so you can keep competing causes alive during a debug session and force explicit rejection instead of silent substitution. State is cached in-memory per server process (sessionId-namespaced) and persisted to disk under `~/.grounding-mcp/hypotheses/<sessionId>.json` (override with `GROUNDING_MCP_HYPOTHESES_DIR`), at parity with the grounding session and the evidence ledger, so it survives a grounding-mcp restart.

**Hypothesis lifetime:** a session's hypotheses live until `hypothesis_reset` purges them (in-memory and on disk) for that sessionId, or until LRU eviction when more than `GROUNDING_HYPOTHESIS_MAX_SESSIONS` (default 200) distinct sessions have been active in the same process — eviction only drops the in-process cache entry, the on-disk file is re-hydrated on the next access. Use `hypothesis_reset` at the start of a new debug task that reuses an existing sessionId to avoid leaking stale hypotheses into the fresh investigation.

```jsonc
// 1. Record both possible causes early
mcp__grounding__hypothesis_record({
  sessionId: "gs-deploy-panel-l7k...",
  text: "DNS resolution is failing",
  requiredChecks: ["Run dig from container", "Check /etc/resolv.conf"]
})
// → { hypothesis: { id: "abc123", status: "unverified", ... } }

mcp__grounding__hypothesis_record({
  sessionId: "gs-deploy-panel-l7k...",
  text: "Firewall blocks port 443"
})

// 2. Attach what you actually observed
mcp__grounding__hypothesis_evidence({
  sessionId: "gs-deploy-panel-l7k...",
  hypothesisId: "abc123",
  evidence: "dig example.com inside container returns NXDOMAIN",
  source: "docker exec api dig example.com"
})
// → hypothesis flips unverified → supported

// 3. Reject the one that didn't survive contact with evidence
mcp__grounding__hypothesis_reject({
  sessionId: "gs-deploy-panel-l7k...",
  hypothesisId: "def456",
  reason: "iptables -L shows ACCEPT on 443 from container subnet"
})

// 4. Take stock before claiming
mcp__grounding__hypothesis_list({ sessionId: "gs-deploy-panel-l7k..." })
// → { summary: { total: 2, supported: 1, rejected: 1, ... }, hypotheses: [...] }
```

The store has no automatic claim-gate hook, the workflow is "use this before reaching for `claim_evaluate_from_session`", not "this gates the gate". If the value of an automatic hook becomes apparent through use, that's a follow-up.

## Trust model

This server is meant to run on the agent's local machine via stdio. There's no auth, no rate limiting, no input sanitization beyond what zod's schema validation gives. The evidence-ledger is shared with any other tool that opens `~/.evidence-ledger/ledger.db`, be aware that other CLIs (`ledger`, etc.) can read and write the same data.

## Grounding receipt codec

The package also contains an unregistered `grounding-receipt/v1` library
primitive and a versioned conformance corpus. It serializes a strict,
Ed25519-signed documentary assessment and accepts only explicit key objects;
it does not load keys, inspect sessions, or grant any task or claim action.
Its assessment provenance is always `agent_asserted`. See the [receipt contract
document](../../docs/okf/grounding-receipt-contract.md) for the signature,
policy-digest, and consumer-boundary details.

The [vendored repository contract](contracts/grounding-receipt-v1/README.md)
defines every field and nested schema, canonical payload order, exact Ed25519
signature input, inclusive 32 KiB wire / 16 KiB payload limits, and stable
`invalid`, `unsupported`, `untrusted` errors. Its manifest pins immutable pass,
fail, negative and boundary bytes plus declarative policy vectors. The public
`00..1f` test seed is deliberately unsafe. The corpus and codec add no npm
exports or runtime endpoint. Verifying a correctly signed fail receipt succeeds;
context binding, clocks, issuer admission and task decisions require a separate
consumer, and dossier assessment requires a separate producer evaluator.

## Development

```bash
# Build
npm run build --workspace @lannguyensi/grounding-mcp

# Run tests (uses temp ledger.db + temp sessions dir, never touches real ones)
npm test --workspace @lannguyensi/grounding-mcp

# Run the server in dev mode
npm run dev --workspace @lannguyensi/grounding-mcp
```

When changing tool descriptions, restart Claude Code, MCP tool catalogs are cached at session start.

### Adding a new verb? Mirror the test pattern.

Two test files cover the verb surface and they catch different bugs, so a new verb usually needs an entry in both:

- `tests/hypothesis.test.ts` (or sibling `*.test.ts`) drives the library + in-process store directly. Fast, covers happy paths and library invariants.
- `tests/hypothesis-mcp-roundtrip.test.ts` drives the same verbs through a real `Client` + `InMemoryTransport` pair against `createServer()`. It is the only place that exercises representative wrapper-only error branches (`no_store_for_session`, `hypothesis_not_found`, `check_index_out_of_range`, `hypothesis_not_found_or_rejected`) and the zod schema bounds (`.min(1)`, `.max(4096)`) end-to-end. Wrapper branches that exist only in `server.ts` are invisible to a library-level test. Sibling permutations of the same error code across other verbs are intentionally not duplicated, the goal is one assertion per distinct branch, not full matrix coverage.

If a new verb introduces a structured error payload that does not exist in the underlying library (most verbs that have one do), add a roundtrip case that asserts the exact `{ error: '<code>', ... }` shape, not just `isError`.
