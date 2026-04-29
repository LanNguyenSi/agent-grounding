// JSON Schema for UnderstandingReport. Bundled as a TS const so consumers
// can import it without runtime fs IO. ajv-strict-compatible: only standard
// keywords, no unknown extensions.

export const UNDERSTANDING_REPORT_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://lannguyensi.github.io/agent-grounding/understanding-report.schema.json",
  title: "UnderstandingReport",
  type: "object",
  additionalProperties: false,
  required: [
    "taskId",
    "mode",
    "riskLevel",
    "currentUnderstanding",
    "intendedOutcome",
    "derivedTodos",
    "acceptanceCriteria",
    "assumptions",
    "openQuestions",
    "outOfScope",
    "risks",
    "verificationPlan",
    "requiresHumanApproval",
    "approvalStatus",
  ],
  properties: {
    taskId: { type: "string", minLength: 1 },
    mode: { type: "string", enum: ["fast_confirm", "grill_me"] },
    riskLevel: {
      type: "string",
      enum: ["low", "medium", "high", "critical"],
    },
    currentUnderstanding: { type: "string", minLength: 1 },
    intendedOutcome: { type: "string", minLength: 1 },
    derivedTodos: { type: "array", items: { type: "string" } },
    acceptanceCriteria: { type: "array", items: { type: "string" } },
    assumptions: { type: "array", items: { type: "string" } },
    openQuestions: { type: "array", items: { type: "string" } },
    outOfScope: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    verificationPlan: { type: "array", items: { type: "string" } },
    requiresHumanApproval: { type: "boolean" },
    approvalStatus: {
      type: "string",
      enum: ["pending", "approved", "revision_requested", "rejected"],
    },
    createdAt: { type: "string", format: "date-time" },
    approvedAt: { type: "string", format: "date-time" },
    approvedBy: { type: "string" },
  },
} as const;
