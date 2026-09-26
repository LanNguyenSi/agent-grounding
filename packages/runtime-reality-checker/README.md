# runtime-reality-checker

Compares actual runtime state against documentation and assumptions.

## Overview

Surfaces drift between what's documented and what's actually running, and prevents agents from diagnosing based on stale or incorrect system models. Beyond the library API, the package ships a PreToolUse policy hook that blocks runtime-mutating tool calls when critical drift is present, and a `verifyMemoryReference` check that confirms a memory-referenced file, symbol, or CLI flag still exists in the current repo before an agent acts on it.

## Install

```bash
npm install @lannguyensi/runtime-reality-checker
```

Requires Node.js >= 20.

## Usage

```typescript
import { runRealityCheck, hasCriticalDrift } from "@lannguyensi/runtime-reality-checker";

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

console.log(result.ready_for_diagnosis); // false - frontend is down
console.log(result.summary);             // "1 critical drift(s) found - fix before diagnosing"

if (hasCriticalDrift(result)) {
  console.log("Critical drift detected:", result.drift);
}
```

### API

| Function | Description |
|----------|-------------|
| `runRealityCheck(domain, expected, actual)` | Full reality check, returns processes, drift, and readiness |
| `checkProcesses(expected, actual)` | Compare expected vs actual process states |
| `buildDriftItems(processResults)` | Generate drift items from process comparison |
| `hasCriticalDrift(result)` | Check if any critical drift exists |
| `getCriticalDrift(result)` | Get only critical drift items |

### Types

| Type | Description |
|------|-------------|
| `ExpectedProcess` | What a process should look like (name, startup mode, port) |
| `ActualProcessState` | What a process actually looks like at runtime |
| `DriftItem` | A difference between expected and actual (severity + message) |
| `RealityCheckResult` | Full check result with processes, drift, and summary |
| `ProcessStatus` | running, stopped, unknown |
| `ProcessCheckResult` | Per-process comparison result (drift flags for state, startup, port) |
| `StartupMode` | systemd, docker, pm2, manual, cron, unknown |

## Key features

- Library API for comparing expected vs. actual process state and surfacing severity-graded drift
- A PreToolUse policy hook (PoC) that blocks a defined class of runtime-mutating tool calls on critical drift; see [PreToolUse policy reference](docs/pretooluse-policy.md)
- `verifyMemoryReference` for checking a memory-cited path, symbol, or CLI flag still exists at head; see [verify_memory_reference reference](docs/verify-memory-reference.md)

## Documentation

- [PreToolUse policy reference](docs/pretooluse-policy.md): env knobs, audit log shape, and the policy spec pointer
- [verify_memory_reference reference](docs/verify-memory-reference.md): implementation notes, defaults, and edge cases
- Exposed via MCP as the `verify_memory_reference` tool in [`grounding-mcp`](../grounding-mcp)

## Development

```bash
npm install
npm run build    # TypeScript build
npm test         # Run tests (vitest)
npm run lint     # Type check
```

## License

MIT
