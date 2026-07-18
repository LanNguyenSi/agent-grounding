# Changelog

All notable changes to the published library packages in this repository
are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and the published packages adhere to [Semantic Versioning](https://semver.org/).

This monorepo currently version-locks four published library packages
together: a single tag `vX.Y.Z` releases all of them at the same version.
That coupling can be loosened later if a package's release cadence
diverges.

Version-locked published packages:

- `@lannguyensi/grounding-wrapper`
- `@lannguyensi/evidence-ledger`
- `@lannguyensi/claim-gate`
- `@lannguyensi/hypothesis-tracker`

Independently-versioned published packages (own tag, own CHANGELOG):

- `@lannguyensi/understanding-gate`: see [`packages/understanding-gate/CHANGELOG.md`](packages/understanding-gate/CHANGELOG.md). Released under tags of the form `understanding-gate-vX.Y.Z` (handled by `publish-understanding-gate.yml`) so its cadence does not bump the four version-locked packages.
- `@lannguyensi/grounding-mcp`: see [`packages/grounding-mcp/CHANGELOG.md`](packages/grounding-mcp/CHANGELOG.md).
- `@lannguyensi/grounding-sdk`: see [`packages/grounding-sdk/CHANGELOG.md`](packages/grounding-sdk/CHANGELOG.md).
- `@lannguyensi/review-claim-gate`: see [`packages/review-claim-gate/CHANGELOG.md`](packages/review-claim-gate/CHANGELOG.md).
- `@lannguyensi/runtime-reality-checker`: see [`packages/runtime-reality-checker/CHANGELOG.md`](packages/runtime-reality-checker/CHANGELOG.md).
- `@lannguyensi/debug-playbook-engine`: see [`packages/debug-playbook-engine/CHANGELOG.md`](packages/debug-playbook-engine/CHANGELOG.md).
- `@lannguyensi/domain-router`: see [`packages/domain-router/CHANGELOG.md`](packages/domain-router/CHANGELOG.md).
- `@lannguyensi/readme-first-resolver`: see [`packages/readme-first-resolver/CHANGELOG.md`](packages/readme-first-resolver/CHANGELOG.md).

The seven packages above (other than understanding-gate) each carry their own version and CHANGELOG and are released under per-package tags of the form `<pkg>-vX.Y.Z` by `publish-libs.yml`; they move independently of the four version-locked packages.

## [Unreleased]

### Added

- All four version-locked packages plus `grounding-mcp`, `grounding-sdk`,
  `review-claim-gate`, and `understanding-gate` now declare
  `engines: { node: ">=20" }`. `better-sqlite3` `^12.9` effectively requires
  Node >= 20 already; without the declaration, older Nodes fail late during
  the native build with opaque C++ errors instead of early and clearly at
  `npm install`. (Reviewer follow-up from the 0.5.1 train, PR #147.)

## [0.5.1] - 2026-07-17

### Fixed

- `evidence-ledger`: bump `better-sqlite3` from `^9.4.3` to `^12.9.0`. The 9.x
  series ships no prebuilds for Node 26 and fails to compile from source
  because the Node 26 headers require C++20 while better-sqlite3 9.x builds
  with C++17 — this broke every registry install of a consumer (first hit:
  `harness init --interactive` installing `@lannguyensi/grounding-mcp` on
  Node 26.5.0, darwin x64). `^12.9.0` matches the pin agent-memory's
  memory-router already uses; 12.x installs a working Node 26 prebuild. No
  API changes in the ledger itself.

### Changed

- `grounding-wrapper`, `claim-gate`, `hypothesis-tracker`: version-locked
  ride-along bumps, no code changes.

## [0.5.0] - 2026-07-02

### Security / Reliability

- `evidence-ledger`: harden the SQLite store (audit findings M3, M4). The DB
  now opens in WAL mode so concurrent hook processes read while one writes
  instead of colliding on `SQLITE_BUSY`; the native `Database` open is
  wrapped so a broken binding or un-creatable path throws a clear,
  path-named error instead of a raw addon string; and `addEntry` /
  `rejectHypothesis` run their read-modify-read in a transaction. The ledger
  directory is created `0700` and the DB file `0600` so captured evidence is
  not world-readable on a shared host. WAL is a no-op for `:memory:`.

### Changed

- `hypothesis-tracker`: `importStore` now validates the parsed shape (audit
  finding M7) and throws a clear, field-named error instead of a bare
  `JSON.parse(...) as HypothesisStore` that crashed downstream on a non-array.
  **BREAKING (pre-1.0):** `supportHypothesis` now refuses to confirm a
  hypothesis while its own declared `required_checks` are still pending
  (returns null where it previously confirmed); evidence stays optional by
  design, since support is the manual escape hatch for out-of-band evidence.
- `grounding-wrapper` / `claim-gate`: CLI entrypoints refactored for direct
  test coverage (#130); no behavior change.

## [0.4.0] - 2026-06-16

Surfaces the `policy_decision` bucket in the `evidence-ledger` CLI display
and handoff, and clears the esbuild build-tool advisories. The four
version-locked packages all bump to 0.4.0; only `evidence-ledger` has new
feature code, `claim-gate` and `evidence-ledger` also carry the security
bump, and `grounding-wrapper` / `hypothesis-tracker` go along by repo
convention with no code change. Pre-1.0: the public API surface continues
to be subject to change between minor releases.

Sibling packages (`grounding-mcp` 0.4.0, `grounding-sdk` 0.1.2,
`review-claim-gate` 0.1.2) are bumped in the same commit so their pinned
exact `0.3.0` references on the lockstep set move to `0.4.0` and the
workspace stays drift-free. `grounding-mcp` 0.4.0 additionally ships its
own `hypothesis_reset` verb (see its package CHANGELOG) and re-pins
`runtime-reality-checker` to `0.3.0`.

### `@lannguyensi/evidence-ledger`

- **Render the `policy_decision` bucket in the CLI display and handoff**
  (#111). The ledger CLI now surfaces `policy_decision` entries in its
  display and handoff output, so recorded policy decisions are visible
  alongside the existing buckets.

### Security (`@lannguyensi/claim-gate`, `@lannguyensi/evidence-ledger`)

- **Bump `tsx` to `^4.22.4`** to clear esbuild advisories
  GHSA-gv7w-rqvm-qjhr and GHSA-g7r4-m6w7-qqqr (#107).

## [0.3.0] - 2026-05-27

Hardens the `grounding-wrapper` public surface against degenerate input
and tightens the lifecycle-state shape exposed over MCP. The four
version-locked packages all bump to 0.3.0; only `grounding-wrapper` has
new code, the others go along by repo convention. Pre-1.0: the public
API surface continues to be subject to change between minor releases.

Sibling packages (`grounding-mcp` 0.3.1, `grounding-sdk` 0.1.1,
`review-claim-gate` 0.1.1) are bumped in the same commit so their pinned
exact `0.2.0` references on the lockstep set move to `0.3.0` and the
workspace stays drift-free.

### `@lannguyensi/grounding-wrapper`

#### Added

- **`validateKeyword(keyword)`** (#98, task `7db33828`). Exported
  helper that throws when the keyword is non-string, empty, longer
  than `KEYWORD_MAX_LENGTH` (64), or normalises to an empty slug
  (`toLowerCase` → `[^a-z0-9]+` collapse → trim leading/trailing `-`).
  `initSession` calls it first so previously-silent degenerate inputs
  (`""`, whitespace-only, pure-Unicode, oversize) now throw instead of
  emitting ids like `gs--<ts>` and empty `resolved_scope`. Mixed inputs
  with at least one ASCII alphanumeric after normalisation (e.g.
  `"クラウド-monitor"` → `"monitor"`) still pass. README "Public API for
  enforcement" gains an "Input invariants" bullet naming the rule.

#### Fixed

- **`phase_status.complete` set to `'done'` on terminal transition**
  (#97, task `9a258d6d`). Previously left at `'pending'` after
  `advancePhase` reached `complete`, so `summarizeSession` over MCP
  emitted a shape where `current_phase: 'complete'` disagreed with
  `phase_status.complete: 'pending'`. Now symmetric with every other
  transitioned-out phase. Two new tests pin the invariant + idempotent
  persistence.
- `advancePhase` is now idempotent once `current_phase === 'complete'`.
  Previously, calling `advancePhase` on an already-complete session
  silently reset `current_phase` to `scope-resolution`. New behavior:
  the call is a no-op. Pinned by test `is idempotent once complete is
  reached` in `src/__tests__/lib.test.ts`.

#### Changed

- README rewritten to match actual behavior. The package is a session
  *planner*, not an orchestrator: it does not invoke the seven
  downstream tools. Enforcement is the caller's job (typically a
  harness Policy). Added a "Public API for enforcement" section
  describing the consumption contract for downstream enforcers.
- Test coverage on `src/lib.ts` raised to 100% (added an explicit
  test for the `arch|design|system` guardrail path that was previously
  uncovered).

### `@lannguyensi/evidence-ledger`, `@lannguyensi/claim-gate`, `@lannguyensi/hypothesis-tracker`

No code changes. Bumped to 0.3.0 to keep the version-locked invariant.

## [0.2.0] - 2026-05-01

Coordinated release with harness Phase 5 (LanNguyenSi/harness v0.5.0).
The four version-locked packages all bump to 0.2.0; `evidence-ledger`
is the only one with new code, the others go along by repo convention.
Pre-1.0: the public API surface continues to be subject to change
between minor releases.

### `@lannguyensi/evidence-ledger`

#### Removed

- *(retroactive addendum, added 2026-07-18)* The `EVIDENCE_LEDGER_DB`
  environment-variable override for the database path, supported in 0.1.x,
  was removed in this release without a changelog note at the time. Since
  0.2.0 the module resolves `~/.evidence-ledger/ledger.db` unless a path is
  passed to `getDb(dbPath)` explicitly. External writers still honoring the
  variable diverge silently from readers using the default path (reads
  soft-degrade rather than fail). Decision 2026-07-18: the override stays
  removed — path control belongs to the caller/CLI layer (as in
  `grounding-mcp`, onto which harness projects an env var of the same name);
  a module-level env override would reintroduce exactly the ambiguity the
  removal eliminated.

#### Added

- **`policy_decision` first-class entry type** (Phase 5 #4 / harness PR
  #47). `EntryType` union extended; `getSummary` returns a 5th bucket
  `policyDecisions: LedgerEntry[]`; the four evidence buckets
  (`facts/hypotheses/rejected/unknowns`) now exclude policy_decision
  rows so audit/evidence consumers don't contaminate each other. Old
  CHECK constraints are auto-migrated on first open via the canonical
  rename-recreate dance, preserving rows.
- **`getSummary` server-side filters** (Phase 5 #5 / harness PR #46).
  Optional `sinceIso` (`created_at >= datetime(@sinceIso)`) and
  `contentPrefix` (`content LIKE prefix% ESCAPE '\\'`, with LIKE
  metacharacter escape so a literal `_` in the prefix doesn't act as
  a wildcard) keep the wire payload narrow when consumers only need a
  recent or prefix-bound slice.
- **`parseLedgerTimestamp` UTC normalisation** at the SQL layer for
  the new `sinceIso` filter (Phase 5 #8). SQLite's `datetime('now')`
  writes UTC `YYYY-MM-DD HH:MM:SS`; lexicographic compare against an
  ISO-8601 `YYYY-MM-DDTHH:MM:SSZ` cutoff fails (`T` > space). Filter
  now compares via `datetime(...)` on both sides.

#### Changed

- `getSummary` signature: third optional `filters` arg
  (`{ sinceIso?, contentPrefix? }`). Existing 2-arg callers continue
  to work unchanged.
- `LedgerSummary` type adds `policyDecisions: LedgerEntry[]`. Old
  consumers that only read the four evidence buckets are unaffected.

### `grounding-mcp`

Internal-only (kept `private: true`). The MCP server's `ledger_add`
zod enum now accepts `policy_decision`, and `ledger_summary` surfaces
the new bucket + counts. Used by harness via direct binary spawn
(`node grounding-mcp/dist/server.js`).

### `@lannguyensi/grounding-wrapper`, `@lannguyensi/claim-gate`, `@lannguyensi/hypothesis-tracker`

No code changes. Bumped to 0.2.0 to keep the version-locked invariant.

## understanding-gate v0.1.0 - 2026-05-01

First public release of `@lannguyensi/understanding-gate` (independently versioned, tag `understanding-gate-v0.1.0`). Implements Phases -1 through 1 of the package's [`ROADMAP`](packages/understanding-gate/ROADMAP.md): claude-code MVP (UserPromptSubmit hook, fast_confirm + grill_me modes), opencode adapter (rules + plugin), structured Markdown → Report parser, content-hash-keyed local persistence, claude-code Stop hook + opencode `message.updated` plugin auto-capture, and the hypothesis-tracker bridge that registers assumptions + open questions. Plus the Phase 1 robustness, observability, and ergonomics follow-ups.

Full release notes: [`packages/understanding-gate/CHANGELOG.md`](packages/understanding-gate/CHANGELOG.md).

## [0.1.0] - 2026-04-28

First public release of the four library packages. Pre-1.0: the public
API surface (especially `GroundingSession` shape, `evaluateClaim` context
flags, and the evidence-ledger SQLite schema) may shift between minor
versions until v1.0.0.

### Added

- Scoped npm publish under `@lannguyensi/`. The four library packages can
  now be installed from outside this monorepo. Internal monorepo
  consumers (`grounding-mcp`, `grounding-sdk`, `review-claim-gate`)
  reference them by scoped name.
- `@lannguyensi/grounding-wrapper`: orchestration of the grounding stack,
  `initSession`, `advancePhase`, `resolveGuardrails`, mandatory-sequence
  resolution, and the `GroundingSession` shape consumers persist
  themselves.
- `@lannguyensi/evidence-ledger`: SQLite-backed evidence store with
  `addEntry`, `rejectHypothesis`, `getSummary`, `listEntries`,
  `pruneEntries`, plus a `ledger` CLI. Native dependency on
  `better-sqlite3`. Database path overridable via the
  `EVIDENCE_LEDGER_DB` env var; defaults to `~/.evidence-ledger/ledger.db`.
- `@lannguyensi/claim-gate`: deterministic policy engine that decides
  whether a claim is allowed given a `ClaimContext` (evidence presence,
  reproduction state, and similar flags). Pure functions, no IO.
- `@lannguyensi/hypothesis-tracker`: in-memory tracker for competing
  hypotheses across a debugging session, ensures hypothesis transitions
  are explicit instead of silent overwrites.
- Tag-driven publish workflow (`.github/workflows/publish-npm.yml`) that
  matrix-publishes all four packages on a `v*` tag, validates each
  package's `version` field matches the tag, runs the package-specific
  test suite, and uses provenance.
- Release workflow (`.github/workflows/release.yml`) that creates a
  GitHub Release with notes extracted from this CHANGELOG for the tagged
  version.

### Notes for consumers

- The grounding session JSON is stateless on the wrapper side; it is the
  caller's job to persist sessions. The session-store implementation
  inside `grounding-mcp` writes to `~/.grounding-mcp/sessions/` on the
  local filesystem, so any cross-host integration (server-side starts +
  agent-side advances on a different machine) needs its own persistence
  layer or a future shared backend.
- `evidence-ledger` writes to a single SQLite file. Multi-process
  callers should serialize writes themselves; the package does not
  provide a higher-level lock.
