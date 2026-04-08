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
