# Changelog

## 0.1.1, 2026-07-15

### Fixed

- **`domain-router --version` no longer hardcoded** (#72, #137). The CLI's
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

- README: documents the shipped `impact` subcommand alongside `route`
  (#122). Dropped the dead `lava-ice-logs`/persona link and rewrote the
  "grounding stack" list to relative `../<pkg>` links to sibling packages
  in this monorepo instead of nonexistent standalone GitHub repos; renamed
  the example host `ice-vps` to `vps-01` (prior docs-drift cleanup).

## 0.1.0, 2026-05-04

### First publish under the @lannguyensi scope

Initial release. The package previously lived as `domain-router` (unscoped,
`private: true`) inside the agent-grounding monorepo. PR #66 renamed it to
`@lannguyensi/domain-router`, dropped the private flag, and wired up the
tag-driven `publish-libs.yml` workflow.

### What ships

A CLI plus a programmatic library that resolves a keyword / problem to
the correct repos, components, and documentation scope. Prevents agents
from jumping to random logs or services without first clarifying which
system is meant.

- Bin: `domain-router` with subcommands `route` and `impact`, plus
  `--json` output for scripted callers.
- Library exports: `route`, `impact`. The package entry point only
  starts the CLI when invoked as the bin (gated by `require.main ===
  module`); calling `require('@lannguyensi/domain-router')` returns the
  library exports cleanly.

### Install

```bash
npm install -g @lannguyensi/domain-router     # exposes the bin
npm install @lannguyensi/domain-router        # for programmatic API
```

### Runtime dependencies

Pure JS: `chalk`, `commander`, `glob`, `js-yaml`. No internal cross-deps
on unpublished packages.
