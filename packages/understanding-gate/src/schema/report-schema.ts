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
    // List fields: every item must be a non-empty string.
    //
    // minItems decision per field:
    //   - derivedTodos / acceptanceCriteria / verificationPlan
    //     are core to the gate's value (what the agent will DO, what
    //     "done" looks like, how it will verify). An empty list signals
    //     the agent skipped real planning, so we reject with minItems: 1.
    //   - assumptions / openQuestions / outOfScope / risks
    //     can legitimately be empty in a confident, low-risk report
    //     (no assumptions made, nothing unclear, nothing scoped out).
    //     Schema allows []; the agent's prompt is still expected to
    //     prefer explicit emptiness over silent omission.
    derivedTodos: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
    acceptanceCriteria: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
    assumptions: { type: "array", items: { type: "string", minLength: 1 } },
    openQuestions: { type: "array", items: { type: "string", minLength: 1 } },
    outOfScope: { type: "array", items: { type: "string", minLength: 1 } },
    risks: { type: "array", items: { type: "string", minLength: 1 } },
    verificationPlan: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
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
