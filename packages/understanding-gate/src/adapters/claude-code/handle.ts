// Pure handler: takes raw stdin + env, returns the string to write on stdout.
// Empty string means "stay silent" (Claude Code accepts empty stdout + exit 0).
// All defensive: any failure mode degrades to "" so the hook never crashes
// the harness. Phase 0 is non-blocking by design.

import { isTaskLike } from "../../classifier.js";
import { pickMode } from "../../mode.js";
import { getPromptSnippet } from "../../prompts.js";

interface ClaudeCodeHookEnv {
  UNDERSTANDING_GATE_DISABLE?: string;
  UNDERSTANDING_GATE_MODE?: string;
}

interface HookInput {
  prompt?: unknown;
}

const HOOK_EVENT_NAME = "UserPromptSubmit";

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function handleUserPromptSubmit(
  rawStdin: string,
  env: ClaudeCodeHookEnv = {},
): string {
  if (isTruthyEnv(env.UNDERSTANDING_GATE_DISABLE)) return "";

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
