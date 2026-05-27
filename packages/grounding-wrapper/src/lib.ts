/**
 * Grounding Wrapper: plans grounding sessions for agents.
 *
 * Pure planner. Given a (keyword, problem) input, computes a recommended
 * tool sequence, active guardrails, and a phase machine. Does NOT invoke
 * the seven downstream tools (domain-router, readme-first-resolver,
 * debug-playbook-engine, evidence-ledger, claim-gate, runtime-reality-checker,
 * hypothesis-tracker). Enforcement of the recommendation is the caller's
 * job (typically a harness Policy). See README.md for the consumption
 * contract.
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

/** Hard cap on raw keyword length, before normalisation. */
export const KEYWORD_MAX_LENGTH = 64;

/**
 * Validate a keyword for `initSession`. Throws when the keyword would
 * produce a degenerate session id / `resolved_scope` (the README's
 * `Public API for enforcement` contract documents these invariants).
 *
 * Rules:
 * - must be a non-empty string
 * - raw length must be ≤ `KEYWORD_MAX_LENGTH`
 * - after slug normalisation (`[^a-z0-9]+` → `-`, trim leading/trailing
 *   `-`) must contain at least one ASCII alphanumeric. This rejects
 *   whitespace-only and pure-CJK / pure-symbol inputs that would slug
 *   to an empty string and emit ids like `gs--<ts>`.
 */
export function validateKeyword(keyword: unknown): void {
  if (typeof keyword !== 'string') {
    throw new Error(`grounding-wrapper: keyword must be a string, got ${typeof keyword}`);
  }
  if (keyword.length === 0) {
    throw new Error('grounding-wrapper: keyword must not be empty');
  }
  if (keyword.length > KEYWORD_MAX_LENGTH) {
    throw new Error(
      `grounding-wrapper: keyword exceeds ${KEYWORD_MAX_LENGTH}-char limit (got ${keyword.length})`,
    );
  }
  const normalised = keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (normalised.length === 0) {
    throw new Error(
      `grounding-wrapper: keyword "${keyword}" normalises to an empty slug; must contain at least one ASCII alphanumeric character`,
    );
  }
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
  validateKeyword(input.keyword);
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

/** Advance session to next phase. Idempotent once `complete` is reached. */
export function advancePhase(session: GroundingSession): GroundingSession {
  if (session.current_phase === 'complete') {
    return session;
  }
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
  } else {
    // Terminal phase reached: mark `complete` as `done` for shape symmetry
    // with every other transitioned-out phase. `summarizeSession` in
    // `grounding-mcp` exposes `phase_status` over MCP, so a consumer that
    // sees `current_phase: 'complete'` would otherwise read
    // `phase_status['complete']: 'pending'` and not know which is authoritative.
    session.phase_status.complete = 'done';
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
