// Exercises the in-memory hypothesis store + the tracker functions that
// back the `hypothesis_*` MCP tools. The MCP SDK's tool handlers just
// forward args into these, so testing the data layer + adapter pattern
// is enough to catch contract drift.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  addEvidence,
  addHypothesis,
  completeCheck,
  findHypothesis,
  getSummary as getHypothesisSummary,
  rejectHypothesis,
  supportHypothesis,
} from '@lannguyensi/hypothesis-tracker';

import { getOrCreateStore, getStore, resetStore, resetStores, storeCount } from '../src/hypothesis-store.js';

beforeEach(() => {
  resetStores();
});

describe('hypothesis-store', () => {
  it('lazily creates a store on first access and reuses it on second', () => {
    expect(getStore('s1')).toBeUndefined();
    const first = getOrCreateStore('s1');
    const second = getOrCreateStore('s1');
    expect(first).toBe(second);
    expect(getStore('s1')).toBe(first);
  });

  it('isolates stores by sessionId', () => {
    const a = getOrCreateStore('alpha');
    const b = getOrCreateStore('beta');
    addHypothesis(a, 'a-only', []);
    expect(a.hypotheses).toHaveLength(1);
    expect(b.hypotheses).toHaveLength(0);
  });

  it('resetStores clears every session', () => {
    getOrCreateStore('x');
    getOrCreateStore('y');
    resetStores();
    expect(getStore('x')).toBeUndefined();
    expect(getStore('y')).toBeUndefined();
  });

  it('resetStore deletes one session and leaves a second session intact', () => {
    getOrCreateStore('keep');
    getOrCreateStore('drop');
    const deleted = resetStore('drop');
    expect(deleted).toBe(true);
    expect(getStore('drop')).toBeUndefined();
    expect(getStore('keep')).toBeDefined();
    expect(storeCount()).toBe(1);
  });

  it('resetStore returns false for an unknown session', () => {
    expect(resetStore('never-existed')).toBe(false);
  });
});

describe('hypothesis-store LRU eviction', () => {
  const SAVED_ENV = process.env.GROUNDING_HYPOTHESIS_MAX_SESSIONS;

  afterEach(() => {
    resetStores();
    if (SAVED_ENV === undefined) {
      delete process.env.GROUNDING_HYPOTHESIS_MAX_SESSIONS;
    } else {
      process.env.GROUNDING_HYPOTHESIS_MAX_SESSIONS = SAVED_ENV;
    }
  });

  it('evicts the oldest session when MAX+1 sessions are created', () => {
    process.env.GROUNDING_HYPOTHESIS_MAX_SESSIONS = '3';
    getOrCreateStore('s1');
    getOrCreateStore('s2');
    getOrCreateStore('s3');
    expect(storeCount()).toBe(3);

    // Adding a 4th session should evict s1 (the LRU).
    getOrCreateStore('s4');
    expect(storeCount()).toBe(3);
    expect(getStore('s1')).toBeUndefined();
    expect(getStore('s2')).toBeDefined();
    expect(getStore('s3')).toBeDefined();
    expect(getStore('s4')).toBeDefined();
  });

  it('touching the oldest via getOrCreateStore before overflow protects it and evicts the next-oldest instead', () => {
    process.env.GROUNDING_HYPOTHESIS_MAX_SESSIONS = '3';
    getOrCreateStore('s1');
    getOrCreateStore('s2');
    getOrCreateStore('s3');

    // Touch s1 so it becomes most-recently-used; s2 becomes the LRU.
    getOrCreateStore('s1');

    // Adding s4 should evict s2, not s1.
    getOrCreateStore('s4');
    expect(storeCount()).toBe(3);
    expect(getStore('s1')).toBeDefined();
    expect(getStore('s2')).toBeUndefined();
    expect(getStore('s3')).toBeDefined();
    expect(getStore('s4')).toBeDefined();
  });

  it('touching the oldest via getStore before overflow protects it and evicts the next-oldest instead', () => {
    process.env.GROUNDING_HYPOTHESIS_MAX_SESSIONS = '3';
    getOrCreateStore('s1');
    getOrCreateStore('s2');
    getOrCreateStore('s3');

    // Touch s1 via getStore (read-side touch) so it becomes most-recently-used.
    getStore('s1');

    // Adding s4 should evict s2, not s1.
    getOrCreateStore('s4');
    expect(storeCount()).toBe(3);
    expect(getStore('s1')).toBeDefined();
    expect(getStore('s2')).toBeUndefined();
    expect(getStore('s3')).toBeDefined();
    expect(getStore('s4')).toBeDefined();
  });

  it('falls back to default cap 200 when env var is unset', () => {
    delete process.env.GROUNDING_HYPOTHESIS_MAX_SESSIONS;
    // Just assert no eviction for 2 sessions (cap is 200).
    getOrCreateStore('a');
    getOrCreateStore('b');
    expect(storeCount()).toBe(2);
  });

  it('falls back to default cap 200 when env var is 0 or negative', () => {
    process.env.GROUNDING_HYPOTHESIS_MAX_SESSIONS = '0';
    // With a default of 200, two sessions should not be evicted.
    getOrCreateStore('a');
    getOrCreateStore('b');
    expect(storeCount()).toBe(2);
  });

  it('falls back to default cap 200 for a non-integer env value', () => {
    process.env.GROUNDING_HYPOTHESIS_MAX_SESSIONS = '3.9';
    // "3.9" is not an integer, so the cap is the 200 default, not a truncated 3.
    getOrCreateStore('a');
    getOrCreateStore('b');
    getOrCreateStore('c');
    getOrCreateStore('d');
    expect(storeCount()).toBe(4);
  });

  it('floors at cap 1: the just-created session survives an immediate overflow', () => {
    process.env.GROUNDING_HYPOTHESIS_MAX_SESSIONS = '1';
    getOrCreateStore('s1');
    getOrCreateStore('s2');
    // s2 is the active, just-created session: it must survive; s1 is evicted.
    expect(storeCount()).toBe(1);
    expect(getStore('s2')).toBeDefined();
    expect(getStore('s1')).toBeUndefined();
  });
});

describe('hypothesis tracker round-trip through MCP adapter shape', () => {
  it('records a hypothesis with checks and shows it in the summary', () => {
    const store = getOrCreateStore('gs-test-1');
    const h = addHypothesis(store, 'DNS resolution is failing', [
      'Run dig',
      'Check /etc/resolv.conf',
    ]);
    expect(h.status).toBe('unverified');
    expect(h.required_checks).toHaveLength(2);
    expect(h.required_checks.every((c) => !c.done)).toBe(true);

    const summary = getHypothesisSummary(store);
    expect(summary).toEqual({
      total: 1,
      unverified: 1,
      supported: 0,
      rejected: 0,
      pending_checks: 2,
    });
  });

  it('attaching evidence auto-promotes unverified -> supported', () => {
    const store = getOrCreateStore('gs-test-2');
    const h = addHypothesis(store, 'firewall blocks 443', []);
    expect(h.status).toBe('unverified');

    const after = addEvidence(store, h.id, 'iptables shows DROP on 443', 'iptables -L');
    expect(after?.status).toBe('supported');
    expect(after?.evidence).toHaveLength(1);
    expect(after?.evidence[0]?.source).toBe('iptables -L');

    const summary = getHypothesisSummary(store);
    expect(summary.supported).toBe(1);
    expect(summary.unverified).toBe(0);
  });

  it('completing checks drains the pending_checks counter', () => {
    const store = getOrCreateStore('gs-test-3');
    const h = addHypothesis(store, 'race in startup order', ['Check log timing', 'Add sleep']);

    completeCheck(store, h.id, 0);
    expect(getHypothesisSummary(store).pending_checks).toBe(1);
    completeCheck(store, h.id, 1);
    expect(getHypothesisSummary(store).pending_checks).toBe(0);

    const reloaded = findHypothesis(store, h.id);
    expect(reloaded?.required_checks.every((c) => c.done)).toBe(true);
  });

  it('rejecting appends a [rejected] evidence entry — not a silent delete', () => {
    const store = getOrCreateStore('gs-test-4');
    const h = addHypothesis(store, 'CDN cache is stale', []);

    const rejected = rejectHypothesis(store, h.id, 'cache hit count is zero');
    expect(rejected?.status).toBe('rejected');
    expect(rejected?.evidence).toHaveLength(1);
    expect(rejected?.evidence[0]?.text).toContain('[rejected]');
    expect(rejected?.evidence[0]?.text).toContain('cache hit count is zero');

    // Still present in the store — rejection is audit, not delete.
    expect(findHypothesis(store, h.id)).not.toBeNull();
    expect(getHypothesisSummary(store).rejected).toBe(1);
  });

  it('support is a no-op on a previously rejected hypothesis', () => {
    const store = getOrCreateStore('gs-test-5');
    const h = addHypothesis(store, 'route is down', []);
    rejectHypothesis(store, h.id, 'route table is fine');
    const reSupport = supportHypothesis(store, h.id);
    expect(reSupport).toBeNull();
    expect(findHypothesis(store, h.id)?.status).toBe('rejected');
  });

  it('mutations on unknown hypothesis ids return null (caller-facing error path)', () => {
    const store = getOrCreateStore('gs-test-6');
    expect(addEvidence(store, 'nope', 'x')).toBeNull();
    expect(completeCheck(store, 'nope', 0)).toBeNull();
    expect(rejectHypothesis(store, 'nope', 'reason')).toBeNull();
    expect(supportHypothesis(store, 'nope')).toBeNull();
  });

  it('completeCheck rejects out-of-range index without mutating other checks', () => {
    const store = getOrCreateStore('gs-test-7');
    const h = addHypothesis(store, 'h', ['only check']);
    expect(completeCheck(store, h.id, 5)).toBeNull();
    expect(completeCheck(store, h.id, -1)).toBeNull();
    expect(findHypothesis(store, h.id)?.required_checks[0]?.done).toBe(false);
  });

  it('mixed session: counts reflect supported + rejected + unverified at once', () => {
    const store = getOrCreateStore('gs-mixed');
    const a = addHypothesis(store, 'A', []);
    const b = addHypothesis(store, 'B', ['c1']);
    addHypothesis(store, 'C', []); // left unverified

    addEvidence(store, a.id, 'evidence for A');
    rejectHypothesis(store, b.id, 'B is wrong');

    expect(getHypothesisSummary(store)).toEqual({
      total: 3,
      unverified: 1,
      supported: 1,
      rejected: 1,
      pending_checks: 1,
    });
  });
});
