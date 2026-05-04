# Changelog

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
