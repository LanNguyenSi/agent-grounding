# Changelog

## 0.3.0, 2026-06-16

### Added

- **`RUNTIME_REALITY_TRIGGERS_FILE` override for custom trigger sets** (#114): operators can now supply a JSON file of custom triggers via the `RUNTIME_REALITY_TRIGGERS_FILE` env var instead of being locked to `DEFAULT_TRIGGERS`. New exports: `MAX_TRIGGERS_BYTES`, `TriggersLoadResult`, `parseTriggersFile`, `loadTriggersFile`, and `resolveTriggers` (pure resolver with fail-open `DEFAULT_TRIGGERS` fallback and stderr warning). `pre-tool-use.ts` calls `resolveTriggers` at startup and forwards warnings to stderr. README and `docs/policy-runtime-reality.md` updated with trigger-file shape doc (array format, 1 MiB cap, fail-open semantics). 30 new test cases added.

### Security

- **Bump `tsx` to `^4.22.4`** to clear esbuild advisories GHSA-gv7w-rqvm-qjhr and GHSA-g7r4-m6w7-qqqr (#107). `tsx >=4.22.0` resolves to `esbuild ~0.28.x` (patched); `npm audit` now reports 0 vulnerabilities.

## 0.2.1, 2026-06-09

### Fixed

- **Security (MEDIUM): infinite loop on zero-width regex matches in `countMatches`** (#38). An empty (trimmed) symbol or flag value built a pattern that matches the empty string, so `countMatches` never advanced `lastIndex` and looped forever. `countMatches` now bumps `lastIndex` on a zero-width match, and `verifyMemoryReference` rejects an empty (trimmed) symbol or flag value before any walk as defence in depth. Regression tests added.

## 0.2.0, 2026-05-26

### Added

- PreToolUse policy PoC (`./policy` sub-export, `runtime-reality-policy-pre-tool-use` bin):
  - `handlePolicyPreToolUse`: pure handler that runs `runRealityCheck` before runtime-mutating tool calls, returns a hookSpecificOutput envelope plus a structured `Decision`.
  - `triggers.ts`: default trigger set for compose / systemctl / kill / deploy-script Bash commands.
  - `expectations.ts`: JSON loader for per-keyword expected-process baselines, path-escape guarded.
  - Thin entrypoint binary in `dist/policy/pre-tool-use.js`, ships without a probe (degrades to allow by default, or blocks under `RUNTIME_REALITY_PROBE_FAIL_BLOCK=1`).
- Env-knob surface: `RUNTIME_REALITY_DISABLE`, `RUNTIME_REALITY_KEYWORD`, `RUNTIME_REALITY_EXPECTATIONS_DIR`, `RUNTIME_REALITY_WARN_AS_BLOCK`, `RUNTIME_REALITY_CRITICAL_AS_WARN`, `RUNTIME_REALITY_PROBE_FAIL_BLOCK`.
- Spec doc at `docs/policy-runtime-reality.md` (repo root) with trigger set, severity-to-decision matrix, worked compose-deploy example, and a `harness.yaml` integration snippet for the follow-up task in the harness project.

Phase 1 Schritt 3 of the agent-grounding plan, the harness-side hook registration is a separate task in the `harness` project (cross-repo bind).

## 0.1.0, 2026-05-04

### First publish under the @lannguyensi scope

Initial release. The package previously lived as `runtime-reality-checker`
(unscoped, `private: true`) inside the agent-grounding monorepo. PR #66
renamed it to `@lannguyensi/runtime-reality-checker`, dropped the private
flag, and wired up the tag-driven `publish-libs.yml` workflow.

### What ships

- `runRealityCheck(domain, expected, actual)`: full reality check against
  expected vs. observed process state, returns `{ processes, drift, summary,
  ready_for_diagnosis }`.
- `checkProcesses(expected, actual)`, `buildDriftItems(processResults)`,
  `hasCriticalDrift(result)`, `getCriticalDrift(result)`: granular helpers
  for callers that already have process state in hand.
- `verifyMemoryReference(reference)`: structured check for whether a
  memory-cited path / symbol / flag still exists in the repo. Used by
  `grounding-mcp`'s `verify_memory_reference` MCP tool.
- TypeScript types bundled (`dist/index.d.ts`).

### Required by

`@lannguyensi/grounding-mcp@0.1.0` declares this package as a runtime
dependency for its `verify_memory_reference` tool. Publishing this first
unblocks the grounding-mcp release.

### Runtime dependencies

Pure JS: `chalk`, `commander`. No internal cross-deps on unpublished
packages.
