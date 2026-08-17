import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  UNDERSTANDING_REPORT_SCHEMA,
  UNDERSTANDING_REPORT_SCHEMA_FAST_CONFIRM,
} from "../src/schema/report-schema.js";
import type { UnderstandingReport } from "../src/schema/types.js";

function makeValidator() {
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(UNDERSTANDING_REPORT_SCHEMA);
}

function makeFastConfirmValidator() {
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(UNDERSTANDING_REPORT_SCHEMA_FAST_CONFIRM);
}

const validReport: UnderstandingReport = {
  taskId: "task-123",
  mode: "fast_confirm",
  riskLevel: "medium",
  currentUnderstanding: "User wants the gate.",
  intendedOutcome: "Gate is in place.",
  derivedTodos: ["scaffold", "core", "adapter"],
  acceptanceCriteria: ["binary exits 0", "hook fires"],
  assumptions: ["read-only ok"],
  openQuestions: ["which trigger?"],
  outOfScope: ["enforcement"],
  risks: ["friction"],
  verificationPlan: ["unit tests"],
  priorArt: ["searched npm", "found nothing", "build new"],
  requiresHumanApproval: true,
  approvalStatus: "pending",
};

describe("UNDERSTANDING_REPORT_SCHEMA", () => {
  it("compiles cleanly with ajv strict:true", () => {
    expect(() => makeValidator()).not.toThrow();
  });

  it("validates a complete valid report", () => {
    const validate = makeValidator();
    expect(validate(validReport)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it("rejects a report missing required field 'taskId'", () => {
    const validate = makeValidator();
    const { taskId: _omit, ...incomplete } = validReport;
    expect(validate(incomplete)).toBe(false);
    expect(validate.errors?.some((e) => e.params.missingProperty === "taskId"))
      .toBe(true);
  });

  it("rejects an unknown additional property", () => {
    const validate = makeValidator();
    expect(validate({ ...validReport, sneaky: "no" })).toBe(false);
  });

  it("rejects an out-of-enum mode value", () => {
    const validate = makeValidator();
    expect(validate({ ...validReport, mode: "wrong_mode" })).toBe(false);
  });

  it("rejects an out-of-enum riskLevel value", () => {
    const validate = makeValidator();
    expect(validate({ ...validReport, riskLevel: "extreme" })).toBe(false);
  });

  it("rejects an out-of-enum approvalStatus value", () => {
    const validate = makeValidator();
    expect(validate({ ...validReport, approvalStatus: "maybe" })).toBe(false);
  });

  it("accepts a harness-expired report (approvalStatus: 'expired' + expiredAt)", () => {
    // Shape written by the harness's understanding-before-execution
    // runtime pack (expirePersistedReport(), agent-grounding 5120938c):
    // it rewrites a persisted report's approvalStatus to "expired" and
    // sets expiredAt, in place, leaving every other field untouched.
    // Consumers that validate a persisted report against this schema
    // (e.g. an exhaustive parser/guard) must not reject that shape.
    const validate = makeValidator();
    const harnessExpired = {
      ...validReport,
      approvalStatus: "expired",
      approvedAt: "2026-08-01T09:00:00Z",
      approvedBy: "cli",
      expiredAt: "2026-08-01T13:00:00Z",
    };
    expect(validate(harnessExpired)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it("rejects an invalid expiredAt format", () => {
    const validate = makeValidator();
    expect(
      validate({
        ...validReport,
        approvalStatus: "expired",
        expiredAt: "not-a-date",
      }),
    ).toBe(false);
  });

  it("accepts optional createdAt/approvedAt as ISO date-times", () => {
    const validate = makeValidator();
    expect(
      validate({
        ...validReport,
        createdAt: "2026-04-29T17:00:00Z",
        approvedAt: "2026-04-29T17:05:00Z",
        approvedBy: "lan@example.com",
      }),
    ).toBe(true);
  });

  it("rejects an invalid createdAt format", () => {
    const validate = makeValidator();
    expect(
      validate({ ...validReport, createdAt: "not-a-date" }),
    ).toBe(false);
  });

  describe("list-field tightness", () => {
    const ALL_LIST_FIELDS = [
      "derivedTodos",
      "acceptanceCriteria",
      "assumptions",
      "openQuestions",
      "outOfScope",
      "risks",
      "verificationPlan",
      "priorArt",
    ] as const;

    const NON_EMPTY_REQUIRED = [
      "derivedTodos",
      "acceptanceCriteria",
      "verificationPlan",
      "priorArt",
    ] as const;

    const ALLOW_EMPTY = [
      "assumptions",
      "openQuestions",
      "outOfScope",
      "risks",
    ] as const;

    it.each(ALL_LIST_FIELDS)("rejects an empty-string item in %s", (field) => {
      const validate = makeValidator();
      expect(validate({ ...validReport, [field]: [""] })).toBe(false);
      expect(
        validate.errors?.some((e) => e.instancePath === `/${field}/0`),
      ).toBe(true);
    });

    it.each(ALL_LIST_FIELDS)(
      "rejects a list that mixes valid and empty strings in %s",
      (field) => {
        const validate = makeValidator();
        expect(validate({ ...validReport, [field]: ["good", ""] })).toBe(false);
      },
    );

    it.each(NON_EMPTY_REQUIRED)("rejects an empty array for %s", (field) => {
      const validate = makeValidator();
      expect(validate({ ...validReport, [field]: [] })).toBe(false);
      expect(
        validate.errors?.some(
          (e) => e.instancePath === `/${field}` && e.keyword === "minItems",
        ),
      ).toBe(true);
    });

    it.each(ALLOW_EMPTY)("allows an empty array for %s", (field) => {
      const validate = makeValidator();
      expect(validate({ ...validReport, [field]: [] })).toBe(true);
    });
  });
});

describe("UNDERSTANDING_REPORT_SCHEMA_FAST_CONFIRM", () => {
  // The fast_confirm variant is built as `{ ...UNDERSTANDING_REPORT_SCHEMA,
  // required: [...] }` (report-schema.ts), so its `properties` block is the
  // very same object reference as the strict schema's -- every property-
  // level assertion above (including the expired-report acceptance) was
  // already exercised against the fast_confirm variant's data by
  // reference, just never compiled and validated explicitly through this
  // variant's own ajv instance. This block closes that gap (agent-grounding
  // 5120938c, review round 2).
  it("compiles cleanly with ajv strict:true", () => {
    expect(() => makeFastConfirmValidator()).not.toThrow();
  });

  it("validates a fast_confirm-shaped report (five bullets, no derivedTodos/acceptanceCriteria/openQuestions/risks/priorArt)", () => {
    const validate = makeFastConfirmValidator();
    const fastConfirmReport = {
      taskId: "task-123",
      mode: "fast_confirm",
      riskLevel: "low",
      currentUnderstanding: "User wants the gate.",
      intendedOutcome: "Gate is in place.",
      assumptions: ["read-only ok"],
      outOfScope: ["enforcement"],
      verificationPlan: ["unit tests"],
      requiresHumanApproval: false,
      approvalStatus: "pending",
    };
    expect(validate(fastConfirmReport)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it("accepts a harness-expired report (approvalStatus: 'expired' + expiredAt) through the fast_confirm variant", () => {
    // Same fixture shape as the strict-schema test above. The harness
    // writes expired reports in place regardless of which mode produced
    // them, so a fast_confirm-produced report can just as well end up in
    // this state; the fast_confirm variant must accept it too.
    const validate = makeFastConfirmValidator();
    const harnessExpired = {
      ...validReport,
      approvalStatus: "expired",
      approvedAt: "2026-08-01T09:00:00Z",
      approvedBy: "cli",
      expiredAt: "2026-08-01T13:00:00Z",
    };
    expect(validate(harnessExpired)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it("rejects an out-of-enum approvalStatus value", () => {
    const validate = makeFastConfirmValidator();
    expect(validate({ ...validReport, approvalStatus: "maybe" })).toBe(false);
  });
});
