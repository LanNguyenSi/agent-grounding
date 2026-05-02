// Pure helpers for merging and unmerging Claude Code hook entries from a
// settings.json document. Parameterised on event name so the same helpers
// serve UserPromptSubmit (Phase 0) and Stop (Phase 1.3). All functions
// take and return plain objects so they are unit-testable without fs.
//
// Settings shape (from observed ~/.claude/settings.json):
// {
//   "hooks": {
//     "UserPromptSubmit": [
//       { "matcher": "", "hooks": [{ "type": "command", "command": "<bin>" }] }
//     ],
//     "Stop": [
//       { "matcher": "", "hooks": [{ "type": "command", "command": "<bin>" }] }
//     ]
//   }
// }

export interface HookCommand {
  type: "command";
  command: string;
}

export interface HookMatcher {
  matcher: string;
  hooks: HookCommand[];
}

export interface SettingsDocument {
  hooks?: {
    [eventName: string]: HookMatcher[] | undefined;
  };
  [key: string]: unknown;
}

export type ClaudeHookEvent = "UserPromptSubmit" | "Stop" | "PreToolUse";

export const HOOK_COMMAND_NAME = "understanding-gate-claude-hook";
export const STOP_HOOK_COMMAND_NAME = "understanding-gate-claude-stop";
export const PRE_TOOL_USE_HOOK_COMMAND_NAME =
  "understanding-gate-claude-pre-tool-use";

export function hasHook(
  doc: SettingsDocument,
  eventName: ClaudeHookEvent,
  commandName: string,
): boolean {
  const matchers = doc.hooks?.[eventName];
  if (!Array.isArray(matchers)) return false;
  return matchers.some((m) =>
    Array.isArray(m.hooks) && m.hooks.some((h) => h.command === commandName),
  );
}

export function addHook(
  doc: SettingsDocument,
  eventName: ClaudeHookEvent,
  commandName: string,
): { doc: SettingsDocument; added: boolean } {
  if (hasHook(doc, eventName, commandName)) {
    return { doc, added: false };
  }

  // Deep-clone the relevant slice so callers get a fresh document and the
  // input remains untouched (functional style; simpler test invariants).
  const next: SettingsDocument = { ...doc };
  const hooks = { ...(next.hooks ?? {}) };
  const list: HookMatcher[] = Array.isArray(hooks[eventName])
    ? (hooks[eventName] as HookMatcher[]).map((m) => ({
        ...m,
        hooks: Array.isArray(m.hooks) ? [...m.hooks] : [],
      }))
    : [];

  list.push({
    matcher: "",
    hooks: [{ type: "command", command: commandName }],
  });
  hooks[eventName] = list;
  next.hooks = hooks;
  return { doc: next, added: true };
}

export function removeHook(
  doc: SettingsDocument,
  eventName: ClaudeHookEvent,
  commandName: string,
): { doc: SettingsDocument; removed: boolean } {
  if (!hasHook(doc, eventName, commandName)) {
    return { doc, removed: false };
  }

  const next: SettingsDocument = { ...doc };
  const hooks = { ...(next.hooks ?? {}) };
  const list = (hooks[eventName] ?? [])
    .map((m) => ({
      ...m,
      hooks: (m.hooks ?? []).filter((h) => h.command !== commandName),
    }))
    .filter((m) => m.hooks.length > 0);

  if (list.length === 0) {
    delete hooks[eventName];
  } else {
    hooks[eventName] = list;
  }

  if (Object.keys(hooks).length === 0) {
    delete next.hooks;
  } else {
    next.hooks = hooks;
  }
  return { doc: next, removed: true };
}

// --- Phase-0 back-compat wrappers ---------------------------------------
// Kept so existing callers (and tests) don't break. New code should use
// the generic `hasHook` / `addHook` / `removeHook` directly.

export function hasOurHook(
  doc: SettingsDocument,
  commandName: string = HOOK_COMMAND_NAME,
): boolean {
  return hasHook(doc, "UserPromptSubmit", commandName);
}

export function addOurHook(
  doc: SettingsDocument,
  commandName: string = HOOK_COMMAND_NAME,
): { doc: SettingsDocument; added: boolean } {
  return addHook(doc, "UserPromptSubmit", commandName);
}

export function removeOurHook(
  doc: SettingsDocument,
  commandName: string = HOOK_COMMAND_NAME,
): { doc: SettingsDocument; removed: boolean } {
  return removeHook(doc, "UserPromptSubmit", commandName);
}
