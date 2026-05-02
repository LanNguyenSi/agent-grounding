// Pure handler for the Claude Code `PreToolUse` hook. Reads the JSON
// payload, looks up the latest persisted report for the active task,
// and emits a hookSpecificOutput envelope with permissionDecision=deny
// when the gate decides to block.
//
// Phase 2 contract: a "blocked" decision is loud (stderr message + the
// JSON envelope). An "allowed" decision is silent (no stdout, exit 0)
// to keep PreToolUse latency cheap on the hot path. Failures degrade
// to "allow" (silent) so a broken gate never holds up legitimate work
// — security-noisy by design but never a tarpit.

import type { ReportEntry } from "../../core/persistence.js";
import {
  CLAUDE_CODE_WRITE_TOOLS,
  decideEnforcement,
  type EnforcementDecision,
} from "../../core/enforcement.js";
import { findLatestForTask, isApproved } from "../../core/approval.js";
import type { AuditEvent } from "../../core/audit.js";

const HOOK_EVENT_NAME = "PreToolUse";

export interface PreToolUseEnv {
  UNDERSTANDING_GATE_DISABLE?: string;
  UNDERSTANDING_GATE_FORCE?: string;
  UNDERSTANDING_GATE_FORCE_REASON?: string;
  UNDERSTANDING_GATE_TASK_ID?: string;
  UNDERSTANDING_GATE_REPORT_DIR?: string;
}

export interface PreToolUsePayload {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  hook_event_name?: string;
}

export interface PreToolUseDeps {
  /** List persisted reports for the gate's report dir. */
  listReports: (opts: { cwd?: string; dir?: string }) => ReportEntry[];
  /** "now" injection so audit timestamps are stable in tests. */
  now: () => Date;
  /** Append an audit event. Called for block / force_bypass paths. */
  appendAudit: (cwd: string, event: AuditEvent) => void;
}

export interface PreToolUseResult {
  stdout: string;
  stderr: string;
  exitCode: 0 | 2;
  decision: EnforcementDecision;
  /** True if the input was malformed and we degraded to "allow + silent". */
  degraded: boolean;
}

const ALLOW_SILENT: Omit<PreToolUseResult, "decision"> = {
  stdout: "",
  stderr: "",
  exitCode: 0,
  degraded: false,
};

export function handlePreToolUse(
  rawStdin: string,
  env: PreToolUseEnv,
  deps: PreToolUseDeps,
): PreToolUseResult {
  const payload = parsePayload(rawStdin);
  if (!payload) {
    // Malformed input: degrade to allow. The gate never crashes the
    // harness; a real misuse (force flag without reason) still blocks
    // because that path runs after we have a payload, but a broken hook
    // input (rare) cannot be turned into a block.
    return {
      ...ALLOW_SILENT,
      decision: {
        decision: "allow",
        mode: "disabled",
        reason: "Malformed PreToolUse payload; gate degraded to allow.",
      },
      degraded: true,
    };
  }

  const tool = payload.tool_name ?? "";
  if (!tool) {
    return {
      ...ALLOW_SILENT,
      decision: {
        decision: "allow",
        mode: "readonly_tool",
        reason: "PreToolUse payload had no tool_name; nothing to gate.",
      },
      degraded: true,
    };
  }

  const cwd = payload.cwd ?? process.cwd();
  const sessionId = payload.session_id ?? null;
  const taskId = env.UNDERSTANDING_GATE_TASK_ID || sessionId || "";

  let entries: ReportEntry[] = [];
  try {
    entries = deps.listReports({
      cwd,
      dir: env.UNDERSTANDING_GATE_REPORT_DIR || undefined,
    });
  } catch {
    // listReports failure (e.g. permission denied on the dir) → degrade.
    entries = [];
  }
  const latest = taskId ? findLatestForTask(entries, taskId) : null;

  const decision = decideEnforcement({
    tool,
    writeToolNames: CLAUDE_CODE_WRITE_TOOLS,
    reportExists: latest !== null,
    reportApproved: isApproved(latest),
    env: {
      UNDERSTANDING_GATE_DISABLE: env.UNDERSTANDING_GATE_DISABLE,
      UNDERSTANDING_GATE_FORCE: env.UNDERSTANDING_GATE_FORCE,
      UNDERSTANDING_GATE_FORCE_REASON: env.UNDERSTANDING_GATE_FORCE_REASON,
    },
  });

  // Audit side-effects. Best-effort: never let an audit-write failure
  // change the decision the gate already made. Force-bypass + block are
  // both logged; pure-allow on read-only tools is not, to keep volume
  // sane in chatty sessions.
  if (decision.mode === "force_bypass") {
    safeAudit(deps, cwd, {
      kind: "force_bypass",
      tool,
      reason: decision.reason,
      sessionId,
      taskId: taskId || null,
      adapter: "claude-code",
    });
  } else if (decision.decision === "block") {
    safeAudit(deps, cwd, {
      kind: "block",
      tool,
      reason: decision.reason,
      sessionId,
      taskId: taskId || null,
      adapter: "claude-code",
    });
  }

  if (decision.decision === "allow") {
    return { ...ALLOW_SILENT, decision };
  }

  const stdout = `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: HOOK_EVENT_NAME,
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason,
    },
  })}\n`;
  // exit 2 is the canonical "block" code for Claude Code; the JSON
  // envelope is the modern stdout contract. Emitting both makes the
  // hook robust across older + newer harness releases.
  return {
    stdout,
    stderr: `${decision.reason}\n`,
    exitCode: 2,
    decision,
    degraded: false,
  };
}

function parsePayload(raw: string): PreToolUsePayload | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as PreToolUsePayload;
}

function safeAudit(deps: PreToolUseDeps, cwd: string, event: AuditEvent): void {
  try {
    deps.appendAudit(cwd, event);
  } catch {
    // ignore: audit-write failure must never change enforcement outcome.
  }
}
