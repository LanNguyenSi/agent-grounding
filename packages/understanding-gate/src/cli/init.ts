import { readFileSync, existsSync } from "node:fs";
import {
  HOOK_COMMAND_NAME,
  PRE_TOOL_USE_HOOK_COMMAND_NAME,
  STOP_HOOK_COMMAND_NAME,
  addHook,
  removeHook,
  type ClaudeHookEvent,
  type SettingsDocument,
} from "./settings.js";
import { settingsPathFor, type Scope } from "./paths.js";
import { writeAtomicJSON } from "../core/fs.js";

interface RunResult {
  path: string;
  changed: boolean;
}

// Order matters only for the human-readable diff: settings.json grows in
// the listed sequence on a fresh install. Re-running init on a partial
// install adds whatever hooks are missing; addHook is idempotent.
const HOOKS_TO_INSTALL: ReadonlyArray<{
  event: ClaudeHookEvent;
  command: string;
}> = [
  { event: "UserPromptSubmit", command: HOOK_COMMAND_NAME },
  { event: "Stop", command: STOP_HOOK_COMMAND_NAME },
  { event: "PreToolUse", command: PRE_TOOL_USE_HOOK_COMMAND_NAME },
];

function readSettings(path: string): SettingsDocument {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(
        `${path} is not a JSON object (got ${Array.isArray(parsed) ? "array" : typeof parsed}).`,
      );
    }
    return parsed as SettingsDocument;
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${(err as Error).message}`);
  }
}

function writeSettings(path: string, doc: SettingsDocument): void {
  writeAtomicJSON(path, doc);
}

// commandName override removed in Phase 1.10: it only ever rewrote the
// UserPromptSubmit hook, so a non-default value left UPS pointing at a
// custom binary while Stop still pointed at the default. Asymmetric and
// undocumented; no consumer in this package or its CLI ever used it.
export function runInit(opts: {
  scope: Scope;
  cwd?: string;
}): RunResult {
  const path = settingsPathFor(opts.scope, opts.cwd);
  const before = readSettings(path);
  let doc = before;
  let changed = false;
  for (const hook of HOOKS_TO_INSTALL) {
    const result = addHook(doc, hook.event, hook.command);
    doc = result.doc;
    if (result.added) changed = true;
  }
  if (changed) writeSettings(path, doc);
  return { path, changed };
}

export function runUninstall(opts: {
  scope: Scope;
  cwd?: string;
}): RunResult {
  const path = settingsPathFor(opts.scope, opts.cwd);
  if (!existsSync(path)) return { path, changed: false };
  const before = readSettings(path);
  let doc = before;
  let changed = false;
  for (const hook of HOOKS_TO_INSTALL) {
    const result = removeHook(doc, hook.event, hook.command);
    doc = result.doc;
    if (result.removed) changed = true;
  }
  if (changed) writeSettings(path, doc);
  return { path, changed };
}
