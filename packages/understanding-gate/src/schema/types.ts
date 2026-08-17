// Mirror of report-schema.ts. The schema is authoritative at runtime
// (ajv-validated); these types are the build-time view for TS consumers.

export type UnderstandingGateMode = "fast_confirm" | "grill_me";
export type RiskLevel = "low" | "medium" | "high" | "critical";
// "expired" is written externally by the harness's
// understanding-before-execution runtime pack (expirePersistedReport(),
// approval_lifecycle policy), never by this package: it rewrites a
// persisted report's approvalStatus to "expired" + sets expiredAt when an
// approval ages out or a matching tool/bash pattern fires post-approval.
// The literal lives here so package consumers (parsers, guards,
// exhaustive switches) recognize a harness-expired report as a known
// status instead of an unmodeled one.
export type ApprovalStatus =
  | "pending"
  | "approved"
  | "revision_requested"
  | "rejected"
  | "expired";

export interface UnderstandingReport {
  taskId: string;
  mode: UnderstandingGateMode;
  riskLevel: RiskLevel;

  currentUnderstanding: string;
  intendedOutcome: string;
  derivedTodos: string[];
  acceptanceCriteria: string[];
  assumptions: string[];
  openQuestions: string[];
  outOfScope: string[];
  risks: string[];
  verificationPlan: string[];
  /**
   * Section 10 of the Understanding Report (added in v0.4.0). Forces the
   * agent to state, before committing to build, what was searched for an
   * existing solution and what was found. Required in `grill_me` / full;
   * optional in `fast_confirm` (the five-bullet shape doesn't carry it).
   */
  priorArt: string[];

  requiresHumanApproval: boolean;
  approvalStatus: ApprovalStatus;

  createdAt?: string;
  approvedAt?: string;
  approvedBy?: string;
  /**
   * Set by the harness's understanding-before-execution runtime pack
   * (expirePersistedReport()) alongside approvalStatus: "expired". Never
   * set by this package's own parser/CLI. Optional: absent on every
   * report this package itself produces or approves.
   */
  expiredAt?: string;
  /**
   * Session that produced the report. Set by the adapters from the
   * runtime's session id, never from agent-authored markdown. Absent on
   * reports written before v0.4.6.
   */
  sessionId?: string;
}
