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
// Memory profile: the Map grows monotonically over the lifetime of one
// `grounding-mcp` process. Fine today (Claude Code restarts kill the
// process and reset the Map), follow-up if the server ever moves to a
// long-running daemon model. No TTL, no LRU, no purge verb yet.

import { createStore, type HypothesisStore } from '@lannguyensi/hypothesis-tracker';

const stores = new Map<string, HypothesisStore>();

export function getOrCreateStore(sessionId: string): HypothesisStore {
  let store = stores.get(sessionId);
  if (!store) {
    store = createStore(sessionId);
    stores.set(sessionId, store);
  }
  return store;
}

export function getStore(sessionId: string): HypothesisStore | undefined {
  return stores.get(sessionId);
}

export function resetStores(): void {
  stores.clear();
}
