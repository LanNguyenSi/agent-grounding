/** Frozen documentary v1 evaluator; no live wrapper, ledger, or contract-file reads. */
import { createHash } from 'node:crypto';
import { POLICY_ID, POLICY_REVISION, POLICY_SHA256, type GroundingReceiptPayload } from './grounding-receipt.js';

export const ASSESSMENT_POLICY = Object.freeze({ id: POLICY_ID, revision: POLICY_REVISION, sha256: POLICY_SHA256 });
export const PHASES = Object.freeze(['scope-resolution', 'doc-reading', 'playbook-loading', 'runtime-inspection', 'evidence-collection', 'claim-evaluation', 'complete'] as const);
export type Phase = typeof PHASES[number];
export type Binding = Pick<GroundingReceiptPayload, 'audience' | 'projectId' | 'taskId' | 'subject'>;
export type EntryKind = 'fact' | 'hypothesis' | 'rejected' | 'unknown';
export interface DossierEntry { id: string; kind: EntryKind; content: string; source: string; origin: 'agent_asserted'; revision: number; }
export interface CompletionEvent { phase: Phase; tools: string[]; origin: 'producer_api_agent_confirmation'; revision: number; }
export interface AssessmentSnapshot {
  id: string; revision: number; binding: Binding; keyword: string; problem: string;
  events: CompletionEvent[]; entries: DossierEntry[];
  claim: { text: string; origin: 'agent_asserted'; revision: number } | null;
}

const tools = ['domain-router', 'readme-first-resolver', 'debug-playbook-engine', 'runtime-reality-checker', 'evidence-ledger', 'claim-gate'] as const;
const runtimeKeywords = ['monitor', 'agent', 'service', 'server', 'gateway'];
const detection = [
  ['architecture', 'architektur|architecture|design flaw|system design'],
  ['root_cause', 'root.?cause|root cause|eigentliche ursache|grundursache'],
  ['security', 'security|sicherheit|cve|injection|exploit|auth'],
  ['network', 'network|netzwerk|firewall|port|dns|tcp|udp'],
  ['configuration', 'config|konfiguration|env|environment|setting'],
  ['process', 'process|prozess|service läuft|not running|stopped'],
  ['availability', 'verfügbar|available|down|unreachable|offline'],
  ['token', 'token|key|secret|credential|api.?key'],
] as const;
const prerequisites = {
  architecture: ['readme_read', 'process_checked', 'config_checked', 'alternatives_considered'],
  root_cause: ['readme_read', 'process_checked', 'config_checked', 'has_evidence', 'alternatives_considered'],
  security: ['readme_read', 'config_checked', 'has_evidence'],
  network: ['health_checked', 'process_checked'], configuration: ['readme_read', 'config_checked'],
  process: ['process_checked'], availability: ['health_checked', 'process_checked'],
  token: ['config_checked', 'has_evidence'], generic: ['has_evidence'],
} as const;
export type ClaimType = keyof typeof prerequisites;
type Context = Record<typeof prerequisites[ClaimType][number], boolean>;

export function normalizeKeyword(keyword: string): string {
  if (typeof keyword !== 'string' || keyword.length < 1 || keyword.length > 64) throw new Error('Invalid keyword');
  const slug = keyword.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('Invalid keyword');
  return slug;
}

/** Each returned array is detached; optional hypothesis-tracker shares the evidence phase. */
export function phasePlan(keyword: string): { phase: Phase; tools: string[] }[] {
  normalizeKeyword(keyword);
  const runtime = runtimeKeywords.some((word) => keyword.toLowerCase().includes(word));
  return PHASES.slice(0, -1).flatMap((phase, i) => phase === 'runtime-inspection' && !runtime ? [] : [{
    phase, tools: phase === 'evidence-collection' ? [tools[i], 'hypothesis-tracker'] : [tools[i]],
  }]);
}

export function currentPhase(snapshot: AssessmentSnapshot): Phase {
  return phasePlan(snapshot.keyword)[snapshot.events.length]?.phase ?? 'complete';
}

export function detectClaimType(text: string): ClaimType {
  const lower = text.toLowerCase();
  return detection.find(([, pattern]) => new RegExp(pattern).test(lower))?.[0] ?? 'generic';
}

function validEntry(entry: DossierEntry): boolean {
  return entry.origin === 'agent_asserted' && typeof entry.content === 'string' && entry.content.trim().length > 0;
}

export function deriveContext(snapshot: AssessmentSnapshot): Context {
  const plan = phasePlan(snapshot.keyword);
  const completed = (phase: Phase): boolean => {
    const step = plan.find((item) => item.phase === phase);
    if (!step) return snapshot.events.some((event) => event.phase === 'playbook-loading' && event.origin === 'producer_api_agent_confirmation');
    return snapshot.events.some((event) => event.phase === phase && event.origin === 'producer_api_agent_confirmation' && event.tools.includes(step.tools[0]));
  };
  const runtime = completed('runtime-inspection');
  return {
    readme_read: completed('doc-reading'), process_checked: runtime, config_checked: runtime, health_checked: runtime,
    has_evidence: snapshot.entries.some((entry) => entry.kind === 'fact' && validEntry(entry)),
    alternatives_considered: snapshot.entries.some((entry) => entry.kind === 'rejected' && validEntry(entry)),
  };
}

export function evaluateClaim(snapshot: AssessmentSnapshot) {
  const text = snapshot.claim?.text ?? '';
  const type = detectClaimType(text);
  const context = deriveContext(snapshot);
  const requires = prerequisites[type];
  const missing = requires.filter((name) => !context[name]);
  const present = snapshot.claim?.origin === 'agent_asserted' && text.trim().length > 0;
  return { type, context, present, allowed: present && missing.length === 0, missing, score: Math.round((requires.length - missing.length) / requires.length * 100) };
}

/** Fixed-order projection shared by immutable binding comparison and dossier hashing. */
export function bindingProjection(binding: Binding): Binding {
  return { audience: binding.audience, projectId: binding.projectId, taskId: binding.taskId, subject: { kind: binding.subject.kind, digest: binding.subject.digest } };
}
export function bindingMatches(left: Binding, right: Binding): boolean {
  return JSON.stringify(bindingProjection(left)) === JSON.stringify(bindingProjection(right));
}

export function dossierProjection(snapshot: AssessmentSnapshot) {
  return {
    schemaVersion: 1, policy: ASSESSMENT_POLICY, session: { id: snapshot.id, revision: snapshot.revision },
    binding: bindingProjection(snapshot.binding), keyword: snapshot.keyword, problem: snapshot.problem,
    events: snapshot.events.map((event) => ({ phase: event.phase, tools: [...event.tools], origin: event.origin, revision: event.revision })),
    entries: snapshot.entries.map((entry) => ({ id: entry.id, kind: entry.kind, content: entry.content, source: entry.source, origin: entry.origin, revision: entry.revision })),
    claim: snapshot.claim && { text: snapshot.claim.text, origin: snapshot.claim.origin, revision: snapshot.claim.revision },
    claimEvaluation: evaluateClaim(snapshot),
  };
}

/** Only the store supplies this snapshot; declarative corpus booleans are never inputs. */
export function assessSnapshot(snapshot: AssessmentSnapshot, expected: { sessionId: string; revision: number; binding: Binding }): GroundingReceiptPayload['assessment'] {
  const reasons: GroundingReceiptPayload['assessment']['reasons'] = [];
  if (snapshot.id !== expected.sessionId || !bindingMatches(snapshot.binding, expected.binding)) reasons.push('session_binding_invalid');
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1 || snapshot.revision !== expected.revision) reasons.push('session_revision_invalid');
  const mandatory = phasePlan(snapshot.keyword).filter((step) => step.phase !== 'claim-evaluation');
  if (!mandatory.every((step, i) => {
    const event = snapshot.events[i];
    return event?.phase === step.phase && event.origin === 'producer_api_agent_confirmation' && event.tools.includes(step.tools[0]);
  })) reasons.push('mandatory_steps_incomplete');
  const factCount = snapshot.entries.filter((entry) => entry.kind === 'fact' && validEntry(entry)).length;
  if (factCount < 1) reasons.push('fact_missing');
  const claim = evaluateClaim(snapshot);
  if (!claim.present) reasons.push('claim_missing');
  else if (!claim.allowed) reasons.push('claim_prerequisites_missing');
  return {
    outcome: reasons.length === 0 ? 'pass' : 'fail', evidenceOrigin: 'agent_asserted', factCount, claimAllowed: claim.allowed, reasons,
    dossierSha256: createHash('sha256').update(JSON.stringify(dossierProjection(snapshot))).digest('hex'),
  };
}
