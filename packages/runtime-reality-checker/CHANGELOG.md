# Changelog

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
