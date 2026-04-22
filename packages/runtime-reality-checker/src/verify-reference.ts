/**
 * verify_memory_reference — sanity-check that a path, symbol, or flag
 * a memory references still exists in the current repo state.
 *
 * Memories are point-in-time observations. A memory that says
 * "flag --foo lives in src/cli.ts:42" ages badly: files rename, functions
 * move, flags get removed. Before an agent acts on such a memory, it
 * should verify the reference is still real. CLAUDE.md mandates this
 * ("Before recommending from memory") but today it's manual.
 *
 * No external deps. Walks the repo via node:fs recursion, skipping
 * common build/vcs artefacts. ~100 ms on a typical mid-size repo — fast
 * enough to run in a hook loop without gating the user.
 */

import {
  statSync,
  readdirSync,
  readFileSync,
  type Stats,
} from "node:fs";
import { join, sep } from "node:path";

export type MemoryReferenceKind = "path" | "symbol" | "flag";

export interface MemoryReference {
  kind: MemoryReferenceKind;
  value: string;
  /** Repository root for the check. Defaults to `process.cwd()`. */
  repoRoot?: string;
}

export interface VerifyMemoryReferenceResult {
  ref: MemoryReference;
  exists: boolean;
  /** Files where the reference was found (symbol/flag) — empty for path. */
  foundIn: string[];
  /** Total match count across all files (symbol/flag). 0 or 1 for path. */
  matchCount: number;
  /** ISO timestamp of the file's last modification, when kind='path' and it exists. */
  lastModified?: string;
  /** Human-readable one-liner — useful when injecting into agent context. */
  summary: string;
}

export interface VerifyOptions {
  /**
   * File extensions to search (symbol/flag). Passed without leading dot.
   * Default: ts, tsx, mts, mjs, js, jsx, py, go, rs, java.
   */
  extensions?: readonly string[];
  /**
   * Directory names to skip anywhere in the walk. Default: node_modules,
   * dist, build, .git, .next, coverage, .venv, __pycache__.
   */
  ignoreDirs?: readonly string[];
  /**
   * Cap the walker at this many files before giving up. Default: 5000.
   * Prevents runaway on a misconfigured repoRoot.
   */
  maxFiles?: number;
}

const DEFAULT_EXTENSIONS = [
  "ts",
  "tsx",
  "mts",
  "mjs",
  "js",
  "jsx",
  "py",
  "go",
  "rs",
  "java",
] as const;

const DEFAULT_IGNORE_DIRS = [
  "node_modules",
  "dist",
  "build",
  ".git",
  ".next",
  "coverage",
  ".venv",
  "__pycache__",
  ".turbo",
  ".cache",
] as const;

const DEFAULT_MAX_FILES = 5000;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSymbolPattern(value: string): RegExp {
  // Match common declaration forms followed by the symbol name, OR a
  // plain whole-word occurrence (so imports / re-exports also count).
  // `function|class|const|let|var|type|interface|enum|def|fn|struct`
  // covers most languages' declaration keywords; the trailing |\\b
  // alternative catches bare references.
  const name = escapeRegex(value);
  return new RegExp(
    `(?:(?:function|class|const|let|var|type|interface|enum|def|fn|struct|export)\\s+${name}\\b|\\b${name}\\b)`,
  );
}

function buildFlagPattern(value: string): RegExp {
  // Literal match. Anchor on word-boundary only when the value looks
  // like an identifier; pure flags like "--force" should match
  // verbatim (word boundaries don't handle leading dashes).
  return new RegExp(escapeRegex(value));
}

interface WalkResult {
  files: string[];
  truncated: boolean;
}

function walk(
  root: string,
  extensions: ReadonlySet<string>,
  ignoreDirs: ReadonlySet<string>,
  maxFiles: number,
): WalkResult {
  const files: string[] = [];
  let truncated = false;
  const stack: string[] = [root];

  while (stack.length > 0) {
    if (files.length >= maxFiles) {
      truncated = true;
      break;
    }
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (ignoreDirs.has(entry)) continue;
      const full = join(dir, entry);
      let stat: Stats;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!stat.isFile()) continue;
      const dotIdx = entry.lastIndexOf(".");
      if (dotIdx < 0) continue;
      const ext = entry.slice(dotIdx + 1);
      if (!extensions.has(ext)) continue;
      files.push(full);
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
    }
  }

  return { files, truncated };
}

function countMatches(source: string, pattern: RegExp): number {
  const global = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g",
  );
  let count = 0;
  while (global.exec(source) !== null) count++;
  return count;
}

function verifyPath(
  ref: MemoryReference,
  root: string,
): VerifyMemoryReferenceResult {
  const full = ref.value.startsWith(sep) ? ref.value : join(root, ref.value);
  try {
    const stat = statSync(full);
    return {
      ref,
      exists: true,
      foundIn: [full],
      matchCount: 1,
      lastModified: stat.mtime.toISOString(),
      summary: `path '${ref.value}' exists (last modified ${stat.mtime.toISOString()})`,
    };
  } catch {
    return {
      ref,
      exists: false,
      foundIn: [],
      matchCount: 0,
      summary: `path '${ref.value}' does not exist at ${full}`,
    };
  }
}

function verifyGrepLike(
  ref: MemoryReference,
  root: string,
  opts: Required<VerifyOptions>,
  pattern: RegExp,
  label: string,
): VerifyMemoryReferenceResult {
  const extensions = new Set(opts.extensions);
  const ignoreDirs = new Set(opts.ignoreDirs);
  const { files, truncated } = walk(
    root,
    extensions,
    ignoreDirs,
    opts.maxFiles,
  );

  const foundIn: string[] = [];
  let matchCount = 0;
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const c = countMatches(source, pattern);
    if (c > 0) {
      foundIn.push(file);
      matchCount += c;
    }
  }

  const exists = matchCount > 0;
  const truncationNote = truncated
    ? ` (walker stopped at ${opts.maxFiles} files — raise maxFiles if the repo is larger)`
    : "";
  return {
    ref,
    exists,
    foundIn,
    matchCount,
    summary: exists
      ? `${label} '${ref.value}' found in ${foundIn.length} file(s) (${matchCount} matches)${truncationNote}`
      : `${label} '${ref.value}' not found in any scanned file${truncationNote}`,
  };
}

/**
 * Verify whether a memory-referenced path/symbol/flag still exists in
 * the repo state at `ref.repoRoot` (default: process.cwd()).
 *
 * Synchronous. Returns a single `VerifyMemoryReferenceResult` suitable
 * for rendering into agent context. Never throws — callers get a
 * well-formed result with `exists: false` if the root is unreadable.
 */
export function verifyMemoryReference(
  ref: MemoryReference,
  options: VerifyOptions = {},
): VerifyMemoryReferenceResult {
  const root = ref.repoRoot ?? process.cwd();
  const opts: Required<VerifyOptions> = {
    extensions: options.extensions ?? DEFAULT_EXTENSIONS,
    ignoreDirs: options.ignoreDirs ?? DEFAULT_IGNORE_DIRS,
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
  };

  switch (ref.kind) {
    case "path":
      return verifyPath(ref, root);
    case "symbol":
      return verifyGrepLike(ref, root, opts, buildSymbolPattern(ref.value), "symbol");
    case "flag":
      return verifyGrepLike(ref, root, opts, buildFlagPattern(ref.value), "flag");
    default: {
      // Exhaustiveness: unknown kind surfaces as exists:false, not a throw.
      const k: never = ref.kind;
      return {
        ref,
        exists: false,
        foundIn: [],
        matchCount: 0,
        summary: `unknown ref.kind '${String(k)}' — expected path|symbol|flag`,
      };
    }
  }
}
