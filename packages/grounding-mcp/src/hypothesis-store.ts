// In-process map of `sessionId -> HypothesisStore`, backed by JSON files
// under `<hypothesesRoot()>/<sessionId>.json` so hypotheses survive a
// grounding-mcp restart.
//
// Claude Code restarts grounding-mcp on every new session (and on crash).
// Before this file grew disk persistence, an agent that had recorded
// competing hypotheses got a fully-restored grounding session
// (session-store.ts) and evidence ledger (ledger-bridge.ts), but a
// silently-empty hypothesis_list — the asymmetry was actively misleading,
// not merely inconvenient. This module brings the hypothesis store to the
// same durability as those two, sessionId-namespaced like both.
//
// The Map stays the hot path: within a process, all reads/writes go
// through it. Disk is consulted only on a cache miss (first access to a
// sessionId this process — e.g. right after a restart) via
// `loadStoreFromDisk`. Writing to disk is NOT automatic on every mutation
// of the returned store object (the tracker mutators in
// `@lannguyensi/hypothesis-tracker` mutate in place and know nothing about
// persistence); callers that mutate a store must call `saveStore`
// afterwards. server.ts's hypothesis_* verbs do this after every
// successful mutation.
//
// One Map per server process is enough: the MCP server runs a single
// stdio loop, so there is no concurrent-write race to worry about within a
// process. Two processes racing on the same session id share the
// tmp+rename atomicity used by session-store.ts (last writer wins on
// rename, no torn reads) but not a higher-level lock — same caveat as
// session-store.ts's saveSession.
//
// Read/write asymmetry: writers (`hypothesis_record`) use
// `getOrCreateStore`, readers (`hypothesis_list`) use `getStore` and
// fall back to an empty-summary fixture in the handler. This avoids
// allocating an empty Map entry (or an on-disk file) on a stray list-call
// and keeps "no hypotheses recorded yet" indistinguishable from "list
// before record" — including across a restart, since `getStore` returns
// `undefined` when neither the Map nor disk has anything for the session.
// Mutating verbs other than record (`hypothesis_evidence` etc.) require
// an existing store and return `{ error: 'no_store_for_session' }`
// rather than silently creating one, since hitting them without a prior
// record is almost certainly a programming error.
//
// Memory profile: the Map is size-bounded by a built-in LRU. The cap
// is read lazily from `GROUNDING_HYPOTHESIS_MAX_SESSIONS` (default 200,
// minimum 1). When a new session is added past the cap the
// least-recently-used entry (Map insertion/re-insertion order) is
// evicted. Eviction only drops the in-process cache entry — the on-disk
// file (if any) is untouched and is re-hydrated on the next access, so
// eviction is not data loss, only a future disk read.
//
// Per-session purge is available via `resetStore(sessionId)`, which clears
// both the Map entry AND the on-disk file, so a reused sessionId does not
// resurrect stale hypotheses from a previous investigation after a
// restart. `resetStores()` clears all in-Map sessions only (test helper,
// retained) — tests isolate on-disk state via a per-test
// `GROUNDING_MCP_HYPOTHESES_DIR` tmp dir instead of relying on this to
// touch disk.
// `hypothesis_reset` is the MCP-verb counterpart of `resetStore`.
// TTL and hot-reload of the cap remain out of scope.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { createStore, type Hypothesis, type HypothesisStore } from '@lannguyensi/hypothesis-tracker';

const stores = new Map<string, HypothesisStore>();

// ── Disk persistence ─────────────────────────────────────────────────────

function defaultHypothesesRoot(): string {
  return join(homedir(), '.grounding-mcp', 'hypotheses');
}

/** GROUNDING_MCP_HYPOTHESES_DIR lets tests (and ad-hoc invocations) point at
 * a temp dir instead of writing to the user's real ~/.grounding-mcp/hypotheses/.
 * Mirrors GROUNDING_MCP_SESSIONS_DIR in session-store.ts. */
export function hypothesesRoot(): string {
  return process.env.GROUNDING_MCP_HYPOTHESES_DIR ?? defaultHypothesesRoot();
}

/**
 * Reduce a session id to a single safe path segment. Non-portable characters
 * collapse to `_`, and `basename` strips any residual separator so the id
 * can never escape `hypothesesRoot()` (path-traversal guard). Empty /
 * dot-only ids are rejected. Mirrors `sanitizeSessionId` in
 * session-store.ts and `sanitizeVerdictId` in solution-verdict.ts: the
 * hypothesis_* verbs accept a client-controlled `sessionId`, so it must be
 * sanitised before it reaches the filesystem.
 */
export function sanitizeHypothesisSessionId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, '_');
  const base = basename(cleaned);
  if (base === '' || base === '.' || base === '..') {
    throw new Error(`invalid hypothesis session id: ${JSON.stringify(id)}`);
  }
  return base;
}

function pathForSession(sessionId: string): string {
  return join(hypothesesRoot(), `${sanitizeHypothesisSessionId(sessionId)}.json`);
}

// Keep in sync with Hypothesis['status'] in @lannguyensi/hypothesis-tracker.
// If the upstream union grows, this guard will silently drop valid rows.
// Mirrors isValidHypothesis in understanding-gate's hypothesis-store-fs.ts.
const VALID_STATUSES = new Set(['unverified', 'supported', 'rejected']);

export function isValidHypothesis(entry: unknown): entry is Hypothesis {
  if (!entry || typeof entry !== 'object') return false;
  const h = entry as Record<string, unknown>;
  return (
    typeof h.id === 'string' &&
    typeof h.text === 'string' &&
    typeof h.status === 'string' &&
    VALID_STATUSES.has(h.status as string) &&
    Array.isArray(h.evidence) &&
    Array.isArray(h.required_checks) &&
    typeof h.createdAt === 'string' &&
    typeof h.updatedAt === 'string'
  );
}

/**
 * Read `<hypothesesRoot()>/<sessionId>.json` and validate its shape.
 * Returns `undefined` when the file is absent, the top-level JSON is
 * malformed, or the top-level shape doesn't match `{ session, hypotheses }`
 * — all three are treated as "nothing usable on disk", same as a session
 * that was never recorded. Per-entry: an individual malformed hypothesis
 * is dropped rather than failing the whole load, so one corrupt row
 * doesn't discard an otherwise-valid store (matches
 * understanding-gate's hypothesis-store-fs.ts loadOrCreateStore).
 */
function loadStoreFromDisk(sessionId: string): HypothesisStore | undefined {
  const path = pathForSession(sessionId);
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { hypotheses?: unknown }).hypotheses) &&
      typeof (parsed as { session?: unknown }).session === 'string'
    ) {
      const top = parsed as { session: string; hypotheses: unknown[] };
      const valid: Hypothesis[] = [];
      for (const entry of top.hypotheses) {
        if (isValidHypothesis(entry)) valid.push(entry);
      }
      return { session: top.session, hypotheses: valid };
    }
  } catch {
    // fall through: corrupt JSON is treated as "nothing to load"
  }
  return undefined;
}

/**
 * Persist `store` to `<hypothesesRoot()>/<sessionId>.json`. Writes to a
 * pid-suffixed tmp file in the same directory then renames over the final
 * path so a concurrent reader can't observe a half-written JSON (the
 * rename is atomic on POSIX). Mirrors `saveSession` in session-store.ts;
 * see that file's comment for the read-modify-write caveat this does and
 * doesn't fix.
 */
export function saveStore(sessionId: string, store: HypothesisStore): void {
  const root = hypothesesRoot();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const final = pathForSession(sessionId);
  const tmp = `${final}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
  renameSync(tmp, final);
}

/** Delete the on-disk file for a session, if any. Returns whether a file
 * existed and was removed. */
function deleteStoreFromDisk(sessionId: string): boolean {
  const path = pathForSession(sessionId);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

// ── In-process cache (LRU-capped) ───────────────────────────────────────

/** Read the LRU cap lazily (per-call) so tests can set process.env without
 * module reload. Parses `GROUNDING_HYPOTHESIS_MAX_SESSIONS` as an integer;
 * unset, non-integer (e.g. "3.9"), zero, or negative all fall back to 200.
 * The smallest configurable cap is 1, so the just-created session is never
 * evicted. */
function getMaxSessions(): number {
  const raw = process.env.GROUNDING_HYPOTHESIS_MAX_SESSIONS;
  if (raw === undefined || raw === '') return 200;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return 200;
  return parsed;
}

/** Insert/refresh `sessionId` as most-recently-used and evict over the cap. */
function cacheAndEvict(sessionId: string, store: HypothesisStore): HypothesisStore {
  stores.set(sessionId, store);
  const cap = getMaxSessions();
  while (stores.size > cap) {
    const lruKey = stores.keys().next().value as string;
    stores.delete(lruKey);
  }
  return store;
}

export function getOrCreateStore(sessionId: string): HypothesisStore {
  const existing = stores.get(sessionId);
  if (existing) {
    // Touch: delete then re-set so this key becomes most-recently-used.
    stores.delete(sessionId);
    stores.set(sessionId, existing);
    return existing;
  }
  // Cache miss: hydrate from disk (e.g. right after a restart) before
  // falling back to a brand-new store.
  const store = loadStoreFromDisk(sessionId) ?? createStore(sessionId);
  return cacheAndEvict(sessionId, store);
}

export function getStore(sessionId: string): HypothesisStore | undefined {
  const store = stores.get(sessionId);
  if (store) {
    // Touch on read so reads count toward recency (true LRU semantics).
    stores.delete(sessionId);
    stores.set(sessionId, store);
    return store;
  }
  // Cache miss: try hydrating from disk without inventing a session that
  // was never recorded — mirrors the pre-persistence "list before record"
  // behavior, now also true across a restart.
  const fromDisk = loadStoreFromDisk(sessionId);
  if (!fromDisk) return undefined;
  return cacheAndEvict(sessionId, fromDisk);
}

/** Purge the hypothesis store for a single session, in-process AND on disk.
 * Returns true if a store existed (in memory or on disk) and was deleted,
 * false if it was never created. Use this when reusing a grounding
 * sessionId for a new debug task so stale hypotheses do not leak into the
 * fresh investigation, or resurrect from disk after a later restart. */
export function resetStore(sessionId: string): boolean {
  const existedInMemory = stores.delete(sessionId);
  const existedOnDisk = deleteStoreFromDisk(sessionId);
  return existedInMemory || existedOnDisk;
}

/** Clear ALL in-process session stores. Kept as a test helper; prefer
 * resetStore for targeted purges in production code. Does NOT touch disk —
 * tests isolate on-disk state via a per-test GROUNDING_MCP_HYPOTHESES_DIR
 * tmp dir instead. Also doubles as the "simulated restart" primitive in
 * tests: a fresh grounding-mcp process starts with an empty Map, so
 * calling this and then re-reading through getStore/getOrCreateStore
 * exercises the same disk-hydration path a real restart would. */
export function resetStores(): void {
  stores.clear();
}

/** Return the number of sessions currently held in the store.
 * Useful for asserting LRU eviction in tests. */
export function storeCount(): number {
  return stores.size;
}
