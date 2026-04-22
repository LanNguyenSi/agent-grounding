# runtime-reality-checker

Compares actual runtime state against documentation and assumptions. Surfaces drift between what's documented and what's actually running — prevents agents from diagnosing based on stale or incorrect system models.

## Usage

```typescript
import { runRealityCheck, hasCriticalDrift } from "runtime-reality-checker";

const result = runRealityCheck(
  "production-server",
  [
    { name: "api", expected_startup: "docker", expected_port: 3001 },
    { name: "frontend", expected_startup: "docker", expected_port: 3000 },
  ],
  [
    { name: "api", running: true, startup_mode: "docker", port: 3001 },
    { name: "frontend", running: false },
  ],
);

console.log(result.ready_for_diagnosis); // false — frontend is down
console.log(result.summary);             // "1 critical drift(s) found — fix before diagnosing"

if (hasCriticalDrift(result)) {
  console.log("Critical drift detected:", result.drift);
}
```

## API

| Function | Description |
|----------|-------------|
| `runRealityCheck(domain, expected, actual)` | Full reality check — returns processes, drift, and readiness |
| `checkProcesses(expected, actual)` | Compare expected vs actual process states |
| `buildDriftItems(processResults)` | Generate drift items from process comparison |
| `hasCriticalDrift(result)` | Check if any critical drift exists |
| `getCriticalDrift(result)` | Get only critical drift items |

## Types

| Type | Description |
|------|-------------|
| `ExpectedProcess` | What a process should look like (name, startup mode, port) |
| `ActualProcessState` | What a process actually looks like at runtime |
| `DriftItem` | A difference between expected and actual (severity + message) |
| `RealityCheckResult` | Full check result with processes, drift, and summary |
| `ProcessStatus` | running, stopped, unknown |
| `ProcessCheckResult` | Per-process comparison result (drift flags for state, startup, port) |
| `StartupMode` | systemd, docker, pm2, manual, cron, unknown |

## verify_memory_reference

A memory that names a concrete file, symbol, or CLI flag is making a
claim about the current repo state. Files get renamed, symbols get
deleted, never-merged PRs leave phantom references — and a memory
written months ago has no way to catch up on its own. `CLAUDE.md`
mandates that an agent verify such references *before* recommending
anything based on a memory (see the "Before recommending from memory"
section).

`verifyMemoryReference` does that check in-process:

```typescript
import { verifyMemoryReference } from "runtime-reality-checker";

// 1. Does the file still exist?
const pathResult = verifyMemoryReference({
  kind: "path",
  value: "packages/memory-router/src/hooks/user-prompt-submit.ts",
  repoRoot: "/home/you/git/pandora/agent-memory",
});
// → { exists: true, lastModified: "2026-04-21T…", summary: "path '…' exists …" }

// 2. Does the function the memory references still exist?
const symbolResult = verifyMemoryReference({
  kind: "symbol",
  value: "loadMemoriesFromDir",
});
// → { exists: true, foundIn: [...], matchCount: N, summary: "symbol '…' found in N files" }

// 3. Is the CLI flag still wired up?
const flagResult = verifyMemoryReference({
  kind: "flag",
  value: "--no-verify",
});
// → { exists: false, summary: "flag '…' not found in any scanned file" }
```

Implementation notes:

- No runtime dependencies — native `fs` recursion + `RegExp`. Walks a
  typical mid-size repo in ~100 ms.
- Default ignores: `node_modules`, `dist`, `build`, `.git`, `.next`,
  `coverage`, `.venv`, `__pycache__`, `.turbo`, `.cache`.
- Default extensions (symbol/flag): `ts`, `tsx`, `mts`, `mjs`, `js`,
  `jsx`, `py`, `go`, `rs`, `java`. Override via `VerifyOptions.extensions`.
- Cap via `VerifyOptions.maxFiles` (default 5000) — the `summary` flags
  truncation so the caller can raise the cap on a larger repo.
- Never throws: unreadable `repoRoot` returns `{ exists: false }`.

Exposed via MCP as the `verify_memory_reference` tool in
[`grounding-mcp`](../grounding-mcp). Agents should call it whenever a
memory's content cites a specific file/function/flag before acting on
the advice.

## Development

```bash
npm install
npm run build    # TypeScript build
npm test         # Run tests (vitest)
npm run lint     # Type check
```
