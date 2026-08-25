// Pure handler: takes raw stdin + env, returns the string to write on stdout.
// Empty string means "stay silent" (Claude Code accepts empty stdout + exit 0).
// All defensive: any failure mode degrades to "" so the hook never crashes
// the harness. Phase 0 is non-blocking by design.

import { readFileSync, statSync } from "node:fs";

import { isTaskLike } from "../../classifier.js";
import { pickMode } from "../../mode.js";
import { getPromptSnippet } from "../../prompts.js";

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

interface PauseSentinelShape {
  pausedAt?: unknown;
  expiresAt?: unknown;
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

// Read-only, best-effort check of a pause sentinel file. The shape and the
// "absent/parsable" semantics below are chosen to match how a pause
// sentinel of this shape is read elsewhere: no file, an unreadable file,
// a non-regular file (see the statSync guard, which keeps this from
// blocking forever on a FIFO), malformed JSON, or a non-object/array JSON
// value all degrade to "not paused". Within a parsable sentinel OBJECT:
//   - a missing or empty-string `pausedAt` makes the whole sentinel count
//     as absent (not paused) -- a sentinel writer never omits it, so this
//     is reserved for a corrupted file.
//   - `expiresAt` missing entirely, or explicitly `null`, means paused
//     INDEFINITELY.
//   - `expiresAt` as a non-empty string that fails to parse as a date
//     ALSO means paused indefinitely (a malformed but present expiry
//     doesn't get to silently unblock things).
//   - `expiresAt` as anything else (a number, array, object, boolean, or
//     empty string) makes the whole sentinel count as absent.
//   - `expiresAt` as a valid, parsable date means paused only while it is
//     strictly in the future; equal-to-now or past means not paused.
// Nothing here is ever written or deleted -- expiry cleanup is not this
// hook's job.
function isPaused(pauseFilePath: string | undefined): boolean {
  if (!pauseFilePath) return false;
  let raw: string;
  try {
    if (!statSync(pauseFilePath).isFile()) return false;
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
  const shape = parsed as PauseSentinelShape;
  if (typeof shape.pausedAt !== "string" || shape.pausedAt.length === 0) {
    return false;
  }

  const expiresAtRaw = shape.expiresAt;
  let expiresAt: string | null;
  if (expiresAtRaw === null || expiresAtRaw === undefined) {
    expiresAt = null;
  } else if (typeof expiresAtRaw === "string" && expiresAtRaw.length > 0) {
    expiresAt = expiresAtRaw;
  } else {
    return false;
  }
  if (expiresAt === null) return true;
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) return true;
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
