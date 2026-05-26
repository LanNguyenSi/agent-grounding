// In-process map of `sessionId -> HypothesisStore`.
//
// Unlike the grounding session store, hypotheses are intentionally
// not persisted to disk. They are scratch-pad state for an active
// debugging session: useful while the agent is reasoning, noise once
// the session is closed. Persistence can be added later if cross-restart
// continuity becomes a real need (none observed yet).
//
// One Map per server process is enough — the MCP server runs a single
// stdio loop, so there is no concurrent-write race to worry about.

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
