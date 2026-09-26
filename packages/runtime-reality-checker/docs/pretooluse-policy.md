# PreToolUse policy (PoC)

Moved out of the package README during the README restructure; the substance is unchanged.

Beyond the library API, this package ships a PreToolUse policy hook that runs `runRealityCheck` before a defined class of runtime-mutating tool calls (compose / systemctl / kill / deploy script) and blocks when critical drift is present. The agent-grounding repo owns the policy and the spec at [`docs/policy-runtime-reality.md`](../../../docs/policy-runtime-reality.md), the harness side registers the hook (separate follow-up task).

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

The package binary `runtime-reality-policy-pre-tool-use` is a thin wrapper that ships without a probe (degrades to allow, or blocks if `RUNTIME_REALITY_PROBE_FAIL_BLOCK=1`). The full integration plus probe lives in the harness-side follow-up. The planned probe-registration knob `RUNTIME_REALITY_PROBE_CMD` (referenced in source comments and the policy spec) is **not yet read by this package**; it is reserved for that harness-side wiring, so do not rely on it today.

Env knobs:

| Variable | Effect |
| --- | --- |
| `RUNTIME_REALITY_DISABLE=1` | Skip all checks (silent) |
| `RUNTIME_REALITY_KEYWORD=<domain>` | Look up `<domain>.json` under the expectations dir |
| `RUNTIME_REALITY_EXPECTATIONS_DIR=<path>` | Override default `~/.runtime-reality/expectations/` |
| `RUNTIME_REALITY_WARN_AS_BLOCK=1` | Treat warning-tier drift as a block |
| `RUNTIME_REALITY_CRITICAL_AS_WARN=1` | Degrade critical drift to a warn (audit only) |
| `RUNTIME_REALITY_PROBE_FAIL_BLOCK=1` | Block when no probe is configured or the probe throws |
| `RUNTIME_REALITY_TRIGGERS_FILE=<path>` | Override the default trigger set with a JSON array of `{ toolNames, commandPattern, category }`; an unreadable or invalid file degrades to the built-in default set with a stderr warning |
| `RUNTIME_REALITY_AUDIT_LOG=<path>` | Append a JSONL audit line per decision (block, warn, skip-noprobe, probe-fail, disabled) to this file. Defaults to `~/.runtime-reality/audit.log`. Prefer an absolute path, relative values resolve against the hook process cwd (which is operator-set, not stable across invocations). |

See the spec for the full trigger set, severity-to-decision matrix, and a worked VPS-compose example.

The audit log is append-only and per-line atomic under POSIX append, so concurrent hook invocations interleave at line granularity. Each line carries `kind`, `iso_timestamp`, `keyword`, `tool_name`, `command`, `trigger_category`, `drift_count`, `severity` (`warning` / `critical` / `null`), `env_overrides_applied` (snapshot of every knob the handler honored on the call), and `reason`. Skip branches that only mean "not enough info to gate" (no trigger match, missing keyword, malformed payload) are intentionally not audited.
