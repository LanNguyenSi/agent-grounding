// Mirror of report-schema.ts. The schema is authoritative at runtime
// (ajv-validated); these types are the build-time view for TS consumers.

export type UnderstandingGateMode = "fast_confirm" | "grill_me";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type ApprovalStatus =
  | "pending"
  | "approved"
  | "revision_requested"
  | "rejected";

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
   * Session that produced the report. Set by the adapters from the
   * runtime's session id, never from agent-authored markdown. Absent on
   * reports written before v0.4.6.
   */
  sessionId?: string;
}
