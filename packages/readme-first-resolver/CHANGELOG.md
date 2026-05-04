# Changelog

## 0.1.0, 2026-05-04

### First publish under the @lannguyensi scope

Initial release. The package previously lived as `readme-first-resolver`
(unscoped, `private: true`) inside the agent-grounding monorepo. PR #66
renamed it to `@lannguyensi/readme-first-resolver`, dropped the private
flag, and wired up the tag-driven `publish-libs.yml` workflow.

### What ships

CLI + library that forces agents to read primary documentation before any
analysis, and builds a system mental model from it. Returns
`ready_for_analysis: true` only when the configured `must_read` files have
been processed.

- `resolve({ repo_path, must_read })`: returns
  `{ system_summary, unknowns, sources_read, sources_missing,
  ready_for_analysis }`.
- Bin: `readme-first` for CLI invocation with `--json` output.

### Install

```bash
npm install -g @lannguyensi/readme-first-resolver    # exposes `readme-first`
npm install @lannguyensi/readme-first-resolver       # for programmatic API
```

### Runtime dependencies

Pure JS: `chalk`, `commander`, `glob`, `js-yaml`. No internal cross-deps
on unpublished packages.
