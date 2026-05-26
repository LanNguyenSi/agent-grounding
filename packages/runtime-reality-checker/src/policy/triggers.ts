// Pattern-based trigger detection for the PreToolUse policy.
//
// A trigger is matched against a (tool_name, tool_input) pair from a
// PreToolUse hook payload. When nothing matches, the policy is a no-op
// for that call. The trigger set is small and conservative on purpose,
// matching too eagerly turns the gate into a tarpit.
//
// See docs/policy-runtime-reality.md for the rationale per category.

export type TriggerCategory =
  | "compose-mutation"
  | "systemctl-mutation"
  | "process-kill"
  | "deploy-script";

export interface Trigger {
  category: TriggerCategory;
  /** Tool names this trigger applies to (case-sensitive). */
  toolNames: readonly string[];
  /** Regex tested against the command string in tool_input. */
  commandPattern: RegExp;
}

export const DEFAULT_TRIGGERS: readonly Trigger[] = [
  {
    category: "compose-mutation",
    // Allow arbitrary flags / file args between `docker compose` and the
    // mutating action (e.g. `-f compose.yml`, `--project-name foo`). The
    // pattern still anchors on a docker/compose verb so plain `docker ps`
    // or `docker exec` doesn't trip it.
    toolNames: ["Bash"],
    commandPattern: /(docker[- ]compose|docker)\s.+?\s(up|down|restart|stop|kill|rm)\b|(docker[- ]compose|docker)\s+(up|down|restart|stop|kill|rm)\b/,
  },
  {
    category: "systemctl-mutation",
    toolNames: ["Bash"],
    commandPattern: /systemctl(\s+--[\w=-]+)*\s+(restart|stop|disable|enable|start)\b/,
  },
  {
    category: "process-kill",
    toolNames: ["Bash"],
    commandPattern: /(\bkill\s+(-\d+\s+|-[A-Z]+\s+)?\d+\b|\bpkill\b)/,
  },
  {
    category: "deploy-script",
    toolNames: ["Bash"],
    commandPattern: /(^|\s)(\.\/deploy[-_][\w.-]+|bash\s+[^\s]*deploy[^\s]*\.sh\b)/,
  },
];

export interface ToolCall {
  toolName: string;
  command: string;
}

export function matchTrigger(
  call: ToolCall,
  triggers: readonly Trigger[] = DEFAULT_TRIGGERS,
): Trigger | null {
  for (const t of triggers) {
    if (!t.toolNames.includes(call.toolName)) continue;
    if (t.commandPattern.test(call.command)) return t;
  }
  return null;
}

/**
 * Extract a Bash command string from a PreToolUse payload's tool_input.
 * Returns empty string when the shape doesn't match (caller handles).
 */
export function extractCommand(toolInput: unknown): string {
  if (typeof toolInput !== "object" || toolInput === null) return "";
  const obj = toolInput as Record<string, unknown>;
  const cmd = obj.command;
  return typeof cmd === "string" ? cmd : "";
}
