# runtime-reality-checker

Compares actual runtime state against documentation and assumptions. Surfaces drift between what's documented and what's actually running, prevents agents from diagnosing based on stale or incorrect system models.

## Install

```bash
npm install @lannguyensi/runtime-reality-checker
```

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

console.log(result.ready_for_diagnosis); // false — frontend is down
console.log(result.summary);             // "1 critical drift(s) found — fix before diagnosing"

if (hasCriticalDrift(result)) {
  console.log("Critical drift detected:", result.drift);
}
```

## API

| Function | Description |
|----------|-------------|
| `runRealityCheck(domain, expected, actual)` | Full reality check, returns processes, drift, and readiness |
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

## PreToolUse policy (PoC)

Beyond the library API, this package ships a PreToolUse policy hook that runs `runRealityCheck` before a defined class of runtime-mutating tool calls (compose / systemctl / kill / deploy script) and blocks when critical drift is present. The agent-grounding repo owns the policy and the spec at [`docs/policy-runtime-reality.md`](../../docs/policy-runtime-reality.md), the harness side registers the hook (separate follow-up task).

```typescript
import { handlePolicyPreToolUse, type Probe } from "@lannguyensi/runtime-reality-checker/policy";

// In a wrapper binary or test:
const probe: Probe = ({ keyword, expected }) => {
  // Run `docker ps`, `systemctl list-units`, etc. Return ActualProcessState[].
  return [/* ... */];
};

const result = handlePolicyPreToolUse(stdinJson, process.env, {
  loadExpectations,
  probe,
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (result.exitCode !== 0) process.exit(result.exitCode);
```

The package binary `runtime-reality-policy-pre-tool-use` is a thin wrapper that ships without a probe (degrades to allow, or blocks if `RUNTIME_REALITY_PROBE_FAIL_BLOCK=1`). The full integration plus probe lives in the harness-side follow-up.

Env knobs:

| Variable | Effect |
| --- | --- |
| `RUNTIME_REALITY_DISABLE=1` | Skip all checks (silent) |
| `RUNTIME_REALITY_KEYWORD=<domain>` | Look up `<domain>.json` under the expectations dir |
| `RUNTIME_REALITY_EXPECTATIONS_DIR=<path>` | Override default `~/.runtime-reality/expectations/` |
| `RUNTIME_REALITY_WARN_AS_BLOCK=1` | Treat warning-tier drift as a block |
| `RUNTIME_REALITY_CRITICAL_AS_WARN=1` | Degrade critical drift to a warn (audit only) |
| `RUNTIME_REALITY_PROBE_FAIL_BLOCK=1` | Block when no probe is configured or the probe throws |
| `RUNTIME_REALITY_AUDIT_LOG=<path>` | Append a JSONL audit line per decision (block, warn, skip-noprobe, probe-fail, disabled) to this file. Defaults to `~/.runtime-reality/audit.log`. |

See the spec for the full trigger set, severity-to-decision matrix, and a worked VPS-compose example.

The audit log is append-only and per-line atomic under POSIX append, so concurrent hook invocations interleave at line granularity. Each line carries `kind`, `iso_timestamp`, `keyword`, `tool_name`, `command`, `trigger_category`, `drift_count`, `severity` (`warning` / `critical` / `null`), `env_overrides_applied` (snapshot of every knob the handler honored on the call), and `reason`. Skip branches that only mean "not enough info to gate" (no trigger match, missing keyword, malformed payload) are intentionally not audited.

## verify_memory_reference

A memory that names a concrete file, symbol, or CLI flag is making a
claim about the current repo state. Files get renamed, symbols get
deleted, never-merged PRs leave phantom references, and a memory
written months ago has no way to catch up on its own. `CLAUDE.md`
mandates that an agent verify such references *before* recommending
anything based on a memory (see the "Before recommending from memory"
section).

`verifyMemoryReference` does that check in-process:

```typescript
import { verifyMemoryReference } from "@lannguyensi/runtime-reality-checker";

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

- No runtime dependencies, native `fs` recursion + `RegExp`. Walks a
  typical mid-size repo in ~100 ms.
- Default ignores: `node_modules`, `dist`, `build`, `.git`, `.next`,
  `coverage`, `.venv`, `__pycache__`, `.turbo`, `.cache`.
- Default extensions (symbol/flag): `ts`, `tsx`, `mts`, `mjs`, `js`,
  `jsx`, `py`, `go`, `rs`, `java`. Override via `VerifyOptions.extensions`.
- Cap via `VerifyOptions.maxFiles` (default 5000): the `summary` flags
  truncation so the caller can raise the cap on a larger repo.
- Never throws: unreadable `repoRoot` returns `{ exists: false }`.
- `kind:'flag'` uses a word-boundary guard: `-v` does **not** match
  inside `--verbose`, and `--force` does **not** match inside
  `--force-with-lease`. The guard treats dash-or-word as the token
  boundary, so flag tokens are matched in isolation.
- `kind:'path'` on a *relative* value refuses to check paths that
  resolve outside `repoRoot` (traversal like `../../etc/passwd` →
  `exists:false` with a clear summary). Absolute values pass through
  unchanged, use that when the caller legitimately wants to check
  something outside the repo.
- **Symlink cycles are safe.** The walker uses `lstat` to classify
  directory symlinks out of the descent and canonicalises each
  visited directory via `realpath` so hard-link/loop fixtures cannot
  run the walker forever.
- **No-extension files** (`Makefile`, `Dockerfile`, `LICENSE`, etc.)
  are **off by default**. Opt in via `VerifyOptions.includeNoExtension: true`
  to scan them all, or pass `VerifyOptions.extraNoExtensionNames: ['Makefile']`
  to opt in by name only.

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
