# Changelog

## 0.1.2, 2026-07-27

### Security

- **Removed the phantom `glob` production dependency.** `glob` was declared
  under `dependencies` (`^10.3.0`) but was never imported anywhere in `src`
  or `dist` — verified with no static `require`/`import`, and no dynamic
  load path either (no variable- or template-argument `require`/`import()`,
  no `createRequire`, `module._load`, `eval`, or `new Function`). Because
  this package is published (no `private: true`, and
  `publishConfig.access` is `public`), the unused `glob@^10.3.0` pulled
  `minimatch@9.0.9` and the vulnerable `brace-expansion@2.1.2` (`<=5.0.7`,
  [GHSA-mh99-v99m-4gvg](https://github.com/advisories/GHSA-mh99-v99m-4gvg),
  HIGH) into every consumer's production dependency closure. `npm audit
  --omit=dev` against a fresh `npm install @lannguyensi/readme-first-resolver`
  no longer reports it.

### Removed

- **The phantom `js-yaml` dependency** (plus the now-unused
  `@types/js-yaml` dev dependency). This is dependency hygiene, not a
  security fix: `js-yaml` carries no advisory here. It was simply never
  imported — this package's full import set is `fs`, `path`,
  `os`/`child_process` (test files only), `commander`, `chalk`, and its
  own `./lib.js`, verified to the same standard as `glob` above.
  `js-yaml` is a genuine dependency of the sibling
  `@lannguyensi/domain-router` package and was left untouched there.

## 0.1.1, 2026-07-15

### Fixed

- **`readme-first --version` no longer hardcoded** (#72, #137). The CLI's
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
  in this monorepo instead of nonexistent standalone GitHub repos (prior
  docs-drift cleanup).

## 0.1.0, 2026-05-04

### First publish under the @lannguyensi scope

Initial release. The package previously lived as `readme-first-resolver`
(unscoped, `private: true`) inside the agent-grounding monorepo. PR #66
renamed it to `@lannguyensi/readme-first-resolver`, dropped the private
flag, and wired up the tag-driven `publish-libs.yml` workflow.

### What ships

A CLI plus a programmatic library that forces agents to read primary
documentation before any analysis and builds a system mental model from
it. Returns `ready_for_analysis: true` only when the configured
`must_read` files have been processed.

- Bin: `readme-first` with subcommand `resolve` and `--json` output.
- Library exports: `resolve`. The package entry point only starts the
  CLI when invoked as the bin (gated by `require.main === module`);
  calling `require('@lannguyensi/readme-first-resolver')` returns the
  library exports cleanly.

### Install

```bash
npm install -g @lannguyensi/readme-first-resolver    # exposes `readme-first`
npm install @lannguyensi/readme-first-resolver       # for programmatic API
```

### Runtime dependencies

Pure JS: `chalk`, `commander`, `glob`, `js-yaml`. No internal cross-deps
on unpublished packages.
