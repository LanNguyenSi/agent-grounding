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

/**
 * Support (confirm) a hypothesis. Evidence is intentionally NOT required:
 * this is the manual escape hatch for evidence held out-of-band (see
 * grounding-mcp's `hypothesis_support` verb). This path refuses to confirm
 * while the hypothesis's own `required_checks` are still pending (returns
 * null). The gate is local to manual support: `addEvidence` still
 * auto-promotes on first evidence regardless of checks, by design (evidence
 * attachment is itself a form of support). Also returns null for an unknown
 * or already-rejected hypothesis.
 */
export function supportHypothesis(store: HypothesisStore, id: string): Hypothesis | null {
  const hyp = findHypothesis(store, id);
  if (!hyp || hyp.status === "rejected") return null;
  if (hyp.required_checks.some((c) => !c.done)) return null;
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

const HYPOTHESIS_STATUSES: readonly HypothesisStatus[] = [
  "unverified",
  "supported",
  "rejected",
];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateHypothesis(h: unknown, where: string): void {
  if (!isObject(h)) throw new Error(`importStore: ${where} must be an object`);
  if (typeof h.id !== "string") throw new Error(`importStore: ${where}.id must be a string`);
  if (typeof h.text !== "string") throw new Error(`importStore: ${where}.text must be a string`);
  if (!HYPOTHESIS_STATUSES.includes(h.status as HypothesisStatus)) {
    throw new Error(
      `importStore: ${where}.status must be one of ${HYPOTHESIS_STATUSES.join(", ")}`,
    );
  }
  if (typeof h.createdAt !== "string") throw new Error(`importStore: ${where}.createdAt must be a string`);
  if (typeof h.updatedAt !== "string") throw new Error(`importStore: ${where}.updatedAt must be a string`);
  if (!Array.isArray(h.evidence)) throw new Error(`importStore: ${where}.evidence must be an array`);
  h.evidence.forEach((e, i) => {
    if (!isObject(e) || typeof e.text !== "string" || typeof e.addedAt !== "string") {
      throw new Error(`importStore: ${where}.evidence[${i}] must be { text, addedAt }`);
    }
  });
  if (!Array.isArray(h.required_checks)) {
    throw new Error(`importStore: ${where}.required_checks must be an array`);
  }
  h.required_checks.forEach((c, i) => {
    if (!isObject(c) || typeof c.description !== "string" || typeof c.done !== "boolean") {
      throw new Error(
        `importStore: ${where}.required_checks[${i}] must be { description, done }`,
      );
    }
  });
}

/**
 * Import a store from a JSON string, validating its shape.
 *
 * The store is an audit artifact that may have been hand-edited or moved
 * between machines, so a bare `JSON.parse(...) as HypothesisStore` would let
 * a malformed payload through and crash a downstream `store.hypotheses.find`
 * on a non-array. Validate the structure here and throw a clear,
 * field-named error instead.
 */
export function importStore(json: string): HypothesisStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`importStore: input is not valid JSON: ${reason}`);
  }
  if (!isObject(parsed)) {
    throw new Error("importStore: expected a JSON object with { session, hypotheses }");
  }
  if (typeof parsed.session !== "string") {
    throw new Error("importStore: `session` must be a string");
  }
  if (!Array.isArray(parsed.hypotheses)) {
    throw new Error("importStore: `hypotheses` must be an array");
  }
  parsed.hypotheses.forEach((h, i) => validateHypothesis(h, `hypotheses[${i}]`));
  return { session: parsed.session, hypotheses: parsed.hypotheses as Hypothesis[] };
}
