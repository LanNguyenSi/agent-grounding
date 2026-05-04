# Changelog

## 0.1.0, 2026-05-04

### First publish under the @lannguyensi scope

Initial release. The package previously lived as `domain-router` (unscoped,
`private: true`) inside the agent-grounding monorepo. PR #66 renamed it to
`@lannguyensi/domain-router`, dropped the private flag, and wired up the
tag-driven `publish-libs.yml` workflow.

### What ships

CLI + library that resolves a keyword / problem to the correct repos,
components, and documentation scope. Prevents agents from jumping to
random logs or services without first clarifying which system is meant.

- `route({ keyword, workspace, context })`: returns
  `{ domain, primary_repos, related_components, priority_files,
  forbidden_initial_jumps, confidence }`.
- Bin: `domain-router` for CLI invocation with `--json` output for
  scripted callers.

### Install

```bash
npm install -g @lannguyensi/domain-router     # exposes the bin
npm install @lannguyensi/domain-router        # for programmatic API
```

### Runtime dependencies

Pure JS: `chalk`, `commander`, `glob`, `js-yaml`. No internal cross-deps
on unpublished packages.
