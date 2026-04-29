import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import {
  HOOK_COMMAND_NAME,
  addOurHook,
  removeOurHook,
  type SettingsDocument,
} from "./settings.js";
import { settingsPathFor, type Scope } from "./paths.js";

interface RunResult {
  path: string;
  changed: boolean;
}

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
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`, "utf8");
}

export function runInit(opts: {
  scope: Scope;
  cwd?: string;
  commandName?: string;
}): RunResult {
  const path = settingsPathFor(opts.scope, opts.cwd);
  const before = readSettings(path);
  const { doc, added } = addOurHook(before, opts.commandName ?? HOOK_COMMAND_NAME);
  if (!added) return { path, changed: false };
  writeSettings(path, doc);
  return { path, changed: true };
}

export function runUninstall(opts: {
  scope: Scope;
  cwd?: string;
  commandName?: string;
}): RunResult {
  const path = settingsPathFor(opts.scope, opts.cwd);
  if (!existsSync(path)) return { path, changed: false };
  const before = readSettings(path);
  const { doc, removed } = removeOurHook(
    before,
    opts.commandName ?? HOOK_COMMAND_NAME,
  );
  if (!removed) return { path, changed: false };
  writeSettings(path, doc);
  return { path, changed: true };
}
