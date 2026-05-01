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

- `@lannguyensi/understanding-gate` — see [`packages/understanding-gate/CHANGELOG.md`](packages/understanding-gate/CHANGELOG.md). Released under tags of the form `understanding-gate-vX.Y.Z` so its cadence does not bump the four version-locked packages.

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
  `EVIDENCE_LEDGER_DB` env var; defaults to `~/.evidence-ledger/db.sqlite`.
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
