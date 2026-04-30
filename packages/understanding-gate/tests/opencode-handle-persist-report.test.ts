import { describe, expect, it, vi } from "vitest";
import {
  handlePersistReport,
  type PersistReportDeps,
  type PersistReportInput,
} from "../src/adapters/opencode/persist-report.js";
import type { UnderstandingReport } from "../src/schema/types.js";
import type { ParseResult } from "../src/core/parser.js";

const FIXED_NOW = new Date("2026-04-30T12:34:56.789Z");

const validReport: UnderstandingReport = {
  taskId: "oc-task-1",
  mode: "fast_confirm",
  riskLevel: "low",
  currentUnderstanding: "x",
  intendedOutcome: "y",
  derivedTodos: ["a"],
  acceptanceCriteria: ["b"],
  assumptions: ["c"],
  openQuestions: ["d"],
  outOfScope: ["e"],
  risks: ["f"],
  verificationPlan: ["g"],
  requiresHumanApproval: true,
  approvalStatus: "pending",
  createdAt: FIXED_NOW.toISOString(),
};

function makeDeps(over: Partial<PersistReportDeps> = {}): PersistReportDeps {
  return {
    parseReport: vi.fn(
      (): ParseResult => ({ ok: true, report: validReport }),
    ),
    saveReport: vi.fn(() => ({
      path: "/tmp/reports/2026-04-30T12-34-56-789Z-oc-task-1.json",
      written: true,
    })),
    writeParseErrorLog: vi.fn(() => "/tmp/parse-errors/log.log"),
    now: () => FIXED_NOW,
    ...over,
  };
}

function makeInput(over: Partial<PersistReportInput> = {}): PersistReportInput {
  return {
    lastAssistantText:
      "# Understanding Report\n\n### 1. My current understanding\n...",
    cwd: "/tmp/work",
    sessionId: "oc-session-xyz",
    parseErrorDir: "/tmp/work/.understanding-gate/parse-errors",
    env: {},
    ...over,
  };
}

describe("handlePersistReport: kill switch", () => {
  it("returns disabled when UNDERSTANDING_GATE_DISABLE is set", () => {
    const deps = makeDeps();
    const out = handlePersistReport(
      makeInput({ env: { UNDERSTANDING_GATE_DISABLE: "1" } }),
      deps,
    );
    expect(out.kind).toBe("disabled");
    expect(deps.parseReport).not.toHaveBeenCalled();
  });
});

describe("handlePersistReport: marker gating", () => {
  it("returns no_report when text lacks a heading-prefixed marker", () => {
    const deps = makeDeps();
    const out = handlePersistReport(
      makeInput({ lastAssistantText: "Just some random reply." }),
      deps,
    );
    expect(out.kind).toBe("no_report");
    expect(deps.parseReport).not.toHaveBeenCalled();
  });

  it("returns no_report on empty text", () => {
    const out = handlePersistReport(
      makeInput({ lastAssistantText: "" }),
      makeDeps(),
    );
    expect(out.kind).toBe("no_report");
  });

  it("does not match casual prose mentions without a heading prefix", () => {
    const deps = makeDeps();
    const out = handlePersistReport(
      makeInput({
        lastAssistantText:
          "I'll write an Understanding Report once I know more.",
      }),
      deps,
    );
    expect(out.kind).toBe("no_report");
    expect(deps.parseReport).not.toHaveBeenCalled();
  });

  it("matches a heading-prefixed marker case-insensitively", () => {
    const deps = makeDeps();
    handlePersistReport(
      makeInput({ lastAssistantText: "## understanding REPORT\n\nbody" }),
      deps,
    );
    expect(deps.parseReport).toHaveBeenCalled();
  });
});

describe("handlePersistReport: save path", () => {
  it("forwards sessionId as taskId default", () => {
    const deps = makeDeps();
    handlePersistReport(makeInput({ sessionId: "oc-zzz" }), deps);
    const [, defaults] = (deps.parseReport as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(defaults).toMatchObject({
      taskId: "oc-zzz",
      createdAt: FIXED_NOW.toISOString(),
    });
  });

  it("UNDERSTANDING_GATE_TASK_ID overrides sessionId", () => {
    const deps = makeDeps();
    handlePersistReport(
      makeInput({
        sessionId: "oc-zzz",
        env: { UNDERSTANDING_GATE_TASK_ID: "explicit" },
      }),
      deps,
    );
    const [, defaults] = (deps.parseReport as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(defaults.taskId).toBe("explicit");
  });

  it("UNDERSTANDING_GATE_MODE forwards only when in-enum", () => {
    const deps = makeDeps();
    handlePersistReport(
      makeInput({ env: { UNDERSTANDING_GATE_MODE: "grill_me" } }),
      deps,
    );
    const [, d1] = (deps.parseReport as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(d1.mode).toBe("grill_me");
  });

  it("falls back to fast_confirm baseline when env mode is out-of-enum", () => {
    const deps = makeDeps();
    handlePersistReport(
      makeInput({ env: { UNDERSTANDING_GATE_MODE: "nonsense" } }),
      deps,
    );
    const [, d] = (deps.parseReport as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(d.mode).toBe("fast_confirm");
  });

  it("returns saved with the saveReport result", () => {
    const deps = makeDeps();
    const out = handlePersistReport(makeInput(), deps);
    expect(out.kind).toBe("saved");
    expect(deps.saveReport).toHaveBeenCalledWith(validReport, {
      cwd: "/tmp/work",
    });
  });

  it("passes empty SaveOptions when UNDERSTANDING_GATE_REPORT_DIR is set", () => {
    const deps = makeDeps();
    handlePersistReport(
      makeInput({ env: { UNDERSTANDING_GATE_REPORT_DIR: "/anywhere" } }),
      deps,
    );
    expect(deps.saveReport).toHaveBeenCalledWith(validReport, {});
  });
});

describe("handlePersistReport: parse_error path", () => {
  it("writes a parse-error log on parse failure", () => {
    const deps = makeDeps({
      parseReport: vi.fn(
        (): ParseResult => ({
          ok: false,
          error: {
            reason: "missing_sections",
            missing: ["assumptions"],
            schemaErrors: [],
            message: "missing assumptions",
          },
        }),
      ),
    });
    const out = handlePersistReport(makeInput(), deps);
    expect(out.kind).toBe("parse_error");
    expect(deps.saveReport).not.toHaveBeenCalled();
    const [dir, payload] = (
      deps.writeParseErrorLog as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(dir).toBe("/tmp/work/.understanding-gate/parse-errors");
    expect(payload).toMatch(/"adapter": "opencode"/);
    expect(payload).toContain("--- raw ---");
  });

  it("still returns parse_error when log writer throws", () => {
    const deps = makeDeps({
      parseReport: vi.fn(
        (): ParseResult => ({
          ok: false,
          error: {
            reason: "schema_violation",
            missing: [],
            schemaErrors: [{ path: "/mode", message: "bad" }],
            message: "bad",
          },
        }),
      ),
      writeParseErrorLog: vi.fn(() => {
        throw new Error("disk full");
      }),
    });
    const out = handlePersistReport(makeInput(), deps);
    expect(out.kind).toBe("parse_error");
    if (out.kind !== "parse_error") return;
    expect(out.logPath).toBe("");
  });
});
