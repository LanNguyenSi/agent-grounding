/**
 * Grounding Wrapper — orchestrates the full lan-tools grounding stack.
 *
 * Enforces the correct agent entry path before any debugging begins:
 *   1. Domain Router → resolve scope
 *   2. README First Resolver → read primary docs
 *   3. Debug Playbook Engine → load ordered steps
 *   4. Evidence Ledger → track facts
 *   5. Claim Gate → prevent premature claims
 *   6. Runtime Reality Checker → verify actual state
 *   7. Hypothesis Tracker → manage competing explanations
 */

export type GroundingPhase =
  | 'scope-resolution'
  | 'doc-reading'
  | 'playbook-loading'
  | 'runtime-inspection'
  | 'evidence-collection'
  | 'claim-evaluation'
  | 'complete';

export type GuardrailId =
  | 'no-root-cause-before-readme'
  | 'no-token-claim-before-config-check'
  | 'no-architecture-claim-before-docs'
  | 'no-network-claim-before-process-check'
  | 'no-step-skipping';

export interface GroundingInput {
  keyword: string;
  problem: string;
  workspace?: string;
}

export interface GroundingStep {
  tool: string;
  description: string;
  mandatory: boolean;
  phase: GroundingPhase;
}

export interface GroundingSession {
  id: string;
  keyword: string;
  problem: string;
  resolved_scope: string;
  mandatory_sequence: string[];
  active_guardrails: GuardrailId[];
  phases: GroundingPhase[];
  current_phase: GroundingPhase;
  steps: GroundingStep[];
  phase_status: Record<GroundingPhase, 'pending' | 'active' | 'done' | 'skipped'>;
  started_at: string;
  scope_changed: boolean;
}

/** Generate a simple session ID */
export function generateSessionId(keyword: string): string {
  const ts = Date.now().toString(36);
  const slug = keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 16);
  return `gs-${slug}-${ts}`;
}

/** Determine which guardrails apply for a given domain */
export function resolveGuardrails(keyword: string): GuardrailId[] {
  const k = keyword.toLowerCase();
  const rails: GuardrailId[] = [
    'no-root-cause-before-readme',
    'no-step-skipping',
  ];

  if (k.includes('token') || k.includes('auth') || k.includes('config')) {
    rails.push('no-token-claim-before-config-check');
  }
  if (k.includes('monitor') || k.includes('dashboard') || k.includes('agent')) {
    rails.push('no-token-claim-before-config-check');
    rails.push('no-network-claim-before-process-check');
  }
  if (k.includes('arch') || k.includes('design') || k.includes('system')) {
    rails.push('no-architecture-claim-before-docs');
  }

  // Always add these for any non-trivial domain
  rails.push('no-architecture-claim-before-docs');
  rails.push('no-network-claim-before-process-check');

  return [...new Set(rails)];
}

/** Build the ordered sequence of tools to invoke */
export function buildMandatorySequence(keyword: string): string[] {
  const base = [
    'domain-router',
    'readme-first-resolver',
    'debug-playbook-engine',
  ];

  // Always add evidence + claim gate
  base.push('evidence-ledger');
  base.push('claim-gate');

  // Runtime check for process/service keywords
  const k = keyword.toLowerCase();
  if (
    k.includes('monitor') ||
    k.includes('agent') ||
    k.includes('service') ||
    k.includes('server') ||
    k.includes('gateway')
  ) {
    base.splice(3, 0, 'runtime-reality-checker');
  }

  // Hypothesis tracker for complex multi-cause problems
  base.push('hypothesis-tracker');

  return base;
}

/** Build ordered steps with metadata */
export function buildSteps(sequence: string[]): GroundingStep[] {
  const meta: Record<string, { description: string; phase: GroundingPhase; mandatory: boolean }> = {
    'domain-router': {
      description: 'Resolve scope: identify primary repos, components, priority files',
      phase: 'scope-resolution',
      mandatory: true,
    },
    'readme-first-resolver': {
      description: 'Read primary documentation and build system mental model',
      phase: 'doc-reading',
      mandatory: true,
    },
    'debug-playbook-engine': {
      description: 'Load domain-specific diagnostic playbook and ordered steps',
      phase: 'playbook-loading',
      mandatory: true,
    },
    'runtime-reality-checker': {
      description: 'Verify actual runtime state: processes, startup mode, config source',
      phase: 'runtime-inspection',
      mandatory: true,
    },
    'evidence-ledger': {
      description: 'Track facts, hypotheses, and rejected explanations',
      phase: 'evidence-collection',
      mandatory: true,
    },
    'claim-gate': {
      description: 'Evaluate whether claims are backed by sufficient evidence',
      phase: 'claim-evaluation',
      mandatory: true,
    },
    'hypothesis-tracker': {
      description: 'Manage competing hypotheses and test against evidence',
      phase: 'evidence-collection',
      mandatory: false,
    },
  };

  return sequence.map(tool => ({
    tool,
    ...(meta[tool] ?? {
      description: `Invoke ${tool}`,
      phase: 'evidence-collection' as GroundingPhase,
      mandatory: false,
    }),
  }));
}

/** Initialize a new grounding session */
export function initSession(input: GroundingInput): GroundingSession {
  const sequence = buildMandatorySequence(input.keyword);
  const steps = buildSteps(sequence);
  const guardrails = resolveGuardrails(input.keyword);
  const phases: GroundingPhase[] = [
    'scope-resolution',
    'doc-reading',
    'playbook-loading',
    'runtime-inspection',
    'evidence-collection',
    'claim-evaluation',
    'complete',
  ];

  const allPhases: GroundingPhase[] = [...phases];
  const phaseStatus = Object.fromEntries(
    allPhases.map(p => [p, 'pending'])
  ) as Record<GroundingPhase, 'pending' | 'active' | 'done' | 'skipped'>;

  phaseStatus['scope-resolution'] = 'active';

  return {
    id: generateSessionId(input.keyword),
    keyword: input.keyword,
    problem: input.problem,
    resolved_scope: input.keyword.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
    mandatory_sequence: sequence,
    active_guardrails: guardrails,
    phases,
    current_phase: 'scope-resolution',
    steps,
    phase_status: phaseStatus,
    started_at: new Date().toISOString(),
    scope_changed: false,
  };
}

/** Advance session to next phase */
export function advancePhase(session: GroundingSession): GroundingSession {
  type NonCompletePhase = Exclude<GroundingPhase, 'complete'>;
  const phases = session.phases.filter((p): p is NonCompletePhase => p !== 'complete');
  const currentIndex = phases.indexOf(session.current_phase as NonCompletePhase);

  // Skip phases with no steps
  let nextIndex = currentIndex + 1;
  while (nextIndex < phases.length) {
    const nextPhase = phases[nextIndex];
    const hasSteps = session.steps.some(s => s.phase === (nextPhase as GroundingPhase));
    if (hasSteps) break;
    session.phase_status[nextPhase as GroundingPhase] = 'skipped';
    nextIndex++;
  }

  session.phase_status[session.current_phase] = 'done';
  const nextPhase: GroundingPhase = nextIndex < phases.length ? phases[nextIndex] : 'complete';
  session.current_phase = nextPhase;
  if (nextPhase !== 'complete') {
    session.phase_status[nextPhase] = 'active';
  }

  return session;
}

/** Handle scope change mid-session */
export function handleScopeChange(session: GroundingSession, newKeyword: string): GroundingSession {
  const newSession = initSession({
    keyword: newKeyword,
    problem: session.problem,
    workspace: undefined,
  });
  return { ...newSession, scope_changed: true };
}

/** Get current tools to invoke */
export function getCurrentTools(session: GroundingSession): GroundingStep[] {
  return session.steps.filter(s => s.phase === session.current_phase);
}

/** Check if a guardrail is active */
export function isGuardrailActive(session: GroundingSession, guardrail: GuardrailId): boolean {
  return session.active_guardrails.includes(guardrail);
}
