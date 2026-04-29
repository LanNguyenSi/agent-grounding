// Pure helpers for merging and unmerging the Claude Code UserPromptSubmit
// hook entry from a settings.json document. All functions take and return
// plain objects so they are unit-testable without fs.
//
// Settings shape (from observed ~/.claude/settings.json):
// {
//   "hooks": {
//     "UserPromptSubmit": [
//       {
//         "matcher": "",
//         "hooks": [{ "type": "command", "command": "<binary>" }]
//       }
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
    UserPromptSubmit?: HookMatcher[];
    [key: string]: HookMatcher[] | undefined;
  };
  [key: string]: unknown;
}

export const HOOK_COMMAND_NAME = "understanding-gate-claude-hook";

export function hasOurHook(
  doc: SettingsDocument,
  commandName: string = HOOK_COMMAND_NAME,
): boolean {
  const matchers = doc.hooks?.UserPromptSubmit;
  if (!Array.isArray(matchers)) return false;
  return matchers.some((m) =>
    Array.isArray(m.hooks) && m.hooks.some((h) => h.command === commandName),
  );
}

export function addOurHook(
  doc: SettingsDocument,
  commandName: string = HOOK_COMMAND_NAME,
): { doc: SettingsDocument; added: boolean } {
  if (hasOurHook(doc, commandName)) {
    return { doc, added: false };
  }

  // Deep-clone the relevant slice so callers get a fresh document and the
  // input remains untouched (functional style; simpler test invariants).
  const next: SettingsDocument = { ...doc };
  const hooks = { ...(next.hooks ?? {}) };
  const ups: HookMatcher[] = Array.isArray(hooks.UserPromptSubmit)
    ? hooks.UserPromptSubmit.map((m) => ({
        ...m,
        hooks: Array.isArray(m.hooks) ? [...m.hooks] : [],
      }))
    : [];

  ups.push({
    matcher: "",
    hooks: [{ type: "command", command: commandName }],
  });
  hooks.UserPromptSubmit = ups;
  next.hooks = hooks;
  return { doc: next, added: true };
}

export function removeOurHook(
  doc: SettingsDocument,
  commandName: string = HOOK_COMMAND_NAME,
): { doc: SettingsDocument; removed: boolean } {
  if (!hasOurHook(doc, commandName)) {
    return { doc, removed: false };
  }

  const next: SettingsDocument = { ...doc };
  const hooks = { ...(next.hooks ?? {}) };
  const ups = (hooks.UserPromptSubmit ?? [])
    .map((m) => ({
      ...m,
      hooks: (m.hooks ?? []).filter((h) => h.command !== commandName),
    }))
    .filter((m) => m.hooks.length > 0);

  if (ups.length === 0) {
    delete hooks.UserPromptSubmit;
  } else {
    hooks.UserPromptSubmit = ups;
  }

  if (Object.keys(hooks).length === 0) {
    delete next.hooks;
  } else {
    next.hooks = hooks;
  }
  return { doc: next, removed: true };
}
