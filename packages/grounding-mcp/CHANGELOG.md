# Changelog

## Unreleased

### Added

- **OW run resolution is now pointer-first, with keyed `run-base` markers**
  (task 43a7ef58). `readOwRunCompleteness` (`src/ow-run-completeness.ts`)
  resolves the worktree-local `.ai/run` pointer file before falling back to
  the newest-run scan of `.ai/runs/`; the scan is consulted only when no
  pointer file exists. A pointer file that exists but does not resolve
  (unreadable, empty, a relative path, or a target missing / not a
  directory / not a dated run directory) is a distinct fail-closed blocker
  and never silently falls back to the scan. Which channel resolved the run
  is reported on the new `runSource: 'pointer' | 'scan' | null` field. The
  `run-base` change-binding marker in `00-goal.md` may now also be keyed per
  repo (`run-base[<repo-basename>] = <sha>`), so one run can bind more than
  one repo in a monorepo/fleet: selection tries the worktree's own basename
  first, then — for a linked git worktree — the main repository's basename
  (resolved via the worktree's `.git` `gitdir:` file and `commondir`), and
  the first key whose keyed marker is present decides, without falling
  through to a later key or the legacy unkeyed marker. `owBlockersFor`'s
  `on`-knob "no run" message (`src/solution-verdict.ts`) now names both
  resolution channels. The `.ai/run` pointer file and the keyed markers are
  written by the orchestrator-workflow kit's writer side (agent-dx task
  2c3d141c, not yet released); this repo only reads and verifies them.
  Covered by `tests/ow-run-completeness.test.ts` (reader unit tests,
  including real and fabricated linked-worktree fixtures) and
  `tests/ow-run-binding.test.ts` (`owBlockersFor` end-to-end through real
  `git worktree add` fixtures, attached and detached).
  - Review-round-1 fixes (task 43a7ef58, T-001): a goal file with keyed
    `run-base` markers but none matching this worktree's candidate keys,
    and no unkeyed marker either, is now an explicit fail-closed blocker
    naming the keys found and the keys tried — previously this fell
    through silently. Candidate-key matching against the recorded keyed
    markers is now case-insensitive. `resolveRunPointer` resolves the
    pointer target through `fs.realpathSync` before the directory/dated
    checks, so a symlinked run directory is followed to its real path.
    `findWorktreeRoot` now uses `fs.lstatSync` instead of `fs.existsSync`,
    so a dangling `.git` symlink still marks the worktree root instead of
    being treated as absent.
  - Review-round-1 fixes (task 43a7ef58, T-004): `OwRunCompleteness` gains
    `runBaseKind: 'sha' | 'todo' | 'absent' | 'unmatched-keyed'`, naming WHY
    `runBase` has the value it has. `owBindingBlockers` (`src/solution-verdict.ts`)
    now skips the legacy date-heuristic path outright when
    `runBaseKind === 'unmatched-keyed'`: previously, a goal file with keyed
    `run-base` markers that matched none of this worktree's candidate keys
    (and no unkeyed marker) correctly got the reader's own explicit
    fail-closed reason, but the binding check still ran the heuristic on top
    of it and could append a second, misleading "has no run-base marker"
    blocker for the same underlying failure. Now exactly one blocker is
    reported.
  - Review-round-2 fix (task 43a7ef58, T-005): keyed `run-base` markers are
    now a grammar instead of one regex per accepted shape. A well-formed
    keyed marker must be a WHOLE LINE (leading/trailing whitespace only)
    matching `<!-- solution-acceptance: run-base[<key>] = <value> -->`; a
    line that starts like one (`run-base[`, optionally with stray whitespace
    before the bracket) but does not match the strict shape is now collected
    as an explicit MALFORMED blocker instead of degrading silently to the
    legacy date heuristic — previously a near-miss such as `run-base
    [alpha] = <sha>` or `run-base[alpha = <sha>` (missing bracket) or an
    empty value fell straight through, unnoticed. `OwRunCompleteness`'s
    `runBaseKind` gains `'malformed'`; `owBindingBlockers` skips the
    heuristic for both `'malformed'` and `'unmatched-keyed'`, so exactly one
    blocker is still reported, never two. A strict match whose key is itself
    a documentation placeholder (`<repo-basename>`-style) is ignored, not
    counted as present; a prose line that merely quotes the marker syntax,
    or a marker that does not start its own line, is also ignored — the
    collection regex is now whole-line-anchored, so it can no longer be
    blocked by a complete line quoting the marker form, nor swallow the next
    line's first token on an empty value. Both new blocker messages are
    bounded (keys truncated to 64 chars / 10 shown, malformed lines
    truncated to 80 chars / 5 shown, `(+N more)` beyond that). The legacy
    unkeyed `run-base` matcher is unchanged (documented asymmetry: it stays
    a non-line-anchored substring match).

## 0.8.0, 2026-08-19

### Added

- Dependency pin moved to `@lannguyensi/runtime-reality-checker@^0.3.0`
  (resolves to the published 0.3.0 today; satisfies the staged workspace
  0.3.2 for the pin-consistency guard). 0.3.1/0.3.2 are registry-held (package-specific
  server-side block, npm support ticket pending) and carry no API delta
  this package consumes; the rrc-internal symlink-containment fix (#142)
  follows with the next pin bump once the hold is lifted.

- **`bin` entry normalized to `dist/server.js` (no `./` prefix)** (task
  256d65a6): npm >= 11 strips `./`-prefixed bin targets from the manifest it
  submits at publish time ("auto-corrected ... and removed"), which both
  loses the bin in the registry metadata and diverges the submitted
  manifest from the tarball's own package.json. All packages in this repo
  got the same normalization; the published artifacts already carried the
  `./`-free form (they were published by npm 10).

- **`solution_evaluate` now signs the verdict marker.** The marker
  `writeVerdict` (`src/solution-verdict.ts`) writes to
  `$SOLUTION_VERDICT_DIR`/`~/.local/state/agent-grounding/solution-verdicts/`
  carries two new fields, `alg` (`'hmac-sha256-v1'`) and `signature`
  (HMAC-SHA256 hex), computed by the new `src/verdict-signing.ts`. The
  producer signs **unconditionally**: there is no unsigned fallback. The
  signing key lives at `<harness-home>/harness.generated/.approval-signing.key`
  (`getOrCreate`: read an existing >=32-byte file, else generate and write
  `crypto.randomBytes(32)` at mode `0600`, race-tolerant against a
  concurrent creator); `<harness-home>` is resolved with the same
  precedence the harness consumer uses (`$HARNESS_HOME` env override,
  else `~/.harness` if it exists, else `~/.claude` if it already carries
  harness state, else `~/.harness` created on first use). This is an
  additive change to the on-disk shape: the 7 previously-pinned verdict
  fields (`id`, `head`, `ready`, `confidence`, `blockers`, `timestamp`,
  `source`) are unchanged, so existing non-harness readers of the marker
  are unaffected. Proven against harness' own consumer-side verification
  logic by a vendored interop suite
  (`packages/grounding-mcp/tests/interop/`): a real `writeVerdict` marker
  is accepted, and tampering, cross-id replay, and an unrecognized `alg`
  are all rejected the same way harness itself rejects them.
- **`SOLUTION_VERDICT_SIGNING_KEY` env projection (primary key path).**
  When set (an absolute path to the signing-key FILE, projected by harness
  at apply time onto this MCP server's env following its
  `EVIDENCE_LEDGER_DB` pattern; slice H1 of the task-9b6c4beb Option-2
  design), the producer reads/creates the key at exactly that path and the
  mirrored home resolution above becomes the documented fallback for
  non-harness-managed setups. This removes the one ambiguity the mirror
  cannot close (a harness run under `--config` / a non-default home).
  `getOrCreate` semantics apply at the projected path too, so whichever
  side runs first creates the shared key race-tolerantly.

  **Release sequencing warning.** `grounding-mcp-v0.8.0` MUST be published
  to npm and installed on every machine running the `grounding-mcp` MCP
  server **before** harness task `c7c3f606`
  (`batch19/sign-verdict-marker`) is merged/released. Once the harness
  consumer ships, it verifies every solution-acceptance verdict marker's
  signature before trusting it, and a marker written by a producer older
  than 0.8.0 carries no `alg`/`signature` at all. That shape does **not**
  hit the consumer's narrow "genuinely unsigned, not forged" carve-out
  (which only fires when a required signed field, e.g. `timestamp`, reads
  blank AND `alg`/`signature` are both absent); a realistic legacy marker
  still has a valid `timestamp`/`source` and no `alg`/`signature`, which
  the consumer classifies `forged: true` via its generic "missing
  signature (legacy pre-signing marker, or forged file)" branch. Releasing
  harness first therefore denies the completion gate universally for
  every repo still on a pre-0.8.0 grounding-mcp, not just for genuinely
  forged markers.

## 0.7.1, 2026-08-06

### Changed

- Re-pin `runtime-reality-checker` to 0.3.1. Picks up the phantom
  `chalk`/`commander` dependency removal caught by the new repo-wide
  `check:deps` guard (`scripts/check-deps.js`); the exact-pin lockstep
  convention used for internal `@lannguyensi/*` deps means the workspace
  bump alone does not update what grounding-mcp bundles. No behavior
  changes from the re-pin itself.

## 0.7.0, 2026-07-18

### Fixed

- **OW reader: close the mixed-state findings-table bypass.** `readOwRunCompleteness` previously reported a run as `complete` whenever the solution-acceptance markers were set to an accepted value, even if the Findings table still carried the shipped review template's untouched placeholder/legend row and no concrete finding row had ever been added — an operator could flip the markers to `accepted`/`accept` without ever transferring the reviewer's findings into the table. The reader now recognizes that placeholder row by a byte-exact match of the COMPLETE shipped row (every cell, not just the Severity slash-list) and blocks with `complete: false` when it survives untouched AND no row anywhere carries a concrete severity, naming both escape hatches in the reason (transfer the findings, or delete the placeholder row for a genuine zero-findings review). Unaffected: a header row with no data rows at all (the placeholder already deleted) stays `complete: true`, and a concrete finding row sitting next to a left-behind placeholder row is still valid, as before. Lockstep with agent-dx's `packages/orchestrator-workflow/assets/templates/05-review-findings.md` placeholder row and its `test/template-markers.test.ts` pin; the exact row text is exported as `OW_FINDINGS_PLACEHOLDER_ROW` and pinned by a reciprocal test on this side.

### Changed

- Re-pin the four version-locked libs (`claim-gate`, `evidence-ledger`,
  `grounding-wrapper`, `hypothesis-tracker`) to 0.6.0. Picks up the
  evidence-ledger `getDb` guard fix and the uniform `engines >=20` baseline.
  No behavior changes from the re-pin itself.

## 0.6.1, 2026-07-17

### Changed

- Re-pin the four version-locked libs (`claim-gate`, `evidence-ledger`,
  `grounding-wrapper`, `hypothesis-tracker`) to 0.5.1. Picks up the
  evidence-ledger `better-sqlite3` `^12.9.0` bump, which unbreaks
  `npm i -g @lannguyensi/grounding-mcp` on Node 26 (9.x has no Node 26
  prebuilds and no longer compiles from source). No behavior changes.

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
