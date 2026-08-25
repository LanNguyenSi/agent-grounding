// Pure handler: takes raw stdin + env, returns the string to write on stdout.
// Empty string means "stay silent" (Claude Code accepts empty stdout + exit 0).
// All defensive: any failure mode degrades to "" so the hook never crashes
// the harness. Phase 0 is non-blocking by design.

import { isTaskLike } from "../../classifier.js";
import { pickMode } from "../../mode.js";
import { getPromptSnippet } from "../../prompts.js";
import { isPaused } from "./pause.js";

interface ClaudeCodeHookEnv {
  UNDERSTANDING_GATE_DISABLE?: string;
  UNDERSTANDING_GATE_MODE?: string;
  /**
   * Path to a pause-sentinel JSON file (shape: {pausedAt, expiresAt,
   * reason, pausedBy}). Read-only: this package never writes or deletes
   * the file, and auto-resume cleanup is whatever produces the sentinel's
   * job, not this hook's. Unset means "no pause check at all" so the
   * package stays standalone-runnable without any external sentinel
   * writer on disk.
   */
  UNDERSTANDING_GATE_PAUSE_FILE?: string;
}

interface HookInput {
  prompt?: unknown;
}

const HOOK_EVENT_NAME = "UserPromptSubmit";

// Claude Code delivers a task-notification wrapper as the `prompt` field
// on subagent-completion turns, not just genuine operator input. Match it
// as a PREFIX (after leading whitespace) so an operator who happens to
// type the words "task-notification" mid-message still gets gated; only a
// prompt that actually BEGINS with the tag is treated as this wrapper.
const TASK_NOTIFICATION_HULL = /^\s*<task-notification(?:[\s/>]|$)/;

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function isTaskNotificationHull(prompt: string): boolean {
  return TASK_NOTIFICATION_HULL.test(prompt);
}

// isPaused (and its sentinel shape / stale-sentinel diagnostic) now live
// in ./pause.js -- a leaf module with no dependency on this file's
// classifier/prompt/mode import graph -- so the PreToolUse hot path
// (handle-pre-tool-use.ts) can import just the pause reader without
// pulling in prompt-injection machinery it never uses. See pause.ts for
// the full semantics of the sentinel shape and the indefinite-pause
// stderr diagnostic.

export function handleUserPromptSubmit(
  rawStdin: string,
  env: ClaudeCodeHookEnv = {},
): string {
  if (isTruthyEnv(env.UNDERSTANDING_GATE_DISABLE)) return "";
  if (isPaused(env.UNDERSTANDING_GATE_PAUSE_FILE)) return "";

  let parsed: unknown;
  try {
    parsed = rawStdin ? (JSON.parse(rawStdin) as unknown) : {};
  } catch {
    return "";
  }
  // JSON.parse can return null, primitives, or arrays, none of which carry
  // a `.prompt` property. Guard so property access never throws (a TypeError
  // here would surface on stderr and pollute the harness diagnostic stream).
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "";
  }

  const promptValue = (parsed as HookInput).prompt;
  const prompt = typeof promptValue === "string" ? promptValue : "";
  if (!prompt) return "";
  if (isTaskNotificationHull(prompt)) return "";
  if (!isTaskLike(prompt)) return "";

  const mode = pickMode(prompt, {
    UNDERSTANDING_GATE_MODE: env.UNDERSTANDING_GATE_MODE,
  });
  const snippet = getPromptSnippet(mode);

  const wrapped = `<understanding-gate mode="${mode}">\n${snippet}\n</understanding-gate>`;

  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: HOOK_EVENT_NAME,
      additionalContext: wrapped,
    },
  })}\n`;
}
