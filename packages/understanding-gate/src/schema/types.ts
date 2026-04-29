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

  requiresHumanApproval: boolean;
  approvalStatus: ApprovalStatus;

  createdAt?: string;
  approvedAt?: string;
  approvedBy?: string;
}
