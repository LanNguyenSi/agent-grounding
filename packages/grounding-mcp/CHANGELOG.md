# Changelog

## 0.6.0, 2026-07-02

### Added

- **OW run-to-change binding (staleness fail-open fix).** A process-complete OW run now also has to CLAIM the current change; before, the newest `.ai/runs/` dir was judged with no linkage to HEAD/branch/date, so one old accepted run kept the gate green for every later change in the repo.
  - **Marker path (new kit):** `00-goal.md` may carry `<!-- solution-acceptance: run-base = <sha> -->` (the repo HEAD recorded at run creation). The arm blocks when the recorded base does not resolve to a commit, is not an ancestor of the current HEAD, or lies strictly behind the fork point of the current change (merge-base of HEAD with the remote default branch). Marker values are validated as 7-40 hex before any git call (argv-injection guard). Without a resolvable remote default ref the fork-point check is skipped (documented residual for local-only linear history).
  - **Legacy runs without the marker (tolerant downgrade, decided fail direction):** day-granular date heuristic — blocks only when the run dir's `YYYY-MM-DD` prefix is strictly older than the author date of the oldest commit since the fork point (fallback: HEAD's author date). A same-day stale run passes (documented residual); a multi-day run does not false-block because it is compared against the FIRST commit of the change.
  - All binding state flows through the existing `blockers[]` strings (prefix `orchestrator-workflow: `); the verdict marker keeps its pinned 7-key shape.
  - `readOwRunCompleteness` now also returns `runName` and the raw `runBase` marker value; `owBlockersFor` is async.
  - **Marker producer status:** the orchestrator-workflow kit (agent-dx) does not emit the `run-base` marker yet — sibling task `ow-review-2026-07-01/run-binding-kit` adds it to the `00-goal.md` template. Until that kit version ships, every run takes the legacy heuristic path; this is the tolerant-by-design rollout order (reader first).
  - **Pre-merge by design:** evaluating at an already-pushed default-branch tip (fork point == HEAD) false-blocks on both paths; deliberate fail-closed direction, pinned by a test. Evaluate before pushing (the normal ship-flow order) or start a new run.

### Fixed

- **OW reader parser robustness bundle** (same unreleased 0.6.0, review finding 4 of 4):
  - A marker still carrying the template's `TODO` placeholder now blocks with its own reason ("marker is still TODO, replace it with the chosen enum value") instead of the misleading "no solution-acceptance marker" message, and still never falls back to prose.
  - Acceptance-marker values capture only the word-shaped enum charset, so sloppy spacing (`= accepted-->`) resolves to `accepted` instead of blocking on `accepted-->`. The `run-base` binding marker keeps its raw capture (shas may start with digits; malformed values must reach the hex guard and block explicitly).
  - ALL findings tables are parsed, not just the first: a second review round appending its own table no longer hides new high/critical findings (fail-open closed).
  - A findings section with content but no findings table anywhere now yields an explicit "not in the expected table format" blocker instead of silently reporting zero findings (fail-closed on format drift). All findings-style headings are scanned; multi-line HTML comments do not count as content.
  - A PRESENT acceptance marker whose value is not word-shaped (e.g. `= 1accepted`) now blocks as malformed instead of falling back to prose — a broken machine channel must never be overridden by a filled prose line.
  - **Adoption note:** the format blocker anchors on the `Severity` + `Decision` header from the shipped review template. Review files written with a Decision-less convention (e.g. `| Severity | Finding | Resolution |`, seen in live runs) will surface the blocker until they converge on the template header; the merge gate consuming this verdict is advisory.

### Changed

- `hypothesis_support` now returns `error: "hypothesis_not_found_rejected_or_checks_pending"` (was `hypothesis_not_found_or_rejected`) to reflect the hypothesis-tracker change that refuses to confirm a hypothesis while its declared `required_checks` are still pending (audit finding M7).
- Re-pinned the lockstep dependencies (`claim-gate`, `evidence-ledger`, `grounding-wrapper`, `hypothesis-tracker`) to `0.5.0` (the release that actually ships the M7 gating and the evidence-ledger WAL/perms hardening).

## 0.5.0, 2026-06-22

### Added

- **Orchestrator-workflow (OW) process-completeness arm in `solution_evaluate`.** The producer now folds `readOwRunCompleteness(repoPath)` (handoff accepted, review recommends accept, no unresolved high/critical findings) into the verdict's `ready` and `blockers`. OW state flows ONLY through those two existing fields, so the verdict marker keeps its pinned 7-key shape (`id`, `head`, `ready`, `confidence`, `blockers`, `timestamp`, `source`) and consumers need no change. Each OW blocker is prefixed `orchestrator-workflow: ` so a deny reason names the arm.
  - **Knob** `<repoPath>/.ai/solution-acceptance.json` `{ "orchestratorWorkflow": "auto" | "on" | "off" }` (new `resolveOwKnob` helper). `off` never gates on OW; `auto` (default) gates only when a `.ai/runs/` run is present; `on` additionally blocks when enforcement is requested but no run exists. Fail-SAFE: a missing, unreadable, unparseable, or invalid config resolves to `auto` (never silently `off`).
  - **Backward-compatible:** for a repo with no `.ai/runs/` under the default `auto` knob the produced verdict is byte-identical to the pre-OW output (preflight still solely decides `ready`/`blockers`).

## 0.4.0, 2026-06-16

### Added

- **`hypothesis_reset` verb and a bounded LRU hypothesis store** (#113). A new MCP verb clears the recorded hypotheses for a session, and the in-memory hypothesis store is now a bounded LRU so a long-lived server cannot grow it without limit.

### Changed

- Re-pinned the lockstep dependencies (`claim-gate`, `evidence-ledger`, `grounding-wrapper`, `hypothesis-tracker`) to `0.4.0` and `runtime-reality-checker` to `0.3.0` to track the coordinated 0.4.0 release.

## 0.3.3, 2026-06-09

### Fixed

- **Security (HIGH): session id path traversal in the read verbs** (#102). `grounding_advance`, `grounding_guardrail_check`, and `claim_evaluate_from_session` passed a client-controlled `sessionId` straight into `loadSession` / `sessionExists`, which built the path via `join(sessionsRoot(), `${id}.json`)` with no sanitisation, so a client could send `sessionId` `"../../../../etc/hostname"` to read or probe arbitrary `<path>.json` files outside the sessions root. A new `sanitizeSessionId()` (mirroring `sanitizeVerdictId()`: collapse non `[A-Za-z0-9._-]` to `_`, `path.basename`, reject `""` / `"."` / `".."`) is now called inside `pathFor()`, so `loadSession`, `saveSession`, and `sessionExists` all inherit the guard. Server-generated ids (`gs-<slug>-<base36>`) use only safe characters, so legitimate sessions are unaffected.

## 0.3.2, 2026-05-30

### Added

- Solution-acceptance gate (#100): two MCP tools that make "done" earned
  from a real preflight run rather than claimed.
  - `solution_evaluate`: runs `preflight run <repoPath> --json` (the
    agent-preflight lint / typecheck / test / audit / secret battery),
    derives a verdict from its real results, and records a HEAD-pinned
    verdict marker for an id. The check set comes from the repo's
    committed `.preflight.json`, not from caller input, so an agent
    cannot weaken the gate at call time (producer != solver). Fails
    closed (writes no marker) when the `preflight` binary is unavailable;
    override its path with `SOLUTION_PREFLIGHT_BIN`.
  - `solution_gate`: read-only check that allows only when a ready
    verdict exists at the current git HEAD, else returns a precise deny
    reason (no verdict / not ready + blockers / HEAD drift / unresolvable
    HEAD).
  - Verdict markers live outside the agent-writable evidence-ledger at
    `~/.local/state/agent-grounding/solution-verdicts/<id>.json`
    (`$XDG_STATE_HOME` honored, `SOLUTION_VERDICT_DIR` overrides). The
    HEAD pin invalidates a green verdict on any rework; a not-ready run
    overwrites a prior green marker.
  - Documented residual: a shell-capable agent could still hand-write the
    marker file; closing that (a harness-owned dir checked by a PreToolUse
    write-guard, then signing) is the harness wiring follow-up
    (harness task `cc43c7a4`).

## 0.3.0, 2026-05-26

### Added

- `hypothesis_*` MCP tool surface wrapping `@lannguyensi/hypothesis-tracker`:
  `hypothesis_record`, `hypothesis_list`, `hypothesis_evidence`,
  `hypothesis_check_done`, `hypothesis_reject`, `hypothesis_support`.
  In-memory store namespaced by sessionId (one Map per server process;
  persistence intentionally out of scope, the ledger is the durable record).
  Closes Phase 1 Schritt 2 of the agent-grounding phase plan, the tracker
  was previously library-only and never exercised against real sessions.
- New runtime dependency: `@lannguyensi/hypothesis-tracker@0.2.0`.

## 0.2.0, 2026-05-15

### Added

- `grounding-mcp --version` (alias `-v`): fast-exit CLI short-circuit
  that prints the package version and returns 0 without opening the
  stdio MCP transport. Tooling that probes installed MCP binaries (e.g.
  `harness doctor`'s `tools.mcp[]` `min_version` check) otherwise hangs
  on stdin waiting for the initialize request that never arrives.

## 0.1.0, 2026-05-04

### First publish under the @lannguyensi scope

Initial release. The package previously lived as `grounding-mcp` (unscoped,
`private: true`) inside the agent-grounding monorepo. PR #66 renamed it to
`@lannguyensi/grounding-mcp`, dropped the private flag, and wired up the
tag-driven `publish-libs.yml` workflow.

### What ships

A stdio MCP server that exposes the agent-grounding stack as tools a
long-running Claude Code session can call:

- `grounding_start` / `grounding_advance` / `grounding_guardrail_check`:
  session lifecycle, wraps `@lannguyensi/grounding-wrapper`.
- `ledger_add` / `ledger_summary`: evidence-ledger surface, wraps
  `@lannguyensi/evidence-ledger`.
- `claim_evaluate` / `claim_evaluate_from_session`: claim-gate evaluation
  against caller-supplied context or auto-derived from session state.
- `verify_memory_reference`: memory-citation freshness check, wraps
  `@lannguyensi/runtime-reality-checker`.

Bin: `grounding-mcp`. Storage: `~/.grounding-mcp/sessions/<id>.json` for
session state, `~/.evidence-ledger/ledger.db` for ledger entries (override
via `GROUNDING_MCP_SESSIONS_DIR` / `EVIDENCE_LEDGER_DB`).

### Install paths

```bash
npm install -g @lannguyensi/grounding-mcp     # global, exposes the bin
# or invoke via npx in your Claude Code settings.json mcpServers config
```

### Runtime dependencies

All resolved from npm:
`@lannguyensi/claim-gate@0.2.0`,
`@lannguyensi/evidence-ledger@0.2.0`,
`@lannguyensi/grounding-wrapper@0.2.0`,
`@lannguyensi/runtime-reality-checker@0.1.0` (released alongside this one),
`@modelcontextprotocol/sdk@^1.29.0`, `zod@^3.23.8`.
