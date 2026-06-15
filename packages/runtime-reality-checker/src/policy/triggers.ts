// Pattern-based trigger detection for the PreToolUse policy.
//
// A trigger is matched against a (tool_name, tool_input) pair from a
// PreToolUse hook payload. When nothing matches, the policy is a no-op
// for that call. The trigger set is small and conservative on purpose,
// matching too eagerly turns the gate into a tarpit.
//
// See docs/policy-runtime-reality.md for the rationale per category.

import { existsSync, readFileSync, statSync } from "node:fs";

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

// ---------------------------------------------------------------------------
// Operator-overridable trigger file loader
// ---------------------------------------------------------------------------

/** Max bytes we'll read from a triggers JSON file. Same cap as expectations. */
export const MAX_TRIGGERS_BYTES = 1_048_576; // 1 MiB

export type TriggersLoadResult =
  | { ok: true; triggers: Trigger[] }
  | {
      ok: false;
      reason: "not_found" | "invalid_json" | "invalid_shape" | "invalid_regex" | "io_error";
      detail?: string;
    };

const VALID_CATEGORIES: readonly TriggerCategory[] = [
  "compose-mutation",
  "systemctl-mutation",
  "process-kill",
  "deploy-script",
];

function isTriggerCategory(value: string): value is TriggerCategory {
  return (VALID_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Parse raw JSON text into a TriggersLoadResult. The expected shape is a
 * non-empty JSON array where each element has:
 *   { toolNames: string[] (non-empty), commandPattern: string, category: TriggerCategory }
 */
export function parseTriggersFile(raw: string): TriggersLoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: "invalid_json", detail: String(err) };
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: false, reason: "invalid_shape", detail: "root must be a non-empty array" };
  }

  const triggers: Trigger[] = [];

  for (let i = 0; i < parsed.length; i += 1) {
    const elem = parsed[i];
    if (typeof elem !== "object" || elem === null || Array.isArray(elem)) {
      return { ok: false, reason: "invalid_shape", detail: `[${i}] is not an object` };
    }
    const obj = elem as Record<string, unknown>;

    // toolNames: non-empty string[]
    if (!Array.isArray(obj.toolNames) || obj.toolNames.length === 0) {
      return {
        ok: false,
        reason: "invalid_shape",
        detail: `[${i}].toolNames must be a non-empty array`,
      };
    }
    for (let j = 0; j < obj.toolNames.length; j += 1) {
      if (typeof obj.toolNames[j] !== "string") {
        return {
          ok: false,
          reason: "invalid_shape",
          detail: `[${i}].toolNames[${j}] is not a string`,
        };
      }
    }

    // commandPattern: must be a string
    if (typeof obj.commandPattern !== "string") {
      return {
        ok: false,
        reason: "invalid_shape",
        detail: `[${i}].commandPattern must be a string`,
      };
    }

    // category: must be one of the four TriggerCategory values
    if (typeof obj.category !== "string") {
      return {
        ok: false,
        reason: "invalid_shape",
        detail: `[${i}].category must be a string`,
      };
    }
    if (!isTriggerCategory(obj.category)) {
      return {
        ok: false,
        reason: "invalid_shape",
        detail: `[${i}].category "${obj.category}" is not a valid TriggerCategory`,
      };
    }

    // Compile the commandPattern regex
    let compiled: RegExp;
    try {
      compiled = new RegExp(obj.commandPattern);
    } catch (err) {
      return {
        ok: false,
        reason: "invalid_regex",
        detail: `[${i}].commandPattern "${obj.commandPattern}": ${String(err)}`,
      };
    }

    triggers.push({
      category: obj.category,
      toolNames: obj.toolNames as string[],
      commandPattern: compiled,
    });
  }

  return { ok: true, triggers };
}

/**
 * Load a triggers JSON file from the given path.
 * Returns not_found when the path does not exist, io_error on read failure,
 * and delegates to parseTriggersFile for shape/regex validation.
 */
export function loadTriggersFile(path: string): TriggersLoadResult {
  if (!existsSync(path)) {
    return { ok: false, reason: "not_found" };
  }
  let raw: string;
  try {
    const stat = statSync(path);
    if (stat.size > MAX_TRIGGERS_BYTES) {
      return {
        ok: false,
        reason: "io_error",
        detail: `triggers file exceeds ${MAX_TRIGGERS_BYTES} byte cap (was ${stat.size})`,
      };
    }
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, reason: "io_error", detail: String(err) };
  }
  return parseTriggersFile(raw);
}

/**
 * Pure resolver: given an optional RUNTIME_REALITY_TRIGGERS_FILE path, return
 * the trigger set to use and an optional warning string. When the path is
 * unset or empty, returns DEFAULT_TRIGGERS with no warning. On a load/parse
 * failure, falls back to DEFAULT_TRIGGERS and includes a warning for the
 * caller to write to stderr.
 */
export function resolveTriggers(triggersFilePath: string | undefined): {
  triggers: readonly Trigger[];
  warning?: string;
} {
  if (!triggersFilePath || triggersFilePath.trim() === "") {
    return { triggers: DEFAULT_TRIGGERS };
  }
  const result = loadTriggersFile(triggersFilePath);
  if (result.ok) {
    return { triggers: result.triggers };
  }
  const detail = result.detail ? `: ${result.detail}` : "";
  return {
    triggers: DEFAULT_TRIGGERS,
    warning: `runtime-reality-checker: triggers file load failed (${result.reason}${detail}), using default trigger set`,
  };
}

// ---------------------------------------------------------------------------

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
