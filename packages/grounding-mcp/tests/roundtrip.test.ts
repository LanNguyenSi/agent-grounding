// End-to-end round-trip exercising the full session lifecycle through the
// same code paths the MCP server uses. Skips the StdioServerTransport layer
// — that's an SDK concern, not ours — and asserts that:
//   1. A session starts in scope-resolution
//   2. advancePhase persists state across save/load
//   3. Ledger entries are isolated per sessionId
//   4. claim_evaluate_from_session derives context from session + ledger
//   5. Adding evidence flips a previously-blocked claim to allowed
//
// Each test uses isolated GROUNDING_MCP_SESSIONS_DIR + EVIDENCE_LEDGER_DB
// paths so the host's real ~/.grounding-mcp/ and ~/.evidence-ledger/ are
// never touched.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initSession, advancePhase } from '@lannguyensi/grounding-wrapper';
import { addEntry, getSummary } from '@lannguyensi/evidence-ledger';
import { evaluateClaim } from '@lannguyensi/claim-gate';
import { verifyMemoryReference } from 'runtime-reality-checker';

import { saveSession, loadSession, sessionExists } from '../src/session-store.js';
import { ledgerDb, resetLedgerDb } from '../src/ledger-bridge.js';
import { deriveContext } from '../src/derive-context.js';

let tmpRoot: string;
let prevSessionsDir: string | undefined;
let prevLedgerDb: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'grounding-mcp-'));
  prevSessionsDir = process.env.GROUNDING_MCP_SESSIONS_DIR;
  prevLedgerDb = process.env.EVIDENCE_LEDGER_DB;
  process.env.GROUNDING_MCP_SESSIONS_DIR = join(tmpRoot, 'sessions');
  process.env.EVIDENCE_LEDGER_DB = join(tmpRoot, 'ledger.db');
  resetLedgerDb();
});

afterEach(() => {
  resetLedgerDb();
  if (prevSessionsDir === undefined) delete process.env.GROUNDING_MCP_SESSIONS_DIR;
  else process.env.GROUNDING_MCP_SESSIONS_DIR = prevSessionsDir;
  if (prevLedgerDb === undefined) delete process.env.EVIDENCE_LEDGER_DB;
  else process.env.EVIDENCE_LEDGER_DB = prevLedgerDb;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('grounding-mcp round trip', () => {
  it('persists session state across save/advance/load', () => {
    const session = initSession({ keyword: 'agent-grounding', problem: 'test session lifecycle' });
    saveSession(session);
    expect(sessionExists(session.id)).toBe(true);

    const loaded1 = loadSession(session.id);
    expect(loaded1.current_phase).toBe('scope-resolution');

    advancePhase(loaded1);
    saveSession(loaded1);

    const loaded2 = loadSession(session.id);
    expect(loaded2.current_phase).toBe('doc-reading');
    expect(loaded2.phase_status['scope-resolution']).toBe('done');

    advancePhase(loaded2);
    saveSession(loaded2);

    const loaded3 = loadSession(session.id);
    expect(loaded3.current_phase).toBe('playbook-loading');
    expect(loaded3.phase_status['doc-reading']).toBe('done');
  });

  it('namespaces ledger entries by sessionId', () => {
    const a = initSession({ keyword: 'a', problem: 'p' });
    const b = initSession({ keyword: 'b', problem: 'p' });
    addEntry(ledgerDb(), { type: 'fact', content: 'a-fact-1', session: a.id });
    addEntry(ledgerDb(), { type: 'fact', content: 'a-fact-2', session: a.id });
    addEntry(ledgerDb(), { type: 'hypothesis', content: 'b-h-1', session: b.id });

    const sumA = getSummary(ledgerDb(), a.id);
    const sumB = getSummary(ledgerDb(), b.id);
    expect(sumA.facts).toHaveLength(2);
    expect(sumA.hypotheses).toHaveLength(0);
    expect(sumB.facts).toHaveLength(0);
    expect(sumB.hypotheses).toHaveLength(1);
  });

  it('claim-gate blocks then allows once evidence + alternatives are logged', () => {
    const session = initSession({ keyword: 'deploy-panel', problem: 'frontend offline' });
    saveSession(session);

    // Initial verdict on a root_cause claim — no evidence, no alternatives,
    // no phases done. Should be blocked across multiple prerequisites.
    const initial = evaluateClaim(
      'the root cause is a missing env variable',
      { has_evidence: false, alternatives_considered: false },
    );
    expect(initial.allowed).toBe(false);
    expect(initial.next_steps.length).toBeGreaterThan(0);

    // Advance through doc-reading + runtime-inspection so the derived
    // context will reflect those phases done. Skip phases via the wrapper
    // so we don't have to fake step completion by hand.
    let s = loadSession(session.id);
    while (s.current_phase !== 'evidence-collection') {
      advancePhase(s);
    }
    saveSession(s);

    // Add a fact + a rejected alternative — covers has_evidence + alternatives_considered.
    addEntry(ledgerDb(), { type: 'fact', content: 'env REACT_PROXY missing', session: session.id });
    addEntry(ledgerDb(), {
      type: 'rejected',
      content: 'CDN cache stale [rejected: cache hit count is zero]',
      session: session.id,
    });

    const summary = getSummary(ledgerDb(), session.id);
    s = loadSession(session.id);
    const derived = deriveContext(s, summary);
    const final = evaluateClaim('the root cause is a missing env variable', derived);

    expect(final.allowed).toBe(true);
    expect(final.score).toBe(100);
  });

  it('verify_memory_reference round-trip — positive and negative case for kind:path', () => {
    // Drop a file inside our temp root and verify a ref that points at
    // it, then at a sibling that does not exist. The MCP tool handler
    // just forwards its args into this same function, so exercising it
    // here catches any signature/shape drift before it hits the SDK.
    const { writeFileSync } = require('node:fs') as typeof import('node:fs');
    writeFileSync(join(tmpRoot, 'real.md'), '# hi\n');

    const hit = verifyMemoryReference({
      kind: 'path',
      value: 'real.md',
      repoRoot: tmpRoot,
    });
    expect(hit.exists).toBe(true);
    expect(hit.foundIn).toHaveLength(1);
    expect(hit.summary).toMatch(/exists/);

    const miss = verifyMemoryReference({
      kind: 'path',
      value: 'ghost.md',
      repoRoot: tmpRoot,
    });
    expect(miss.exists).toBe(false);
    expect(miss.foundIn).toEqual([]);
  });

  it('round-trips a complete advance chain to "complete" phase', () => {
    const session = initSession({ keyword: 'agent-tasks', problem: 'sequence smoke' });
    saveSession(session);

    let s = loadSession(session.id);
    let safety = 20;
    while (s.current_phase !== 'complete' && safety-- > 0) {
      advancePhase(s);
    }
    saveSession(s);

    expect(s.current_phase).toBe('complete');
    const reloaded = loadSession(session.id);
    expect(reloaded.current_phase).toBe('complete');
  });
});
