import { describe, expect, it } from 'vitest';

import { inspectPreflightPayload } from '../src/preflight-diagnostics.js';

const execution = { exitCode: 0, signal: null };
const payload = {
  ready: true,
  confidence: 0.9,
  checks: [{ name: 'lint', kind: 'lint', status: 'pass', durationMs: 1, confidenceContribution: 0.1 }],
  blockers: [],
  warnings: [],
  limitations: [],
  durationMs: 1,
  timestamp: '2026-05-30T00:00:00.000Z',
  additive: { kept: true },
};

describe('inspectPreflightPayload', () => {
  it('accepts the producer format and preserves its complete payload', () => {
    const result = inspectPreflightPayload(payload, execution);
    expect(result).toMatchObject({ availability: 'available', complete: true, payload, execution });
    expect(result.issues).toEqual([]);
  });

  it.each([
    ['confidence below range', { ...payload, confidence: -0.1 }, 'preflight confidence must be a number between 0 and 1'],
    ['confidence above range', { ...payload, confidence: 42 }, 'preflight confidence must be a number between 0 and 1'],
    ['non-canonical timestamp', { ...payload, timestamp: '1' }, 'preflight timestamp must be a canonical UTC ISO date string'],
    ['impossible calendar timestamp', { ...payload, timestamp: '2026-02-30T00:00:00.000Z' }, 'preflight timestamp must be a canonical UTC ISO date string'],
  ])('marks %s incomplete while preserving payload', (_name, invalidPayload, issue) => {
    const result = inspectPreflightPayload(invalidPayload, execution);
    expect(result.complete).toBe(false);
    expect(result.payload).toBe(invalidPayload);
    expect(result.issues).toContain(issue);
  });

  it.each([
    ['unknown exit', { exitCode: null, signal: null }, 'preflight exit code is unavailable'],
    ['signal', { exitCode: null, signal: 'SIGTERM' }, 'preflight ended with signal SIGTERM'],
  ])('marks %s incomplete', (_name, anomalousExecution, issue) => {
    const result = inspectPreflightPayload(payload, anomalousExecution);
    expect(result.complete).toBe(false);
    expect(result.payload).toBe(payload);
    expect(result.issues).toContain(issue);
  });

  it.each([null, 1, 'preflight'])('keeps scalar JSON available but incomplete', (scalar) => {
    const result = inspectPreflightPayload(scalar, execution);
    expect(result).toMatchObject({ availability: 'available', complete: false, payload: scalar });
    expect(result.issues).toContain('preflight JSON payload must be an object');
  });

  it.each([
    ['non-object check', [null], 'checks[0] must be an object'],
    ['invalid enum fields', [{ name: '', kind: 'unknown', status: 'other', durationMs: 1, confidenceContribution: 0 }], 'checks[0].kind is invalid'],
    ['invalid numeric fields', [{ name: 'lint', kind: 'lint', status: 'pass', durationMs: -1, confidenceContribution: Number.NaN }], 'checks[0].durationMs must be a non-negative number'],
    ['invalid optional fields', [{ name: 'lint', kind: 'lint', status: 'pass', durationMs: 1, confidenceContribution: 0, message: 1, details: [1] }], 'checks[0].message must be a string when present'],
  ])('marks malformed nested %s incomplete', (_name, checks, issue) => {
    const invalidPayload = { ...payload, checks };
    const result = inspectPreflightPayload(invalidPayload, execution);
    expect(result.complete).toBe(false);
    expect(result.payload).toBe(invalidPayload);
    expect(result.issues).toContain(issue);
  });

  it.each(['ready', 'confidence', 'checks', 'blockers', 'warnings', 'limitations', 'durationMs', 'timestamp'])(
    'marks missing %s incomplete',
    (field) => {
      const missing = { ...payload } as Record<string, unknown>;
      delete missing[field];
      expect(inspectPreflightPayload(missing, execution).complete).toBe(false);
    },
  );
});
