// Pure handler: takes raw stdin + env, returns the string to write on stdout.
// Empty string means "stay silent" (Claude Code accepts empty stdout + exit 0).
// All defensive: any failure mode degrades to "" so the hook never crashes
// the harness. Phase 0 is non-blocking by design.

import { readFileSync } from "node:fs";

import { isTaskLike } from "../../classifier.js";
import { pickMode } from "../../mode.js";
import { getPromptSnippet } from "../../prompts.js";

interface ClaudeCodeHookEnv {
  UNDERSTANDING_GATE_DISABLE?: string;
  UNDERSTANDING_GATE_MODE?: string;
  /**
   * Path to a harness pause-sentinel JSON file (shape:
   * {pausedAt, expiresAt, reason, pausedBy}, mirroring
   * harness's `readSentinel`). Read-only: this package never writes or
   * deletes the file, and auto-resume cleanup is the harness's job, not
   * this hook's. Unset means "no pause check at all" so the package stays
   * standalone-runnable without any harness on disk.
   */
  UNDERSTANDING_GATE_PAUSE_FILE?: string;
}

interface HookInput {
  prompt?: unknown;
}

interface PauseSentinelShape {
  expiresAt?: unknown;
}

const HOOK_EVENT_NAME = "UserPromptSubmit";

// Claude Code hands this hook the harness's own `<task-notification>` XML
// wrapper text AS the `prompt` field on some turns (subagent completion
// notices), not just genuine operator input. Match it as a PREFIX (after
// leading whitespace) so an operator who happens to type the words
// "task-notification" mid-message still gets gated; only a prompt that
// actually BEGINS with the tag is treated as a harness hull.
const TASK_NOTIFICATION_HULL = /^\s*<task-notification(?:[\s/>]|$)/;

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function isHarnessHull(prompt: string): boolean {
  return TASK_NOTIFICATION_HULL.test(prompt);
}

// Read-only, best-effort check of a harness pause sentinel. Mirrors the
// read side of harness's `readSentinel` (pause-sentinel.ts) without taking
// a dependency on harness: no file, an unreadable file, malformed JSON, or
// a missing/unparsable `expiresAt` all degrade to "not paused" so a broken
// sentinel can never freeze this hook's normal behavior. `expiresAt: null`
// means paused indefinitely; a valid ISO string in the future means paused
// until then; anything else (including an already-past timestamp) means
// not paused. Nothing here is ever written or deleted -- expiry cleanup is
// the harness's job, not this hook's.
function isPaused(pauseFilePath: string | undefined): boolean {
  if (!pauseFilePath) return false;
  let raw: string;
  try {
    raw = readFileSync(pauseFilePath, "utf8");
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  if (!("expiresAt" in parsed)) return false;
  const expiresAt = (parsed as PauseSentinelShape).expiresAt;
  if (expiresAt === null) return true;
  if (typeof expiresAt !== "string") return false;
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) return false;
  return expires > Date.now();
}

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
  if (isHarnessHull(prompt)) return "";
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
