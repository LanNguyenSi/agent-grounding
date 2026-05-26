// Exercises the in-memory hypothesis store + the tracker functions that
// back the `hypothesis_*` MCP tools. The MCP SDK's tool handlers just
// forward args into these, so testing the data layer + adapter pattern
// is enough to catch contract drift.

import { beforeEach, describe, expect, it } from 'vitest';

import {
  addEvidence,
  addHypothesis,
  completeCheck,
  findHypothesis,
  getSummary as getHypothesisSummary,
  rejectHypothesis,
  supportHypothesis,
} from '@lannguyensi/hypothesis-tracker';

import { getOrCreateStore, getStore, resetStores } from '../src/hypothesis-store.js';

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
