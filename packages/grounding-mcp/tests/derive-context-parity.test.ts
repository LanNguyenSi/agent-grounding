// Parity guard: the claim-context derivation exists twice, in
// grounding-mcp/src/derive-context.ts and in grounding-sdk/src/index.ts
// (deriveContextFromSession). The SDK deliberately does not depend on this
// package, so the two copies are kept in sync by hand. This test feeds both
// the same sessions and ledger summaries and asserts equal results, so a
// change to only one copy fails here.
//
// The SDK source is imported by relative path: neither package lists the
// other as a dependency, and tests are outside both tsconfig `include`s, so
// this adds no package dependency.

import { describe, expect, it } from 'vitest';
import type { GroundingSession } from '@lannguyensi/grounding-wrapper';
import type { LedgerSummary } from '@lannguyensi/evidence-ledger';
import { deriveContext } from '../src/derive-context.js';
import { deriveContextFromSession } from '../../grounding-sdk/src/index.js';

type Status = GroundingSession['phase_status'][keyof GroundingSession['phase_status']];

const STATUSES: Status[] = ['pending', 'active', 'done', 'skipped'];

function makeSession(docReading: Status, runtimeInspection: Status): GroundingSession {
  return {
    id: 'parity-session',
    phase_status: {
      'doc-reading': docReading,
      'runtime-inspection': runtimeInspection,
    },
  } as unknown as GroundingSession;
}

function entry(type: string, n: number) {
  return {
    id: `e${n}`,
    type,
    content: `entry ${n}`,
    source: null,
    confidence: 'confirmed',
    session: 'parity-session',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeSummary(facts: number, rejected: number): LedgerSummary {
  return {
    session: 'parity-session',
    facts: Array.from({ length: facts }, (_, i) => entry('fact', i)),
    hypotheses: [],
    rejected: Array.from({ length: rejected }, (_, i) => entry('rejected', i)),
    unknowns: [],
    policyDecisions: [],
  } as unknown as LedgerSummary;
}

const SUMMARIES: Array<[string, LedgerSummary]> = [
  ['no facts, none rejected', makeSummary(0, 0)],
  ['facts only', makeSummary(2, 0)],
  ['rejected only', makeSummary(0, 1)],
  ['facts and rejected', makeSummary(1, 3)],
];

describe('deriveContext (grounding-mcp) vs deriveContextFromSession (grounding-sdk)', () => {
  for (const docReading of STATUSES) {
    for (const runtime of STATUSES) {
      for (const [label, summary] of SUMMARIES) {
        it(`doc-reading=${docReading} runtime-inspection=${runtime}, ${label}`, () => {
          const session = makeSession(docReading, runtime);
          const fromMcp = deriveContext(session, summary);
          const fromSdk = deriveContextFromSession(session, summary);
          expect(fromSdk).toEqual(fromMcp);
        });
      }
    }
  }

  it('pins the satisfied-status mapping both copies must agree on', () => {
    const summary = makeSummary(0, 0);
    for (const [status, satisfied] of [
      ['pending', false],
      ['active', false],
      ['done', true],
      ['skipped', true],
    ] as Array<[Status, boolean]>) {
      const session = makeSession(status, status);
      for (const ctx of [deriveContext(session, summary), deriveContextFromSession(session, summary)]) {
        expect(ctx.readme_read).toBe(satisfied);
        expect(ctx.process_checked).toBe(satisfied);
        expect(ctx.config_checked).toBe(satisfied);
        expect(ctx.health_checked).toBe(satisfied);
      }
    }
  });
});
