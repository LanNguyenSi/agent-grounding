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
  RULES_FILENAME,
  COMMAND_FILENAME,
} from "../adapters/opencode/index.js";

export type OpencodeScope = "user" | "project";

interface PathPair {
  rules: string;
  command: string;
}

export function opencodePaths(
  scope: OpencodeScope,
  cwd: string = process.cwd(),
): PathPair {
  if (scope === "user") {
    const base = resolve(homedir(), ".config", "opencode");
    return {
      rules: resolve(base, "rules", RULES_FILENAME),
      command: resolve(base, "command", COMMAND_FILENAME),
    };
  }
  const base = resolve(cwd, ".opencode");
  return {
    rules: resolve(base, "rules", RULES_FILENAME),
    command: resolve(base, "command", COMMAND_FILENAME),
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
  paths: PathPair;
  rulesChanged: boolean;
  commandChanged: boolean;
}

export function runOpencodeInit(opts: {
  scope: OpencodeScope;
  cwd?: string;
}): OpencodeInitResult {
  const paths = opencodePaths(opts.scope, opts.cwd);
  const rulesChanged = writeIfChanged(paths.rules, renderRules());
  const commandChanged = writeIfChanged(paths.command, renderGrillCommand());
  return { paths, rulesChanged, commandChanged };
}

export interface OpencodeUninstallResult {
  paths: PathPair;
  rulesRemoved: boolean;
  commandRemoved: boolean;
}

export function runOpencodeUninstall(opts: {
  scope: OpencodeScope;
  cwd?: string;
}): OpencodeUninstallResult {
  const paths = opencodePaths(opts.scope, opts.cwd);
  let rulesRemoved = false;
  let commandRemoved = false;
  if (existsSync(paths.rules)) {
    unlinkSync(paths.rules);
    rulesRemoved = true;
  }
  if (existsSync(paths.command)) {
    unlinkSync(paths.command);
    commandRemoved = true;
  }
  return { paths, rulesRemoved, commandRemoved };
}
