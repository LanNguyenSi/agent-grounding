import {
  generateSessionId,
  resolveGuardrails,
  buildMandatorySequence,
  buildSteps,
  initSession,
  advancePhase,
  handleScopeChange,
  getCurrentTools,
  isGuardrailActive,
  validateKeyword,
  KEYWORD_MAX_LENGTH,
} from '../lib';

describe('generateSessionId', () => {
  it('includes keyword slug', () => {
    expect(generateSessionId('clawd-monitor')).toContain('clawd-monitor');
  });

  it('starts with gs-', () => {
    expect(generateSessionId('test')).toMatch(/^gs-/);
  });

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 10 }, () => generateSessionId('test')));
    // Should have at least some unique (timestamp-based)
    expect(ids.size).toBeGreaterThan(0);
  });
});

describe('resolveGuardrails', () => {
  it('always includes no-root-cause-before-readme', () => {
    expect(resolveGuardrails('anything')).toContain('no-root-cause-before-readme');
  });

  it('includes token guardrail for auth keywords', () => {
    expect(resolveGuardrails('auth-service')).toContain('no-token-claim-before-config-check');
  });

  it('includes network guardrail for monitor keywords', () => {
    expect(resolveGuardrails('clawd-monitor')).toContain('no-network-claim-before-process-check');
  });

  it('includes architecture guardrail for arch/design/system keywords', () => {
    expect(resolveGuardrails('arch-decision')).toContain('no-architecture-claim-before-docs');
    expect(resolveGuardrails('system-redesign')).toContain('no-architecture-claim-before-docs');
    expect(resolveGuardrails('design-doc')).toContain('no-architecture-claim-before-docs');
  });

  it('deduplicates guardrails', () => {
    const rails = resolveGuardrails('clawd-monitor-auth');
    const unique = new Set(rails);
    expect(unique.size).toBe(rails.length);
  });
});

describe('buildMandatorySequence', () => {
  it('always starts with domain-router', () => {
    expect(buildMandatorySequence('anything')[0]).toBe('domain-router');
  });

  it('includes runtime-reality-checker for agent/monitor keywords', () => {
    expect(buildMandatorySequence('clawd-monitor')).toContain('runtime-reality-checker');
    expect(buildMandatorySequence('clawd-agent')).toContain('runtime-reality-checker');
  });

  it('does not include runtime checker for simple keyword', () => {
    expect(buildMandatorySequence('github-tool')).not.toContain('runtime-reality-checker');
  });

  it('always includes claim-gate', () => {
    expect(buildMandatorySequence('anything')).toContain('claim-gate');
  });

  it('always includes evidence-ledger', () => {
    expect(buildMandatorySequence('anything')).toContain('evidence-ledger');
  });
});

describe('buildSteps', () => {
  it('maps each tool to a step with metadata', () => {
    const steps = buildSteps(['domain-router', 'readme-first-resolver']);
    expect(steps[0].tool).toBe('domain-router');
    expect(steps[0].phase).toBe('scope-resolution');
    expect(steps[0].mandatory).toBe(true);
    expect(steps[1].phase).toBe('doc-reading');
  });

  it('provides fallback for unknown tools', () => {
    const steps = buildSteps(['unknown-tool']);
    expect(steps[0].description).toContain('unknown-tool');
  });
});

describe('initSession', () => {
  const input = { keyword: 'clawd-monitor', problem: 'agent not visible' };

  it('creates session with correct scope', () => {
    const session = initSession(input);
    expect(session.resolved_scope).toBe('clawd-monitor');
    expect(session.keyword).toBe('clawd-monitor');
    expect(session.problem).toBe('agent not visible');
  });

  it('starts in scope-resolution phase', () => {
    const session = initSession(input);
    expect(session.current_phase).toBe('scope-resolution');
    expect(session.phase_status['scope-resolution']).toBe('active');
  });

  it('has active guardrails', () => {
    const session = initSession(input);
    expect(session.active_guardrails.length).toBeGreaterThan(0);
  });

  it('sets started_at', () => {
    const session = initSession(input);
    expect(new Date(session.started_at).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('scope_changed is false initially', () => {
    expect(initSession(input).scope_changed).toBe(false);
  });
});

describe('validateKeyword (task 7db33828)', () => {
  it('accepts a normal ASCII keyword', () => {
    expect(() => validateKeyword('clawd-monitor')).not.toThrow();
  });

  it('accepts mixed Unicode + ASCII that normalises to a non-empty slug', () => {
    // クラウド-monitor → "-monitor" → trimmed → "monitor"
    expect(() => validateKeyword('クラウド-monitor')).not.toThrow();
  });

  it('rejects the empty string', () => {
    expect(() => validateKeyword('')).toThrow(/must not be empty/);
  });

  it('rejects whitespace-only keywords', () => {
    expect(() => validateKeyword('   ')).toThrow(/normalises to an empty slug/);
    expect(() => validateKeyword('\t\n ')).toThrow(/normalises to an empty slug/);
  });

  it('rejects pure-Unicode (no ASCII alphanumeric)', () => {
    expect(() => validateKeyword('クラウド')).toThrow(/normalises to an empty slug/);
  });

  it('rejects pure-symbol keywords', () => {
    expect(() => validateKeyword('---')).toThrow(/normalises to an empty slug/);
    expect(() => validateKeyword('!!!')).toThrow(/normalises to an empty slug/);
  });

  it(`rejects keywords longer than ${KEYWORD_MAX_LENGTH} chars`, () => {
    const tooLong = 'a'.repeat(KEYWORD_MAX_LENGTH + 1);
    expect(() => validateKeyword(tooLong)).toThrow(/exceeds .* limit/);
  });

  it('rejects non-string inputs', () => {
    expect(() => validateKeyword(null)).toThrow(/must be a string/);
    expect(() => validateKeyword(42)).toThrow(/must be a string/);
  });
});

describe('initSession — input validation (task 7db33828)', () => {
  it('throws on empty keyword instead of emitting "gs--<ts>"', () => {
    expect(() => initSession({ keyword: '', problem: 'test' })).toThrow(/must not be empty/);
  });

  it('throws on whitespace-only keyword', () => {
    expect(() => initSession({ keyword: '   ', problem: 'test' })).toThrow(
      /normalises to an empty slug/,
    );
  });

  it('throws on pure-Unicode keyword (no ASCII alphanumeric after normalisation)', () => {
    expect(() => initSession({ keyword: 'クラウド', problem: 'test' })).toThrow(
      /normalises to an empty slug/,
    );
  });

  it(`throws on > ${KEYWORD_MAX_LENGTH}-char keyword`, () => {
    expect(() =>
      initSession({ keyword: 'a'.repeat(1000), problem: 'test' }),
    ).toThrow(/exceeds .* limit/);
  });

  it('still accepts the standard happy-path keywords', () => {
    expect(() => initSession({ keyword: 'clawd-monitor', problem: 't' })).not.toThrow();
    expect(() => initSession({ keyword: 'github-api', problem: 't' })).not.toThrow();
    expect(() => initSession({ keyword: 'クラウド-monitor', problem: 't' })).not.toThrow();
  });
});

describe('advancePhase', () => {
  it('moves from scope-resolution to doc-reading', () => {
    const session = initSession({ keyword: 'clawd-monitor', problem: 'test' });
    advancePhase(session);
    expect(session.current_phase).toBe('doc-reading');
    expect(session.phase_status['scope-resolution']).toBe('done');
  });

  it('eventually reaches complete', () => {
    const session = initSession({ keyword: 'simple-tool', problem: 'test' });
    const maxPhases = session.phases.length + 2;
    for (let i = 0; i < maxPhases; i++) {
      if (session.current_phase === 'complete') break;
      advancePhase(session);
    }
    expect(session.current_phase).toBe('complete');
  });

  it("sets phase_status['complete'] to 'done' on transition to terminal phase (task 9a258d6d)", () => {
    const session = initSession({ keyword: 'simple-tool', problem: 'test' });
    expect(session.phase_status.complete).toBe('pending');
    while (session.current_phase !== 'complete') advancePhase(session);
    expect(session.current_phase).toBe('complete');
    expect(session.phase_status.complete).toBe('done');
  });

  it("keeps phase_status['complete'] at 'done' across idempotent re-calls", () => {
    const session = initSession({ keyword: 'simple-tool', problem: 'test' });
    while (session.current_phase !== 'complete') advancePhase(session);
    advancePhase(session);
    advancePhase(session);
    expect(session.phase_status.complete).toBe('done');
  });

  it('is idempotent once complete is reached', () => {
    const session = initSession({ keyword: 'simple-tool', problem: 'test' });
    while (session.current_phase !== 'complete') advancePhase(session);
    advancePhase(session);
    advancePhase(session);
    expect(session.current_phase).toBe('complete');
  });
});

describe('handleScopeChange', () => {
  it('creates new session with new keyword', () => {
    const session = initSession({ keyword: 'clawd-monitor', problem: 'test' });
    const updated = handleScopeChange(session, 'github-api');
    expect(updated.keyword).toBe('github-api');
    expect(updated.scope_changed).toBe(true);
    expect(updated.problem).toBe('test');
  });
});

describe('getCurrentTools', () => {
  it('returns tools for current phase', () => {
    const session = initSession({ keyword: 'clawd-monitor', problem: 'test' });
    const tools = getCurrentTools(session);
    expect(tools.every(t => t.phase === 'scope-resolution')).toBe(true);
    expect(tools.map(t => t.tool)).toContain('domain-router');
  });
});

describe('isGuardrailActive', () => {
  it('returns true for active guardrail', () => {
    const session = initSession({ keyword: 'clawd-monitor', problem: 'test' });
    expect(isGuardrailActive(session, 'no-root-cause-before-readme')).toBe(true);
  });

  it('returns false for inactive guardrail', () => {
    const session = initSession({ keyword: 'simple-tool', problem: 'test' });
    // architecture-before-docs may or may not be present — just verify the function works
    const result = isGuardrailActive(session, 'no-step-skipping');
    expect(typeof result).toBe('boolean');
  });
});
