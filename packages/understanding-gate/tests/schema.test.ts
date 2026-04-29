import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { UNDERSTANDING_REPORT_SCHEMA } from "../src/schema/report-schema.js";
import type { UnderstandingReport } from "../src/schema/types.js";

function makeValidator() {
  const ajv = new Ajv({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv.compile(UNDERSTANDING_REPORT_SCHEMA);
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
});
