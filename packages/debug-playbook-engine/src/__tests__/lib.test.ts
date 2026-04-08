import {
  getPlaybook,
  initRun,
  getCurrentStep,
  recordStep,
  getRemainingMandatory,
  canMakeClaim,
} from '../lib';

describe('getPlaybook', () => {
  it('returns clawd-monitor playbook for exact match', () => {
    const pb = getPlaybook('clawd-monitor', 'agent not visible');
    expect(pb.domain).toBe('clawd-monitor');
    expect(pb.steps.length).toBeGreaterThan(0);
  });

  it('falls back to generic for unknown domain', () => {
    const pb = getPlaybook('unknown-service', 'something broken');
    expect(pb.name).toContain('generic');
  });

  it('sets problem on playbook', () => {
    const pb = getPlaybook('github', 'api not responding');
    expect(pb.problem).toBe('api not responding');
  });

  it('initializes all steps as pending', () => {
    const pb = getPlaybook('clawd-monitor', 'test');
    for (const step of pb.steps) {
      expect(step.status).toBe('pending');
    }
  });
});

describe('initRun', () => {
  it('creates run state with step 0', () => {
    const pb = getPlaybook('clawd-monitor', 'test');
    const state = initRun(pb);
    expect(state.current_step).toBe(0);
    expect(state.completed).toBe(false);
    expect(state.facts).toEqual({});
  });
});

describe('getCurrentStep', () => {
  it('returns first step initially', () => {
    const pb = getPlaybook('clawd-monitor', 'test');
    const state = initRun(pb);
    const step = getCurrentStep(state);
    expect(step?.id).toBe('check-repo-model');
  });

  it('returns null when all steps done', () => {
    const pb = getPlaybook('clawd-monitor', 'test');
    const state = initRun(pb);
    state.current_step = pb.steps.length;
    state.completed = true;
    expect(getCurrentStep(state)).toBeNull();
  });
});

describe('recordStep', () => {
  it('marks step as done and advances', () => {
    const pb = getPlaybook('clawd-monitor', 'test');
    const state = initRun(pb);
    const firstStep = pb.steps[0];

    const result = recordStep(state, firstStep.id, 'done', 'README confirmed');
    expect(result.status).toBe('done');
    expect(result.blocked).toBe(false);
    expect(state.facts[firstStep.id]).toBe('README confirmed');
  });

  it('blocks if mandatory step is skipped', () => {
    const pb = getPlaybook('clawd-monitor', 'test');
    const state = initRun(pb);
    // Try to record step 2 before step 0 is done
    const result = recordStep(state, 'check-network', 'done');
    expect(result.blocked).toBe(true);
    expect(result.blocked_reason).toBeDefined();
  });

  it('returns error for unknown step', () => {
    const pb = getPlaybook('clawd-monitor', 'test');
    const state = initRun(pb);
    const result = recordStep(state, 'nonexistent-step', 'done');
    expect(result.blocked).toBe(true);
  });

  it('marks completed when all steps done', () => {
    const pb = getPlaybook('generic', 'test');
    const state = initRun(pb);

    for (const step of pb.steps) {
      recordStep(state, step.id, 'done');
    }
    expect(state.completed).toBe(true);
  });

  it('provides next step in result', () => {
    const pb = getPlaybook('clawd-monitor', 'test');
    const state = initRun(pb);
    const result = recordStep(state, pb.steps[0].id, 'done');
    expect(result.next_step?.id).toBe(pb.steps[1].id);
  });
});

describe('getRemainingMandatory', () => {
  it('returns all mandatory pending steps initially', () => {
    const pb = getPlaybook('clawd-monitor', 'test');
    const state = initRun(pb);
    const mandatory = getRemainingMandatory(state);
    expect(mandatory.every(s => s.mandatory)).toBe(true);
    expect(mandatory.length).toBeGreaterThan(0);
  });

  it('decreases after completing a step', () => {
    const pb = getPlaybook('clawd-monitor', 'test');
    const state = initRun(pb);
    const before = getRemainingMandatory(state).length;
    recordStep(state, pb.steps[0].id, 'done');
    const after = getRemainingMandatory(state).length;
    expect(after).toBeLessThan(before);
  });
});

describe('verify-fix step', () => {
  it('exists as last step in all built-in playbooks', () => {
    for (const domain of ['clawd-monitor', 'github', 'generic']) {
      const pb = getPlaybook(domain, 'test');
      const lastStep = pb.steps[pb.steps.length - 1];
      expect(lastStep.id).toBe('verify-fix');
      expect(lastStep.mandatory).toBe(true);
    }
  });

  it('cannot be skipped', () => {
    const pb = getPlaybook('generic', 'test');
    const state = initRun(pb);

    // Complete all steps except verify-fix
    for (const step of pb.steps) {
      if (step.id === 'verify-fix') break;
      recordStep(state, step.id, 'done');
    }

    const result = recordStep(state, 'verify-fix', 'skipped');
    expect(result.blocked).toBe(true);
    expect(result.blocked_reason).toContain('Cannot skip mandatory step');
  });

  it('can be completed with done status', () => {
    const pb = getPlaybook('generic', 'test');
    const state = initRun(pb);

    for (const step of pb.steps) {
      if (step.id === 'verify-fix') break;
      recordStep(state, step.id, 'done');
    }

    const result = recordStep(state, 'verify-fix', 'done', 'Problem no longer reproducible');
    expect(result.blocked).toBe(false);
    expect(result.completed).toBe(true);
    expect(result.status).toBe('done');
  });

  it('can be recorded as failed', () => {
    const pb = getPlaybook('generic', 'test');
    const state = initRun(pb);

    for (const step of pb.steps) {
      if (step.id === 'verify-fix') break;
      recordStep(state, step.id, 'done');
    }

    const result = recordStep(state, 'verify-fix', 'failed', 'Problem still reproducible');
    expect(result.blocked).toBe(false);
    expect(result.status).toBe('failed');
  });

  it('blocks any mandatory step from being skipped', () => {
    const pb = getPlaybook('clawd-monitor', 'test');
    const state = initRun(pb);

    // Try to skip the first mandatory step
    const result = recordStep(state, 'check-repo-model', 'skipped');
    expect(result.blocked).toBe(true);
    expect(result.blocked_reason).toContain('Cannot skip mandatory step');
  });
});

describe('canMakeClaim', () => {
  it('blocks root-cause claim before any steps done', () => {
    const pb = getPlaybook('clawd-monitor', 'test');
    const state = initRun(pb);
    const result = canMakeClaim(state, 'root-cause');
    expect(result.allowed).toBe(false);
    expect(result.reason?.length).toBeGreaterThan(0);
  });

  it('allows config claim after check-config is done', () => {
    const pb = getPlaybook('clawd-monitor', 'test');
    const state = initRun(pb);
    // Complete mandatory steps in order to reach check-config
    for (const step of pb.steps) {
      if (step.id === 'check-config') break;
      recordStep(state, step.id, 'done');
    }
    recordStep(state, 'check-config', 'done');

    const result = canMakeClaim(state, 'config');
    expect(result.allowed).toBe(true);
  });
});
