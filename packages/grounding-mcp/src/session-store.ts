// JSON file-backed persistence for grounding sessions.
//
// grounding-wrapper itself is stateless — it returns a session object and
// expects the caller to hold it in memory. An MCP server is long-running
// across many tool calls (and survives Claude Code restarts), so we serialize
// each session to its own JSON file under <root>/<id>.json.
//
// One file per session keeps reads O(1) and lets concurrent sessions coexist
// without a write-lock or merge step. We never list-and-aggregate, so a flat
// directory is fine.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import type { GroundingSession } from '@lannguyensi/grounding-wrapper';

function defaultRoot(): string {
  return join(homedir(), '.grounding-mcp', 'sessions');
}

export function sessionsRoot(): string {
  return process.env.GROUNDING_MCP_SESSIONS_DIR ?? defaultRoot();
}

/**
 * Reduce a session id to a single safe path segment. Non-portable characters
 * collapse to `_`, and `basename` strips any residual separator so the id can
 * never escape `sessionsRoot()` (path-traversal guard). Empty / dot-only ids
 * are rejected. Mirrors `sanitizeVerdictId` in solution-verdict.ts: the read
 * verbs accept a client-controlled `sessionId`, so it must be sanitised before
 * it reaches the filesystem.
 */
export function sanitizeSessionId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, '_');
  const base = basename(cleaned);
  if (base === '' || base === '.' || base === '..') {
    throw new Error(`invalid grounding session id: ${JSON.stringify(id)}`);
  }
  return base;
}

function pathFor(id: string): string {
  return join(sessionsRoot(), `${sanitizeSessionId(id)}.json`);
}

export function saveSession(session: GroundingSession): void {
  const root = sessionsRoot();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  // Write to a tmp file then rename so a concurrent reader can't observe a
  // half-written JSON (the rename is atomic on POSIX). Doesn't fix the
  // read-modify-write race between two advancePhase callers — that needs a
  // single-writer invariant or a per-session lock — but does eliminate the
  // partial-write failure mode.
  const final = pathFor(session.id);
  const tmp = `${final}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8');
  renameSync(tmp, final);
}

export function loadSession(id: string): GroundingSession {
  const p = pathFor(id);
  if (!existsSync(p)) {
    throw new Error(`grounding session not found: ${id}`);
  }
  return JSON.parse(readFileSync(p, 'utf8')) as GroundingSession;
}

export function sessionExists(id: string): boolean {
  return existsSync(pathFor(id));
}
