export type StepStatus = 'pending' | 'done' | 'skipped' | 'failed';

export interface PlaybookStep {
  id: string;
  action: string;
  mandatory: boolean;
  description?: string;
  status?: StepStatus;
  result?: string;
}

export interface Playbook {
  name: string;
  domain: string;
  problem: string;
  steps: PlaybookStep[];
}

export interface RunState {
  playbook: Playbook;
  current_step: number;
  completed: boolean;
  facts: Record<string, string>;
  blocked_reason?: string;
}

export interface StepResult {
  step_id: string;
  status: StepStatus;
  result?: string;
  next_step?: PlaybookStep;
  completed: boolean;
  blocked: boolean;
  blocked_reason?: string;
}

/** Built-in playbooks for known domains */
const BUILTIN_PLAYBOOKS: Record<string, Omit<Playbook, 'problem'>> = {
  'clawd-monitor': {
    name: 'clawd-monitor.basic-connectivity',
    domain: 'clawd-monitor',
    steps: [
      { id: 'check-repo-model', action: 'Verify architecture summary from README', mandatory: true },
      { id: 'check-agent-process', action: 'Verify clawd-monitor-agent is running', mandatory: true },
      { id: 'check-start-mode', action: 'Determine whether agent is manual, docker, or systemd started', mandatory: true },
      { id: 'check-config', action: 'Verify authoritative env/token source', mandatory: true },
      { id: 'check-network', action: 'Verify target URL reachability (only after process/config confirmed)', mandatory: false },
      { id: 'verify-fix', action: 'Verify the original problem is no longer reproducible', mandatory: true },
    ],
  },
  'github': {
    name: 'github.api-connectivity',
    domain: 'github',
    steps: [
      { id: 'check-token', action: 'Verify GITHUB_TOKEN is set and valid', mandatory: true },
      { id: 'check-rate-limit', action: 'Check API rate limit status', mandatory: true },
      { id: 'check-repo-access', action: 'Verify access to target repository', mandatory: true },
      { id: 'check-permissions', action: 'Verify required scopes are present', mandatory: false },
      { id: 'verify-fix', action: 'Verify the original problem is no longer reproducible', mandatory: true },
    ],
  },
  'generic': {
    name: 'generic.basic-diagnosis',
    domain: 'generic',
    steps: [
      { id: 'read-docs', action: 'Read README and primary documentation', mandatory: true },
      { id: 'check-process', action: 'Verify the main process/service is running', mandatory: true },
      { id: 'check-config', action: 'Verify configuration is valid and complete', mandatory: true },
      { id: 'check-dependencies', action: 'Verify all dependencies are reachable', mandatory: false },
      { id: 'check-logs', action: 'Review recent logs for errors', mandatory: false },
      { id: 'verify-fix', action: 'Verify the original problem is no longer reproducible', mandatory: true },
    ],
  },
};

/** Get playbook for a domain, falling back to generic */
export function getPlaybook(domain: string, problem: string): Playbook {
  const normalized = domain.toLowerCase().replace(/[-_\s]+/g, '-');

  // Try exact match first, then prefix match
  const template = BUILTIN_PLAYBOOKS[normalized] ??
    Object.entries(BUILTIN_PLAYBOOKS).find(([k]) => normalized.includes(k) || k.includes(normalized))?.[1] ??
    BUILTIN_PLAYBOOKS['generic'];

  return {
    ...template,
    problem,
    steps: template.steps.map(s => ({ ...s, status: 'pending' })),
  };
}

/** Initialize a run state from a playbook */
export function initRun(playbook: Playbook): RunState {
  return {
    playbook: { ...playbook },
    current_step: 0,
    completed: false,
    facts: {},
  };
}

/** Get the current step */
export function getCurrentStep(state: RunState): PlaybookStep | null {
  return state.playbook.steps[state.current_step] ?? null;
}

/** Record a step result and advance */
export function recordStep(
  state: RunState,
  stepId: string,
  status: StepStatus,
  result?: string
): StepResult {
  const steps = state.playbook.steps;
  const idx = steps.findIndex(s => s.id === stepId);

  if (idx === -1) {
    return {
      step_id: stepId,
      status: 'failed',
      completed: false,
      blocked: true,
      blocked_reason: `Step "${stepId}" not found in playbook`,
    };
  }

  // Mandatory steps cannot be skipped
  if (steps[idx].mandatory && status === 'skipped') {
    return {
      step_id: stepId,
      status: 'pending',
      completed: false,
      blocked: true,
      blocked_reason: `Cannot skip mandatory step "${stepId}"`,
    };
  }

  // Cannot jump ahead past mandatory steps
  if (idx !== state.current_step) {
    const currentStep = steps[state.current_step];
    if (currentStep?.mandatory && currentStep.status === 'pending') {
      return {
        step_id: stepId,
        status: 'pending',
        completed: false,
        blocked: true,
        blocked_reason: `Must complete mandatory step "${currentStep.id}" first`,
      };
    }
  }

  steps[idx] = { ...steps[idx], status, result };
  if (result) state.facts[stepId] = result;

  // Advance to next pending step
  state.current_step = steps.findIndex((s, i) => i > idx && s.status === 'pending');
  if (state.current_step === -1) {
    state.current_step = steps.length;
    state.completed = true;
  }

  const nextStep = state.current_step < steps.length ? steps[state.current_step] : undefined;

  return {
    step_id: stepId,
    status,
    result,
    next_step: nextStep,
    completed: state.completed,
    blocked: false,
  };
}

/** Get summary of remaining mandatory steps */
export function getRemainingMandatory(state: RunState): PlaybookStep[] {
  return state.playbook.steps.filter(s => s.mandatory && s.status === 'pending');
}

/** Check if a claim is allowed given completed steps */
export function canMakeClaim(
  state: RunState,
  claimType: 'root-cause' | 'architecture' | 'config' | 'network'
): { allowed: boolean; reason?: string[] } {
  const doneSteps = new Set(
    state.playbook.steps.filter(s => s.status === 'done').map(s => s.id)
  );

  const requirements: Record<string, string[]> = {
    'root-cause': ['check-repo-model', 'read-docs', 'check-process'],
    'architecture': ['check-repo-model', 'read-docs'],
    'config': ['check-config'],
    'network': ['check-process', 'check-config'],
  };

  const required = requirements[claimType] ?? [];
  const missing = required.filter(r => !doneSteps.has(r));

  if (missing.length > 0) {
    return {
      allowed: false,
      reason: missing.map(r => `Required step not completed: ${r}`),
    };
  }

  return { allowed: true };
}
