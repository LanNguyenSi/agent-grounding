# Changelog

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
