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

## Development

```bash
npm install
npm run build    # TypeScript build
npm test         # Run tests (vitest)
npm run lint     # Type check
```
