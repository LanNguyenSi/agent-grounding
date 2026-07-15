# Changelog

## 0.1.1, 2026-07-15

### Fixed

- **`debug-playbook --version` no longer hardcoded** (#72, #137). The CLI's
  `.version()` literal was a string duplicated from `package.json` that
  matched it only by coincidence; a later bump (e.g. this one) would have
  left `--version` printing a stale `0.1.0`. It now reads the version from
  `package.json` at runtime via a `readVersion()` helper. A regression test
  asserts `buildProgram().version()` equals `package.json`'s version, and a
  second test spawns the built `dist/index.js` as a subprocess and asserts
  its printed `--version` output matches too, so a future `rootDir`/`outDir`
  change can't silently break the resolution path without a build-vs-source
  test catching it.

### Added

- **`buildProgram()` factory + guarded entrypoint** (#130). The CLI's
  `program.parse()` call, previously executed unconditionally at module
  load, is now gated behind `require.main === module`. This makes the CLI
  directly testable (90+ new assertions across the sibling CLI packages)
  without auto-invoking the parser on import, and enables the coverage gate
  below.
- CI coverage gate: `jest.config.js` no longer excludes `src/index.ts` from
  `collectCoverageFrom`, so the CLI entrypoint is now subject to the
  package's declared `coverageThreshold` (lines 80 / functions 80 /
  branches 60), enforced in CI via `test:ci` (#130).

### Docs

- README: dropped the dead `lava-ice-logs`/persona link and rewrote the
  "grounding stack" list to relative `../<pkg>` links to sibling packages
  in this monorepo instead of nonexistent standalone GitHub repos. Reworked
  the `canMakeClaim` usage example to one that actually runs against the
  `clawd-monitor` playbook end to end (blocked path then allowed path), and
  documents that `root-cause`/`architecture` claims mix step IDs across
  built-in playbooks and can't be satisfied by any single one (#71, prior
  docs-drift cleanup).

## 0.1.0, 2026-05-04

### First publish under the @lannguyensi scope

Initial release. The package previously lived as `debug-playbook-engine`
(unscoped, `private: true`) inside the agent-grounding monorepo. PR #66
renamed it to `@lannguyensi/debug-playbook-engine`, dropped the private
flag, and wired up the tag-driven `publish-libs.yml` workflow.

### What ships

A CLI plus a programmatic library that guides agents through
domain-specific, ordered diagnostic sequences. Prevents hypothesis-hopping
by gating claims behind completed playbook steps.

- Bin: `debug-playbook`. Subcommands `run`, `next`, plus `--json` for
  scripted callers.
- Library exports: `getPlaybook`, `initRun`, `getCurrentStep`,
  `recordStep`, `getRemainingMandatory`. The package entry point only
  starts the CLI when invoked as the bin (gated by `require.main ===
  module`); calling `require('@lannguyensi/debug-playbook-engine')`
  returns the library exports cleanly.
- Built-in playbooks: `clawd-monitor` (basic connectivity), `github` (API
  connectivity), `generic` (fallback diagnostic sequence).

### Install

```bash
npm install -g @lannguyensi/debug-playbook-engine    # exposes `debug-playbook`
npm install @lannguyensi/debug-playbook-engine       # for programmatic API
```

### Runtime dependencies

Pure JS: `chalk`, `commander`, `js-yaml`. No internal cross-deps on
unpublished packages.
