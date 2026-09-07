import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ASSESSMENT_POLICY, PHASES, assessSnapshot, detectClaimType, deriveContext, dossierProjection, evaluateClaim, normalizeKeyword, phasePlan,
  type AssessmentSnapshot,
} from '../src/grounding-assessment-policy.js';

const corpus = new URL('../contracts/grounding-receipt-v1/', import.meta.url);
const policyBytes = readFileSync(new URL('policy.json', corpus));
const policy = JSON.parse(policyBytes.toString());
const vectors = JSON.parse(readFileSync(new URL('policy-vectors.json', corpus), 'utf8'));
function snapshot(): AssessmentSnapshot {
  return {
    id: '11111111-1111-4111-8111-111111111111', revision: 10,
    binding: { audience: 'consumer.test', projectId: '22222222-2222-4222-8222-222222222222', taskId: '33333333-3333-4333-8333-333333333333', subject: { kind: 'task-context/v1', digest: 'a'.repeat(64) } },
    keyword: 'service', problem: 'Documentary investigation',
    events: phasePlan('service').slice(0, -1).map((step, i) => ({ ...step, origin: 'producer_api_agent_confirmation', revision: i + 2 })),
    entries: [
      { id: '44444444-4444-4444-8444-444444444444', kind: 'fact', content: 'Invented observation', source: 'agent statement', origin: 'agent_asserted', revision: 8 },
      { id: '55555555-5555-4555-8555-555555555555', kind: 'rejected', content: 'Invented alternative', source: '', origin: 'agent_asserted', revision: 9 },
    ],
    claim: { text: 'Root cause identified', origin: 'agent_asserted', revision: 10 },
  };
}
const assess = (s: AssessmentSnapshot) => assessSnapshot(s, { sessionId: s.id, revision: s.revision, binding: s.binding });

describe('frozen policy independent corpus comparisons', () => {
  it('pins the literal policy bytes and selected phase rules', () => {
    expect(ASSESSMENT_POLICY).toEqual({ id: policy.id, revision: policy.revision, sha256: createHash('sha256').update(policyBytes).digest('hex') });
    expect(PHASES).toEqual(policy.phases.ordered);
    for (const keyword of ['plain', ...policy.phases.conditionalInsertion.keywordIncludesAny]) {
      const runtime = policy.phases.conditionalInsertion.keywordIncludesAny.some((word: string) => keyword.includes(word));
      const expected = policy.phases.ordered.slice(0, -1).filter((phase: string) => phase !== 'runtime-inspection' || runtime).map((phase: string) => ({
        phase, tools: policy.phases.steps.filter((step: { phase: string }) => step.phase === phase).map((step: { tool: string }) => step.tool),
      }));
      expect(phasePlan(keyword)).toEqual(expected);
    }
    expect(normalizeKeyword(' My_Service! ')).toBe('my-service');
    for (const bad of ['', '!!', ' '.repeat(4), 'x'.repeat(65)]) expect(() => normalizeKeyword(bad)).toThrow();
    expect(phasePlan('ser vice').some((step) => step.phase === 'runtime-inspection')).toBe(false);
    expect(phasePlan('SERVICE').some((step) => step.phase === 'runtime-inspection')).toBe(true);
  });

  it.each(vectors.claimDetection)('detects $claim as $expectedType', ({ claim, expectedType }) => {
    expect(detectClaimType(claim)).toBe(expectedType);
  });

  it.each(vectors.claimPrerequisites)('derives prerequisite class $id from concrete snapshot fields', (vector) => {
    const s = snapshot();
    s.claim!.text = vector.claim;
    const focus = vector.focusPrerequisite;
    if (focus === 'readme_read') s.events = s.events.filter((event) => event.phase !== 'doc-reading');
    if (['process_checked', 'config_checked', 'health_checked'].includes(focus)) s.events = s.events.filter((event) => event.phase !== 'runtime-inspection');
    if (focus === 'has_evidence') s.entries = s.entries.filter((entry) => entry.kind !== 'fact');
    if (focus === 'alternatives_considered') s.entries = s.entries.filter((entry) => entry.kind !== 'rejected');
    const result = evaluateClaim(s);
    expect(result.type).toBe(vector.type);
    expect(result.context).toEqual(vector.expectedDerivedContext);
    expect(result.allowed).toBe(vector.expectedClaimAllowed);
    expect(result.missing).toEqual(vector.expectedMissing);
    const requires: string[] = policy.claim.prerequisites[result.type];
    expect(result.missing).toEqual(requires.filter((name) => !result.context[name as keyof typeof result.context]));
    expect(result.score).toBe(Math.round((requires.length - result.missing.length) / requires.length * 100));
  });

  it('N-19 orders regular reasons and requires producer events, facts, and an actual claim', () => {
    const s = snapshot();
    s.events = []; s.entries = []; s.claim = null;
    const result = assessSnapshot(s, { sessionId: 'other', revision: 20, binding: { ...s.binding, audience: 'other' } });
    expect(result.reasons).toEqual(policy.reasonCodes.slice(0, -1));
    s.claim = { text: 'root cause', origin: 'agent_asserted', revision: 10 };
    expect(assess(s).reasons).toEqual(['mandatory_steps_incomplete', 'fact_missing', 'claim_prerequisites_missing']);
    const reordered = snapshot();
    [reordered.events[0], reordered.events[1]] = [reordered.events[1], reordered.events[0]];
    expect(assess(reordered).reasons).toEqual(['mandatory_steps_incomplete']);
    const forged = snapshot();
    forged.events[3].origin = 'agent_asserted' as never;
    expect(assess(forged).reasons).toEqual(['mandatory_steps_incomplete', 'claim_prerequisites_missing']);
  });

  it('counts only nonblank agent_asserted facts, keeping skipped-runtime context producer derived', () => {
    for (const change of [
      { kind: 'hypothesis' }, { content: '  \n ' }, { content: null }, { origin: 'execution_verified' },
    ]) {
      const s = snapshot(); Object.assign(s.entries[0], change);
      expect(assess(s).reasons).toEqual(['fact_missing', 'claim_prerequisites_missing']);
    }
    const s = snapshot(); s.keyword = 'plain';
    s.events = phasePlan('plain').slice(0, -1).map((step, i) => ({ ...step, origin: 'producer_api_agent_confirmation', revision: i + 2 }));
    expect(deriveContext(s).process_checked).toBe(true);
    expect(assess(s).outcome).toBe('pass');
    s.events = []; expect(deriveContext(s).process_checked).toBe(false);
  });

  it('N-20 hashes snapshot identity, concrete provenance, claim and computed evaluation', () => {
    const s = snapshot();
    const original = assess(s);
    expect(original).toMatchObject({ outcome: 'pass', evidenceOrigin: 'agent_asserted', factCount: 1 });
    const projection = dossierProjection(s);
    expect(projection.claimEvaluation).toEqual(evaluateClaim(s));
    expect(original.dossierSha256).toBe(createHash('sha256').update(JSON.stringify(projection)).digest('hex'));
    for (const mutate of [
      (x: AssessmentSnapshot) => { x.entries[0].source = 'different source'; },
      (x: AssessmentSnapshot) => { x.entries[0].content = 'different statement'; },
      (x: AssessmentSnapshot) => { x.entries[0].origin = 'execution_verified' as never; },
      (x: AssessmentSnapshot) => { x.claim!.text = 'architecture'; },
      (x: AssessmentSnapshot) => { x.revision += 1; },
      (x: AssessmentSnapshot) => { x.events.pop(); },
    ]) {
      const copy = structuredClone(s); mutate(copy);
      expect(assess(copy).dossierSha256).not.toBe(original.dossierSha256);
    }
  });
});
