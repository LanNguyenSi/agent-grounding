/**
 * Phase 5 #4 — `policy_decision` is a first-class type alongside the
 * four debug-evidence types. It lives in the same `entries` table but
 * is bucketed separately at the read API so audit consumers can pull
 * decisions without contaminating evidence-tag substring filters
 * (e.g. harness's `filterEntriesByTag` was treating past
 * `policy_decision:` payloads as matches for their own ledger_tag).
 */
export type EntryType =
  | "fact"
  | "hypothesis"
  | "rejected"
  | "unknown"
  | "policy_decision";

export type ConfidenceLevel = "high" | "medium" | "low";

export interface LedgerEntry {
  id: number;
  type: EntryType;
  content: string;
  source: string | null;
  confidence: ConfidenceLevel;
  session: string;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerSummary {
  session: string;
  facts: LedgerEntry[];
  hypotheses: LedgerEntry[];
  rejected: LedgerEntry[];
  unknowns: LedgerEntry[];
  /**
   * Phase 5 #4 — separate bucket for first-class `policy_decision`
   * rows so they don't contaminate the four evidence buckets. Empty
   * when the session has no policy decisions or when consumers run
   * against a pre-Phase-5-#4 ledger.
   */
  policyDecisions: LedgerEntry[];
}

export interface AddEntryOptions {
  type: EntryType;
  content: string;
  source?: string;
  confidence?: ConfidenceLevel;
  session?: string;
}

export interface RejectOptions {
  id: number;
  reason?: string;
}
