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
import type {
  AppendAudit,
  AuditEnvOverrides,
  AuditEvent,
  AuditEventKind,
  AuditSeverity,
} from "./audit.js";

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
  /**
   * Optional structured-audit sink. Called once per *decision-bearing*
   * branch (block / warn / skip-noprobe / probe-fail / disabled). Skip
   * branches that just mean "not enough info to decide" (no trigger
   * match, missing keyword, malformed payload) are intentionally NOT
   * audited, they fire too often to be useful and carry no operator
   * signal. When the dep is omitted the handler is silent, mirroring
   * the understanding-gate pattern.
   */
  appendAudit?: AppendAudit;
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
  const auditEnv: AuditEnvOverrides = {
    disable: envOn(env.RUNTIME_REALITY_DISABLE),
    warn_as_block: envOn(env.RUNTIME_REALITY_WARN_AS_BLOCK),
    critical_as_warn: envOn(env.RUNTIME_REALITY_CRITICAL_AS_WARN),
    probe_fail_block: envOn(env.RUNTIME_REALITY_PROBE_FAIL_BLOCK),
  };

  const emitAudit = (
    kind: AuditEventKind,
    fields: {
      keyword?: string | null;
      tool_name?: string | null;
      command?: string | null;
      trigger_category?: string | null;
      drift_count?: number;
      severity?: AuditSeverity;
      reason: string;
    },
  ): void => {
    if (!deps.appendAudit) return;
    const event: AuditEvent = {
      kind,
      iso_timestamp: new Date().toISOString(),
      keyword: fields.keyword ?? null,
      tool_name: fields.tool_name ?? null,
      command: fields.command ?? null,
      trigger_category: fields.trigger_category ?? null,
      drift_count: fields.drift_count ?? 0,
      severity: fields.severity ?? null,
      env_overrides_applied: auditEnv,
      reason: fields.reason,
    };
    try {
      deps.appendAudit(event);
    } catch {
      // best-effort, see audit.ts file-level comment
    }
  };

  if (auditEnv.disable) {
    emitAudit("disabled", { reason: "RUNTIME_REALITY_DISABLE set" });
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
    if (auditEnv.probe_fail_block) {
      const reason = "no probe configured (RUNTIME_REALITY_PROBE_FAIL_BLOCK is set)";
      emitAudit("probe-fail", {
        keyword,
        tool_name: toolName,
        command,
        trigger_category: trigger.category,
        reason,
      });
      return {
        stdout: jsonEnvelope("deny", reason),
        stderr: `runtime-reality-checker: ${reason}, blocking\n`,
        exitCode: 2,
        decision: { kind: "block", reason, drift: [] },
      };
    }
    emitAudit("skip-noprobe", {
      keyword,
      tool_name: toolName,
      command,
      trigger_category: trigger.category,
      reason: "no probe configured",
    });
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
    const blockOnFail = auditEnv.probe_fail_block;
    const reason = `probe failed: ${String(err)}`;
    emitAudit("probe-fail", {
      keyword,
      tool_name: toolName,
      command,
      trigger_category: trigger.category,
      reason,
    });
    return {
      stdout: blockOnFail ? jsonEnvelope("deny", reason) : "",
      stderr: `runtime-reality-checker: probe threw (${String(err)}), ${blockOnFail ? "blocking" : "degraded to allow"}\n`,
      exitCode: blockOnFail ? 2 : 0,
      decision: blockOnFail
        ? { kind: "block", reason, drift: [] }
        : { kind: "skip", reason },
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
    if (auditEnv.warn_as_block) {
      emitAudit("block", {
        keyword,
        tool_name: toolName,
        command,
        trigger_category: trigger.category,
        drift_count: result.drift.length,
        severity: "warning",
        reason: fullMessage,
      });
      return {
        stdout: jsonEnvelope("deny", fullMessage),
        stderr: `${fullMessage}\n(blocking because RUNTIME_REALITY_WARN_AS_BLOCK is set)\n`,
        exitCode: 2,
        decision: { kind: "block", reason: fullMessage, drift: result.drift },
      };
    }
    emitAudit("warn", {
      keyword,
      tool_name: toolName,
      command,
      trigger_category: trigger.category,
      drift_count: result.drift.length,
      severity: "warning",
      reason: fullMessage,
    });
    return {
      stdout: "",
      stderr: `${fullMessage}\n`,
      exitCode: 0,
      decision: { kind: "warn", reason: fullMessage, drift: result.drift },
    };
  }

  // worstSeverity === 2 (critical)
  if (auditEnv.critical_as_warn) {
    emitAudit("warn", {
      keyword,
      tool_name: toolName,
      command,
      trigger_category: trigger.category,
      drift_count: result.drift.length,
      severity: "critical",
      reason: fullMessage,
    });
    return {
      stdout: "",
      stderr: `${fullMessage}\n(allowing because RUNTIME_REALITY_CRITICAL_AS_WARN is set)\n`,
      exitCode: 0,
      decision: { kind: "warn", reason: fullMessage, drift: result.drift },
    };
  }
  emitAudit("block", {
    keyword,
    tool_name: toolName,
    command,
    trigger_category: trigger.category,
    drift_count: result.drift.length,
    severity: "critical",
    reason: fullMessage,
  });
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
