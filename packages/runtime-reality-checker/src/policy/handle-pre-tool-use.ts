// Pure handler for the runtime-reality PreToolUse policy.
//
// Reads a PreToolUse JSON payload, optionally runs a drift check via
// an injected probe, and emits a hookSpecificOutput envelope plus
// a human-readable stderr message. The contract mirrors
// understanding-gate: every failure path degrades to allow, never block,
// so a broken policy can't tarpit the harness.
//
// Override-knobs are env-only, so the spec doc and the harness.yaml
// snippet are the only place an operator has to read to understand
// the behavior; nothing is buried in a config file the agent might
// silently ship.

import type { ActualProcessState, DriftItem, ExpectedProcess } from "../lib.js";
import { runRealityCheck } from "../lib.js";
import { matchTrigger, extractCommand, DEFAULT_TRIGGERS, type Trigger } from "./triggers.js";
import type { ExpectationsLoadResult } from "./expectations.js";

export interface PolicyEnv {
  RUNTIME_REALITY_DISABLE?: string;
  RUNTIME_REALITY_KEYWORD?: string;
  RUNTIME_REALITY_EXPECTATIONS_DIR?: string;
  /** Escalate any warning-tier drift to a block. */
  RUNTIME_REALITY_WARN_AS_BLOCK?: string;
  /** Degrade critical drift to allow + stderr warning. */
  RUNTIME_REALITY_CRITICAL_AS_WARN?: string;
  /** Block when the probe fails to produce actuals (default: allow). */
  RUNTIME_REALITY_PROBE_FAIL_BLOCK?: string;
}

export interface PolicyPayload {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  hook_event_name?: string;
}

/**
 * Probe contract: given a keyword and the expected processes, return
 * the current actual state. The handler is intentionally probe-agnostic;
 * the wrapping binary plugs in a real probe (docker ps / systemctl /
 * etc.) at composition time. Throwing is fine, the handler catches.
 */
export type Probe = (input: {
  keyword: string;
  expected: ExpectedProcess[];
}) => ActualProcessState[];

export interface HandlerDeps {
  loadExpectations: (keyword: string, dir?: string) => ExpectationsLoadResult;
  probe: Probe | null;
  triggers?: readonly Trigger[];
}

export type Decision =
  | { kind: "skip"; reason: string }
  | { kind: "allow"; reason: string }
  | { kind: "warn"; reason: string; drift: DriftItem[] }
  | { kind: "block"; reason: string; drift: DriftItem[] };

export interface HandlerResult {
  stdout: string;
  stderr: string;
  exitCode: 0 | 2;
  decision: Decision;
}

const ALLOW_SILENT_BASE = { stdout: "", stderr: "", exitCode: 0 as const };

function envOn(value: string | undefined): boolean {
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function jsonEnvelope(decision: "allow" | "deny", reason: string): string {
  // Claude Code hookSpecificOutput contract; the deny payload surfaces
  // both as a hook decision and as a user-visible reason.
  return (
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }) + "\n"
  );
}

export function handlePolicyPreToolUse(
  rawStdin: string,
  env: PolicyEnv,
  deps: HandlerDeps,
): HandlerResult {
  if (envOn(env.RUNTIME_REALITY_DISABLE)) {
    return {
      ...ALLOW_SILENT_BASE,
      decision: { kind: "skip", reason: "RUNTIME_REALITY_DISABLE set" },
    };
  }

  const payload = parsePayload(rawStdin);
  if (!payload) {
    return {
      ...ALLOW_SILENT_BASE,
      decision: { kind: "skip", reason: "malformed PreToolUse payload, degraded to allow" },
    };
  }

  const toolName = payload.tool_name ?? "";
  const command = extractCommand(payload.tool_input);
  if (!toolName || !command) {
    return {
      ...ALLOW_SILENT_BASE,
      decision: { kind: "skip", reason: "no tool_name or command, nothing to gate" },
    };
  }

  const trigger = matchTrigger({ toolName, command }, deps.triggers ?? DEFAULT_TRIGGERS);
  if (!trigger) {
    return {
      ...ALLOW_SILENT_BASE,
      decision: { kind: "skip", reason: "no policy trigger matched" },
    };
  }

  const keyword = env.RUNTIME_REALITY_KEYWORD?.trim();
  if (!keyword) {
    return {
      ...ALLOW_SILENT_BASE,
      decision: { kind: "skip", reason: "no RUNTIME_REALITY_KEYWORD set, baseline unknown" },
    };
  }

  const loaded = deps.loadExpectations(keyword, env.RUNTIME_REALITY_EXPECTATIONS_DIR);
  if (!loaded.ok) {
    return {
      stdout: "",
      stderr: `runtime-reality-checker: expectations load failed (${loaded.reason}), degraded to allow\n`,
      exitCode: 0,
      decision: {
        kind: "skip",
        reason: `expectations load failed: ${loaded.reason}${loaded.detail ? ` (${loaded.detail})` : ""}`,
      },
    };
  }

  if (!deps.probe) {
    if (envOn(env.RUNTIME_REALITY_PROBE_FAIL_BLOCK)) {
      const reason = "no probe configured (RUNTIME_REALITY_PROBE_FAIL_BLOCK is set)";
      return {
        stdout: jsonEnvelope("deny", reason),
        stderr: `runtime-reality-checker: ${reason}, blocking\n`,
        exitCode: 2,
        decision: { kind: "block", reason, drift: [] },
      };
    }
    return {
      stdout: "",
      stderr: "runtime-reality-checker: no probe configured, degraded to allow\n",
      exitCode: 0,
      decision: { kind: "skip", reason: "no probe configured" },
    };
  }

  let actual: ActualProcessState[];
  try {
    actual = deps.probe({ keyword, expected: loaded.file.processes });
  } catch (err) {
    const blockOnFail = envOn(env.RUNTIME_REALITY_PROBE_FAIL_BLOCK);
    return {
      stdout: blockOnFail ? jsonEnvelope("deny", `probe failed: ${String(err)}`) : "",
      stderr: `runtime-reality-checker: probe threw (${String(err)}), ${blockOnFail ? "blocking" : "degraded to allow"}\n`,
      exitCode: blockOnFail ? 2 : 0,
      decision: blockOnFail
        ? { kind: "block", reason: `probe failed: ${String(err)}`, drift: [] }
        : { kind: "skip", reason: `probe failed: ${String(err)}` },
    };
  }

  const result = runRealityCheck(keyword, loaded.file.processes, actual);
  const worstSeverity = severityRank(result.drift);

  if (worstSeverity === 0) {
    return {
      ...ALLOW_SILENT_BASE,
      decision: { kind: "allow", reason: `runtime matches expectations (${result.processes.length} process(es))` },
    };
  }

  const driftLines = result.drift.map((d) => `  - [${d.severity}] ${d.message}`).join("\n");
  const head = `runtime-reality-checker: drift detected for keyword '${keyword}' before '${trigger.category}' tool call`;
  const fullMessage = `${head}\n${driftLines}`;

  if (worstSeverity === 1) {
    if (envOn(env.RUNTIME_REALITY_WARN_AS_BLOCK)) {
      return {
        stdout: jsonEnvelope("deny", fullMessage),
        stderr: `${fullMessage}\n(blocking because RUNTIME_REALITY_WARN_AS_BLOCK is set)\n`,
        exitCode: 2,
        decision: { kind: "block", reason: fullMessage, drift: result.drift },
      };
    }
    return {
      stdout: "",
      stderr: `${fullMessage}\n`,
      exitCode: 0,
      decision: { kind: "warn", reason: fullMessage, drift: result.drift },
    };
  }

  // worstSeverity === 2 (critical)
  if (envOn(env.RUNTIME_REALITY_CRITICAL_AS_WARN)) {
    return {
      stdout: "",
      stderr: `${fullMessage}\n(allowing because RUNTIME_REALITY_CRITICAL_AS_WARN is set)\n`,
      exitCode: 0,
      decision: { kind: "warn", reason: fullMessage, drift: result.drift },
    };
  }
  return {
    stdout: jsonEnvelope("deny", fullMessage),
    stderr: `${fullMessage}\nFix drift before continuing, or 'harness approve risk --reason "..."' to override.\n`,
    exitCode: 2,
    decision: { kind: "block", reason: fullMessage, drift: result.drift },
  };
}

function severityRank(drift: DriftItem[]): 0 | 1 | 2 {
  let r: 0 | 1 | 2 = 0;
  for (const d of drift) {
    if (d.severity === "critical") return 2;
    if (d.severity === "warning") r = 1;
  }
  return r;
}

function parsePayload(raw: string): PolicyPayload | null {
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
    return obj as PolicyPayload;
  } catch {
    return null;
  }
}
