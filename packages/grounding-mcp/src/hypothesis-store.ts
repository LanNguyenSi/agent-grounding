// In-process map of `sessionId -> HypothesisStore`.
//
// Unlike the grounding session store, hypotheses are intentionally
// not persisted to disk. They are scratch-pad state for an active
// debugging session: useful while the agent is reasoning, noise once
// the session is closed. Persistence can be added later if cross-restart
// continuity becomes a real need (none observed yet).
//
// One Map per server process is enough: the MCP server runs a single
// stdio loop, so there is no concurrent-write race to worry about.
//
// Read/write asymmetry: writers (`hypothesis_record`) use
// `getOrCreateStore`, readers (`hypothesis_list`) use `getStore` and
// fall back to an empty-summary fixture in the handler. This avoids
// allocating an empty Map entry on a stray list-call and keeps "no
// hypotheses recorded yet" indistinguishable from "list before record".
// Mutating verbs other than record (`hypothesis_evidence` etc.) require
// an existing store and return `{ error: 'no_store_for_session' }`
// rather than silently creating one, since hitting them without a prior
// record is almost certainly a programming error.
//
// Memory profile: the Map is size-bounded by a built-in LRU. The cap
// is read lazily from `GROUNDING_HYPOTHESIS_MAX_SESSIONS` (default 200,
// minimum 1). When a new session is added past the cap the
// least-recently-used entry (Map insertion/re-insertion order) is
// evicted. Per-session purge is available via `resetStore(sessionId)`;
// `resetStores()` clears all sessions (test helper, retained).
// `hypothesis_reset` is the MCP-verb counterpart of `resetStore`.
// TTL and hot-reload of the cap remain out of scope.

import { createStore, type HypothesisStore } from '@lannguyensi/hypothesis-tracker';

const stores = new Map<string, HypothesisStore>();

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

export function getOrCreateStore(sessionId: string): HypothesisStore {
  const existing = stores.get(sessionId);
  if (existing) {
    // Touch: delete then re-set so this key becomes most-recently-used.
    stores.delete(sessionId);
    stores.set(sessionId, existing);
    return existing;
  }
  const store = createStore(sessionId);
  stores.set(sessionId, store);
  // Evict LRU entries (first key in iteration order) while over cap.
  const cap = getMaxSessions();
  while (stores.size > cap) {
    const lruKey = stores.keys().next().value as string;
    stores.delete(lruKey);
  }
  return store;
}

export function getStore(sessionId: string): HypothesisStore | undefined {
  const store = stores.get(sessionId);
  if (store) {
    // Touch on read so reads count toward recency (true LRU semantics).
    stores.delete(sessionId);
    stores.set(sessionId, store);
  }
  return store;
}

/** Purge the hypothesis store for a single session.
 * Returns true if a store existed and was deleted, false if it was never created.
 * Use this when reusing a grounding sessionId for a new debug task so stale
 * hypotheses do not leak into the fresh investigation. */
export function resetStore(sessionId: string): boolean {
  return stores.delete(sessionId);
}

/** Clear ALL session stores. Kept as a test helper; prefer resetStore for
 * targeted purges in production code. */
export function resetStores(): void {
  stores.clear();
}

/** Return the number of sessions currently held in the store.
 * Useful for asserting LRU eviction in tests. */
export function storeCount(): number {
  return stores.size;
}
