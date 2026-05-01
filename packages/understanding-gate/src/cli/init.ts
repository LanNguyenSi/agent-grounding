import { readFileSync, existsSync } from "node:fs";
import {
  HOOK_COMMAND_NAME,
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

const HOOKS_TO_INSTALL: ReadonlyArray<{
  event: ClaudeHookEvent;
  command: string;
}> = [
  { event: "UserPromptSubmit", command: HOOK_COMMAND_NAME },
  { event: "Stop", command: STOP_HOOK_COMMAND_NAME },
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

export function runInit(opts: {
  scope: Scope;
  cwd?: string;
  /** Override the UserPromptSubmit binary name (legacy escape hatch). */
  commandName?: string;
}): RunResult {
  const path = settingsPathFor(opts.scope, opts.cwd);
  const before = readSettings(path);
  let doc = before;
  let changed = false;
  for (const hook of HOOKS_TO_INSTALL) {
    const command =
      hook.event === "UserPromptSubmit"
        ? (opts.commandName ?? hook.command)
        : hook.command;
    const result = addHook(doc, hook.event, command);
    doc = result.doc;
    if (result.added) changed = true;
  }
  if (changed) writeSettings(path, doc);
  return { path, changed };
}

export function runUninstall(opts: {
  scope: Scope;
  cwd?: string;
  commandName?: string;
}): RunResult {
  const path = settingsPathFor(opts.scope, opts.cwd);
  if (!existsSync(path)) return { path, changed: false };
  const before = readSettings(path);
  let doc = before;
  let changed = false;
  for (const hook of HOOKS_TO_INSTALL) {
    const command =
      hook.event === "UserPromptSubmit"
        ? (opts.commandName ?? hook.command)
        : hook.command;
    const result = removeHook(doc, hook.event, command);
    doc = result.doc;
    if (result.removed) changed = true;
  }
  if (changed) writeSettings(path, doc);
  return { path, changed };
}
