// fs wrapper around the opencode adapter renderers. Idempotent: writes
// only if the target file does not exist, or its content differs from the
// rendered content. Avoids overwriting user-edited copies on every init.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import {
  renderRules,
  renderGrillCommand,
  renderPluginShim,
  RULES_FILENAME,
  COMMAND_FILENAME,
  PLUGIN_SHIM_FILENAME,
} from "../adapters/opencode/index.js";

export type OpencodeScope = "user" | "project";

interface PathTriple {
  rules: string;
  command: string;
  plugin: string;
}

export function opencodePaths(
  scope: OpencodeScope,
  cwd: string = process.cwd(),
): PathTriple {
  if (scope === "user") {
    const base = resolve(homedir(), ".config", "opencode");
    return {
      rules: resolve(base, "rules", RULES_FILENAME),
      command: resolve(base, "command", COMMAND_FILENAME),
      plugin: resolve(base, "plugins", PLUGIN_SHIM_FILENAME),
    };
  }
  const base = resolve(cwd, ".opencode");
  return {
    rules: resolve(base, "rules", RULES_FILENAME),
    command: resolve(base, "command", COMMAND_FILENAME),
    plugin: resolve(base, "plugins", PLUGIN_SHIM_FILENAME),
  };
}

function writeIfChanged(path: string, content: string): boolean {
  if (existsSync(path)) {
    const current = readFileSync(path, "utf8");
    if (current === content) return false;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return true;
}

export interface OpencodeInitResult {
  paths: PathTriple;
  rulesChanged: boolean;
  commandChanged: boolean;
  pluginChanged: boolean;
}

export function runOpencodeInit(opts: {
  scope: OpencodeScope;
  cwd?: string;
}): OpencodeInitResult {
  const paths = opencodePaths(opts.scope, opts.cwd);
  const rulesChanged = writeIfChanged(paths.rules, renderRules());
  const commandChanged = writeIfChanged(paths.command, renderGrillCommand());
  const pluginChanged = writeIfChanged(paths.plugin, renderPluginShim());
  return { paths, rulesChanged, commandChanged, pluginChanged };
}

export interface OpencodeUninstallResult {
  paths: PathTriple;
  rulesRemoved: boolean;
  commandRemoved: boolean;
  pluginRemoved: boolean;
}

export function runOpencodeUninstall(opts: {
  scope: OpencodeScope;
  cwd?: string;
}): OpencodeUninstallResult {
  const paths = opencodePaths(opts.scope, opts.cwd);
  let rulesRemoved = false;
  let commandRemoved = false;
  let pluginRemoved = false;
  if (existsSync(paths.rules)) {
    unlinkSync(paths.rules);
    rulesRemoved = true;
  }
  if (existsSync(paths.command)) {
    unlinkSync(paths.command);
    commandRemoved = true;
  }
  if (existsSync(paths.plugin)) {
    unlinkSync(paths.plugin);
    pluginRemoved = true;
  }
  return { paths, rulesRemoved, commandRemoved, pluginRemoved };
}
