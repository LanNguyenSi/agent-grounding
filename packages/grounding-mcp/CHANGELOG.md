# Changelog

## Unreleased

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
