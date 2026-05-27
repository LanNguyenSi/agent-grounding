# runtime-reality-checker as a harness PreToolUse policy

This doc specifies the design for wiring `@lannguyensi/runtime-reality-checker` as a harness `PreToolUse` policy. It is the spec half of Phase 1 Schritt 3 of the agent-grounding plan; the PoC code lives in `packages/runtime-reality-checker/src/policy/` and the actual harness-side hook registration is a follow-up task in the `harness` project.

The point: today the checker is library-only. Nothing in a live Claude Code session ever calls `runRealityCheck` automatically. As a result, an agent can confidently issue a `docker-compose down` command on a host where half the expected services are already missing, then "diagnose" against a runtime state that no longer matches the documentation. This policy fixes that by running a drift check before destructive runtime commands, and blocking when critical drift exists.

## Trigger set

A `PreToolUse` event fires for every tool call. The policy is short-circuited to allow for tools that cannot affect runtime state (e.g. `Read`, `Grep`, MCP queries). The policy is engaged only when the tool call **matches a trigger**.

Triggers are pattern-based on `tool_name + tool_input`. The PoC ships a hard-coded default trigger set (see `src/policy/triggers.ts`); a JSON-file-based override (`RUNTIME_REALITY_TRIGGERS_FILE`) is a follow-up, not present in the PoC.

| Trigger category   | Matches when                                                                                                                                                | Rationale                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| compose-mutation   | `tool_name=Bash` AND command matches a docker / docker-compose invocation with an `up`, `down`, `restart`, `stop`, `kill`, or `rm` action (flags allowed in between) | Compose-driven services are the canonical multi-process runtime in this repo family. A drifted compose-state turns "restart" into "rebuild from wrong starting point". |
| systemctl-mutation | `tool_name=Bash` AND command matches `/systemctl(\s+--[\w=-]+)*\s+(restart|stop|disable|enable|start)\b/`                                                   | systemd-managed services on the VPS. Restarting against a wrong expected-startup-mode silently swaps `manual` for `systemd`.             |
| process-kill       | `tool_name=Bash` AND command matches `/\bkill\s+(-\d+\s+|-[A-Z]+\s+)?\d+\b/` or `pkill`                                                                     | Killing a PID that doesn't match the documented expectation usually means an out-of-band copy got started.                              |
| deploy-script      | `tool_name=Bash` AND command starts with `./deploy-` or matches `/bash\s+[^\s]*deploy[^\s]*\.sh\b/`                                                         | Repo-local deploy wrappers always touch the production process set.                                                                      |

Tool calls that don't match any trigger are passed through silently (no check, no log).

## Expectations file

Each domain (keyword) has a JSON file describing what processes are expected. Default path: `~/.runtime-reality/expectations/<keyword>.json`, override via `RUNTIME_REALITY_EXPECTATIONS_DIR`.

```json
{
  "domain": "deploy-panel",
  "processes": [
    { "name": "panel-api",      "expected_startup": "docker", "expected_port": 3001 },
    { "name": "panel-frontend", "expected_startup": "docker", "expected_port": 3000 },
    { "name": "agent-relay",    "expected_startup": "docker", "expected_port": 4040 }
  ]
}
```

The shape matches `ExpectedProcess[]` from `@lannguyensi/runtime-reality-checker`. No new types.

The keyword comes from `RUNTIME_REALITY_KEYWORD` (set by the harness wrapper) or the `grounding-mcp` session keyword if a session id is in the payload. If neither is present, the policy degrades to allow (the check has no expected baseline to compare against).

## Actuals probe

The check needs an `ActualProcessState[]`. Computing it is host-specific:

- For Docker hosts: `docker ps --format '{{json .}}'` plus port-mapping parse
- For systemd hosts: `systemctl list-units --type=service --state=running`
- For local dev: `ps -ef | grep <name>` per expected process

The PoC ships a **probe interface**, not a default probe implementation, because the right probe depends on where the policy runs. The harness-side follow-up task ships:
- A Docker probe binary that the policy calls via subprocess
- A `RUNTIME_REALITY_PROBE_CMD` env var pointing at it
- A no-probe degradation: if no probe is configured, log a warning to stderr and allow

This keeps the agent-grounding repo free of host-coupling.

## Severity to decision mapping

The library emits drift items with severity `critical | warning | info`. The policy maps them to a `PreToolUse` hookSpecificOutput decision:

| Worst drift severity | Default policy decision | Operator-overridable via |
| -------------------- | ----------------------- | ------------------------ |
| (no drift)           | `allow` (silent)        | n/a                      |
| `info`               | `allow` (silent)        | n/a                      |
| `warning`            | `allow` + stderr warning that names the drift items | `RUNTIME_REALITY_WARN_AS_BLOCK=1` to escalate |
| `critical`           | `deny` + stderr message with "fix drift before continuing" | `RUNTIME_REALITY_CRITICAL_AS_WARN=1` to degrade |
| (probe failed)       | `allow` + stderr warning | `RUNTIME_REALITY_PROBE_FAIL_BLOCK=1` |

The defaults are intentionally **fail-open**: the harness should never become a tarpit because a probe is misconfigured. The block-on-critical default exists because the cost of letting an agent operate against a wrong runtime model is usually higher than the cost of a false block (the false block can be lifted by `harness approve risk`; the false diagnosis cascades for hours).

## Concrete example: VPS compose deploy

```
Agent runs: docker-compose -f docker-compose.prod.yml restart panel-api

PreToolUse fires:
  tool_name = Bash
  tool_input.command = "docker-compose -f docker-compose.prod.yml restart panel-api"

Policy match: compose-mutation trigger

Expected (from ~/.runtime-reality/expectations/deploy-panel.json):
  - panel-api      (docker, port 3001)
  - panel-frontend (docker, port 3000)
  - agent-relay    (docker, port 4040)

Actual (from probe `docker ps --format json`):
  - panel-api      (docker, port 3001) ✓
  - agent-relay    (docker, port 4040) ✓
  - (panel-frontend not running)

Drift:
  critical: Process 'panel-frontend' expected to be running but is NOT

Decision: deny
Stderr: "runtime-reality-checker: drift detected for keyword 'deploy-panel' before 'compose-mutation' tool call
  - [critical] Process 'panel-frontend' expected to be running but is NOT
Fix drift before continuing, or `harness approve risk --reason '...'` to override."
```

The agent now has to deal with the missing frontend before issuing the restart. Without this check, the agent would restart `panel-api`, observe nothing broke, and report success while the panel is still half-down.

## harness.yaml integration snippet

The follow-up task in the harness project should add the policy under `policies.pre_tool_use`. Suggested shape, matching how `understanding-gate` is wired:

```yaml
policies:
  pre_tool_use:
    - name: runtime-reality-checker
      command: runtime-reality-policy-pre-tool-use
      tools:
        - Bash
      env:
        RUNTIME_REALITY_EXPECTATIONS_DIR: ${env.HOME}/.runtime-reality/expectations
        RUNTIME_REALITY_PROBE_CMD: ${env.HOME}/.runtime-reality/probes/docker-probe.sh
        # Optional: structured audit trail (JSONL, one line per decision).
        # Defaults to ~/.runtime-reality/audit.log.
        # RUNTIME_REALITY_AUDIT_LOG: ${env.HOME}/.runtime-reality/audit.log
        # Optional overrides
        # RUNTIME_REALITY_CRITICAL_AS_WARN: "1"
        # RUNTIME_REALITY_WARN_AS_BLOCK: "1"
```

The `command` resolves to the binary shipped by this package's PoC (`packages/runtime-reality-checker/src/policy/pre-tool-use.ts`, compiled to `dist/policy/pre-tool-use.js`, exposed as the `runtime-reality-policy-pre-tool-use` bin in package.json).

## Open questions

These are intentionally NOT decided in the PoC, they belong to the harness-side follow-up:

1. **Where does the keyword come from?** Today the spec says "env or session id". The session id route needs a grounding-mcp lookup, which means the hook depends on grounding-mcp being installed. Decide whether the hook degrades to allow when grounding-mcp is missing, or requires it.
2. **Probe failure observability.** Should probe failures be silent (current default) or surface in `friction-log`? Probably friction-log, but that adds a dep.
3. **Multi-keyword sessions.** A session that touches both `deploy-panel` and `agent-relay` would need to merge two expectations files. Out of scope for the PoC, real follow-up.
4. **Probe caching.** A fresh `docker ps` on every Bash call is 50-200ms overhead. The probe contract should declare cache-TTL; the harness wrapper can honor it.

## Out of scope

- Automatic discovery of `expected state` from running containers (would mean drift can never be detected because "expected" is whatever is running)
- Multi-host reality checks (the probe is local-host only)
- Editing the runtime-reality-checker library API itself (the policy wraps the existing surface)
- Implementing the harness-side hook registration (separate task in the `harness` project)

## Memory hooks

- Plan: [[project_agent_grounding_phase_plan_2026_05_25]] Phase 1 Schritt 3
- Cross-repo bind: [[feedback_cross_repo_pr_rejected]]
- Hook pattern reference: see `packages/understanding-gate/src/adapters/claude-code/pre-tool-use.ts` (fail-open, thin entrypoint, pure handler)
