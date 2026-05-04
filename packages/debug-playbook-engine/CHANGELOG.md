# Changelog

## 0.1.0, 2026-05-04

### First publish under the @lannguyensi scope

Initial release. The package previously lived as `debug-playbook-engine`
(unscoped, `private: true`) inside the agent-grounding monorepo. PR #66
renamed it to `@lannguyensi/debug-playbook-engine`, dropped the private
flag, and wired up the tag-driven `publish-libs.yml` workflow.

### What ships

CLI + library that guides agents through domain-specific, ordered
diagnostic sequences. Prevents hypothesis-hopping by gating claims behind
completed playbook steps.

- `getPlaybook(domain, problem)`, `initRun(playbook)`, `recordStep(...)`,
  `canMakeClaim(state, claimType)`: programmatic API.
- Bin: `debug-playbook` for CLI invocation.
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
