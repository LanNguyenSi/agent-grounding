// JSON Schema for UnderstandingReport. Bundled as a TS const so consumers
// can import it without runtime fs IO. ajv-strict-compatible: only standard
// keywords, no unknown extensions.
//
// Two variants exported:
//   UNDERSTANDING_REPORT_SCHEMA               for full / grill_me reports
//   UNDERSTANDING_REPORT_SCHEMA_FAST_CONFIRM  for fast_confirm reports
//
// The fast_confirm variant drops `derivedTodos` and `acceptanceCriteria`
// from the required set (the fast_confirm prompt emits five bullets, none
// of which are a todo list or acceptance-criteria list). Everything else
// is identical: same property definitions, same minLength / minItems on
// the fields that ARE present. Agents in fast_confirm mode that
// nevertheless emit a full Report still parse cleanly: the relaxed
// schema is a strict superset of inputs the strict schema accepts.
// Rationale: see agent-tasks/eaac8fe5.

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

// Fast-confirm variant. Drops the four sections the fast_confirm prompt
// never emits (derivedTodos, acceptanceCriteria, openQuestions, risks)
// from the required set. The prompt only asks for five bullets
// (currentUnderstanding, intendedOutcome, outOfScope, verificationPlan,
// assumptions). Properties block unchanged, so a fast_confirm report
// that volunteers any of the dropped fields still validates by shape.
export const UNDERSTANDING_REPORT_SCHEMA_FAST_CONFIRM = {
  ...UNDERSTANDING_REPORT_SCHEMA,
  $id:
    "https://lannguyensi.github.io/agent-grounding/understanding-report.fast-confirm.schema.json",
  required: UNDERSTANDING_REPORT_SCHEMA.required.filter(
    (k) =>
      k !== "derivedTodos" &&
      k !== "acceptanceCriteria" &&
      k !== "openQuestions" &&
      k !== "risks",
  ),
} as const;
