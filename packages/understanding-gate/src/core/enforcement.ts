// Pure decision logic for Phase 2 enforcement: given a tool name, the
// approval state, and env, decide allow/block and explain why. No fs,
// no env reads — the adapter layer prepares all inputs.
//
// Tool deny-list semantics: any tool whose canonical name appears in
// WRITE_TOOL_NAMES is blocked unless approved. Anything else (Read,
// Grep, Glob, LS, Task, TodoWrite, …) passes the gate; this matches
// the "always-allow read-only" architecture-doc §4.6 stance.

export type EnforcementMode =
  | "disabled"        // UNDERSTANDING_GATE_DISABLE=1, gate is off
  | "force_bypass"    // valid force env present, allow + audit
  | "force_invalid"   // force flag set but reason missing/short, block
  | "readonly_tool"   // tool not in deny-list, always allowed
  | "approved"        // latest report for the session is approved
  | "no_report"       // no report yet for the active task, block
  | "not_approved";   // report present but approvalStatus !== "approved"

export type EnforcementDecision =
  | { decision: "allow"; mode: EnforcementMode; reason: string }
  | { decision: "block"; mode: EnforcementMode; reason: string };

export interface EnforcementEnv {
  UNDERSTANDING_GATE_DISABLE?: string;
  UNDERSTANDING_GATE_FORCE?: string;
  UNDERSTANDING_GATE_FORCE_REASON?: string;
}

export interface EnforcementInput {
  /** Canonical tool name as the harness reports it. */
  tool: string;
  /** Lowercased deny-list to match `tool` against. Caller controls case. */
  writeToolNames: ReadonlySet<string>;
  /** Whether a report for the active task exists at all. */
  reportExists: boolean;
  /** Whether the latest report's approvalStatus === "approved". */
  reportApproved: boolean;
  env: EnforcementEnv;
}

// Canonical Claude Code tool names that mutate state. Matched
// case-sensitively. opencode's lowercase variants are mapped at the
// adapter boundary.
export const CLAUDE_CODE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Bash",
]);

// opencode's tool registry uses lowercase names.
export const OPENCODE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "bash",
]);

const FORCE_REASON_MIN_LEN = 10;

export function decideEnforcement(input: EnforcementInput): EnforcementDecision {
  if (isTruthyEnv(input.env.UNDERSTANDING_GATE_DISABLE)) {
    return {
      decision: "allow",
      mode: "disabled",
      reason: "UNDERSTANDING_GATE_DISABLE is set; gate is off.",
    };
  }

  // Trim incidental whitespace before the deny-list lookup so a harness
  // payload like `"Edit "` or `"Edit\n"` doesn't silently fall through
  // to the read-only allow path. Case-folding is intentionally NOT
  // applied: Claude Code uses PascalCase, opencode uses lowercase, and
  // the per-adapter sets (CLAUDE_CODE_WRITE_TOOLS / OPENCODE_WRITE_TOOLS)
  // already enforce that distinction. Cross-folding would mask a
  // harness/version mistake by treating "edit" against the Claude Code
  // set as a write tool — better to surface that as a readonly allow
  // and let the caller catch it.
  const normalizedTool = input.tool.trim();
  if (!input.writeToolNames.has(normalizedTool)) {
    return {
      decision: "allow",
      mode: "readonly_tool",
      reason: `Tool "${input.tool}" is read-only and always allowed.`,
    };
  }

  if (isTruthyEnv(input.env.UNDERSTANDING_GATE_FORCE)) {
    const reason = (input.env.UNDERSTANDING_GATE_FORCE_REASON ?? "").trim();
    if (reason.length < FORCE_REASON_MIN_LEN) {
      return {
        decision: "block",
        mode: "force_invalid",
        reason: `UNDERSTANDING_GATE_FORCE is set but UNDERSTANDING_GATE_FORCE_REASON is missing or shorter than ${FORCE_REASON_MIN_LEN} characters. Provide a real reason or unset FORCE.`,
      };
    }
    return {
      decision: "allow",
      mode: "force_bypass",
      reason: `Force-bypassed (reason: ${reason}).`,
    };
  }

  if (!input.reportExists) {
    return {
      decision: "block",
      mode: "no_report",
      reason: blockMessage(
        input.tool,
        "no Understanding Report has been emitted for the active session. Emit a report (the prompt-hook injects the template), then approve it.",
      ),
    };
  }

  if (!input.reportApproved) {
    return {
      decision: "block",
      mode: "not_approved",
      reason: blockMessage(
        input.tool,
        "the latest Understanding Report for the active session is not yet approved. Run `understanding-gate approve` once the report is correct, or paste an approval phrase ('approved' / 'go ahead') so the gate can mark it.",
      ),
    };
  }

  return {
    decision: "allow",
    mode: "approved",
    reason: "Latest Understanding Report is approved.",
  };
}

function blockMessage(tool: string, why: string): string {
  return `understanding-gate: blocked tool "${tool}" because ${why}`;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}
