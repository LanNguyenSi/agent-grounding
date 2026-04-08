/**
 * Hypothesis Tracker
 *
 * Manages competing hypotheses during debugging.
 * Prevents silent replacement of one wrong guess with another.
 * Based on lan-tools/09-hypothesis-tracker.md
 */

export type HypothesisStatus = "unverified" | "supported" | "rejected";

export interface Evidence {
  text: string;
  source?: string;
  addedAt: string;
}

export interface RequiredCheck {
  description: string;
  done: boolean;
}

export interface Hypothesis {
  id: string;
  text: string;
  status: HypothesisStatus;
  evidence: Evidence[];
  required_checks: RequiredCheck[];
  createdAt: string;
  updatedAt: string;
}

export interface HypothesisStore {
  session: string;
  hypotheses: Hypothesis[];
}

function generateId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function now(): string {
  return new Date().toISOString();
}

/** Create a new in-memory store for a session */
export function createStore(session = "default"): HypothesisStore {
  return { session, hypotheses: [] };
}

/** Add a new hypothesis with required verification steps */
export function addHypothesis(
  store: HypothesisStore,
  text: string,
  requiredChecks: string[] = [],
): Hypothesis {
  const hypothesis: Hypothesis = {
    id: generateId(),
    text,
    status: "unverified",
    evidence: [],
    required_checks: requiredChecks.map((desc) => ({ description: desc, done: false })),
    createdAt: now(),
    updatedAt: now(),
  };
  store.hypotheses.push(hypothesis);
  return hypothesis;
}

/** Find a hypothesis by ID */
export function findHypothesis(store: HypothesisStore, id: string): Hypothesis | null {
  return store.hypotheses.find((h) => h.id === id) ?? null;
}

/** Add evidence to an existing hypothesis — updates status if evidence exists */
export function addEvidence(
  store: HypothesisStore,
  id: string,
  evidenceText: string,
  source?: string,
): Hypothesis | null {
  const hyp = findHypothesis(store, id);
  if (!hyp) return null;

  hyp.evidence.push({ text: evidenceText, source, addedAt: now() });
  // Auto-promote to supported if previously unverified
  if (hyp.status === "unverified") {
    hyp.status = "supported";
  }
  hyp.updatedAt = now();
  return hyp;
}

/** Mark a required check as done */
export function completeCheck(store: HypothesisStore, id: string, checkIndex: number): Hypothesis | null {
  const hyp = findHypothesis(store, id);
  if (!hyp) return null;
  if (checkIndex < 0 || checkIndex >= hyp.required_checks.length) return null;
  hyp.required_checks[checkIndex]!.done = true;
  hyp.updatedAt = now();
  return hyp;
}

/** Reject a hypothesis with a reason */
export function rejectHypothesis(store: HypothesisStore, id: string, reason?: string): Hypothesis | null {
  const hyp = findHypothesis(store, id);
  if (!hyp) return null;
  hyp.status = "rejected";
  if (reason) {
    hyp.evidence.push({ text: `[rejected] ${reason}`, addedAt: now() });
  }
  hyp.updatedAt = now();
  return hyp;
}

/** Support (confirm) a hypothesis */
export function supportHypothesis(store: HypothesisStore, id: string): Hypothesis | null {
  const hyp = findHypothesis(store, id);
  if (!hyp || hyp.status === "rejected") return null;
  hyp.status = "supported";
  hyp.updatedAt = now();
  return hyp;
}

/** Get summary counts */
export function getSummary(store: HypothesisStore): {
  total: number;
  unverified: number;
  supported: number;
  rejected: number;
  pending_checks: number;
} {
  const total = store.hypotheses.length;
  const unverified = store.hypotheses.filter((h) => h.status === "unverified").length;
  const supported = store.hypotheses.filter((h) => h.status === "supported").length;
  const rejected = store.hypotheses.filter((h) => h.status === "rejected").length;
  const pending_checks = store.hypotheses.reduce(
    (acc, h) => acc + h.required_checks.filter((c) => !c.done).length,
    0,
  );
  return { total, unverified, supported, rejected, pending_checks };
}

/** Export store as JSON string */
export function exportStore(store: HypothesisStore): string {
  return JSON.stringify(store, null, 2);
}

/** Import store from JSON string */
export function importStore(json: string): HypothesisStore {
  return JSON.parse(json) as HypothesisStore;
}
