# Changelog

## 0.1.4, 2026-07-17

### Changed

- Re-pin `claim-gate`, `evidence-ledger`, `grounding-wrapper` and
  `hypothesis-tracker` to 0.5.1. Picks up the evidence-ledger
  `better-sqlite3` `^12.9.0` bump (Node 26 install fix). No behavior
  changes.

## 0.1.3, 2026-07-02

### Changed

- Re-pinned the lockstep dependencies (`claim-gate`, `evidence-ledger`,
  `grounding-wrapper`, `hypothesis-tracker`) to `0.5.0` to track the
  coordinated 0.5.0 release (evidence-ledger WAL/perms hardening,
  hypothesis-tracker M7 gating).

- `deriveContextFromSession` now documents why `process_checked`, `config_checked`, and `health_checked` all derive from the single `runtime-inspection` phase (audit finding M2): the grounding-wrapper phase model has one runtime phase, so the three move together. A regression test pins the coarse mapping. A true per-check distinction needs a phase-model change and is tracked as a follow-up. No behavior change.

## 0.1.2, 2026-06-16

### Changed

- Re-pinned the exact lockstep dependencies (`claim-gate`, `evidence-ledger`, `grounding-wrapper`, `hypothesis-tracker`) from `0.3.0` to `0.4.0` to track the coordinated 0.4.0 release. No public API change.

## 0.1.0, 2026-05-04

### First publish under the @lannguyensi scope

Initial release. The package previously lived as `grounding-sdk` (unscoped)
with `private: true` inside the agent-grounding monorepo, advertised in its
README as `npm install grounding-sdk` but never actually published. PR #66
renamed it to `@lannguyensi/grounding-sdk`, removed the private flag, and
wired up the new tag-driven `.github/workflows/publish-libs.yml` workflow.
This release is the first to land that workflow on a real tag.

### What ships

- The three top-level helpers, unchanged from the in-monorepo shape:
  - `track(store, input)`, `verify(claim, evidence, claimType)`,
    `validate({ session, claim, type?, ledgerSummary? })`, plus
    `createStore` and `deriveContextFromSession` (escape hatch when a
    consumer already has a `ClaimContext`-based flow). Type re-exports
    for `ClaimContext`, `ClaimResult`, `ClaimType`, `GroundingSession`,
    `Hypothesis`, `HypothesisStore`, `LedgerSummary`.
- TypeScript types are bundled (`dist/index.d.ts`).
- Four scoped runtime dependencies, all already published:
  `@lannguyensi/claim-gate@0.2.0`, `@lannguyensi/evidence-ledger@0.2.0`,
  `@lannguyensi/grounding-wrapper@0.2.0`, `@lannguyensi/hypothesis-tracker@0.2.0`.

### Dogfood

Pack-and-install in a fresh tmp dir resolves the four scoped deps from the
registry and lets a downstream consumer call `verify` / `track` / `validate`
without touching the agent-grounding monorepo. The release-PR test plan
captures the working consumer script and its output.
