# Changelog

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
  - `track(store, hypothesis)`, `verify(claim, context, claimType)`,
    `validate(checks)`, plus `createStore` and the type re-exports for
    `Hypothesis`, `EvidenceContext`, `ValidationCheck`, etc.
- TypeScript types are bundled (`dist/index.d.ts`).
- Four scoped runtime dependencies, all already published:
  `@lannguyensi/claim-gate@0.2.0`, `@lannguyensi/evidence-ledger@0.2.0`,
  `@lannguyensi/grounding-wrapper@0.2.0`, `@lannguyensi/hypothesis-tracker@0.2.0`.

### Dogfood

Pack-and-install in a fresh tmp dir resolves the four scoped deps from the
registry and lets a downstream consumer call `verify` / `track` / `validate`
without touching the agent-grounding monorepo. The release-PR test plan
captures the working consumer script and its output.
