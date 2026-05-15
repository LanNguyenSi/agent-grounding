import { describe, expect, it, vi } from "vitest";
import {
  handleStop,
  type StopHookDeps,
  type StopHookInput,
} from "../src/adapters/claude-code/handle-stop.js";
import type { UnderstandingReport } from "../src/schema/types.js";
import type { ParseResult } from "../src/core/parser.js";

const FIXED_NOW = new Date("2026-04-30T12:34:56.789Z");

const validReport: UnderstandingReport = {
  taskId: "task-1",
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

function makeDeps(overrides: Partial<StopHookDeps> = {}): StopHookDeps {
  return {
    parseReport: vi.fn(
      (): ParseResult => ({ ok: true, report: validReport }),
    ),
    saveReport: vi.fn(() => ({
      path: "/tmp/reports/2026-04-30T12-34-56-789Z-task-1.json",
      written: true,
    })),
    writeParseErrorLog: vi.fn(() => "/tmp/parse-errors/log.log"),
    now: () => FIXED_NOW,
    ...overrides,
  };
}

function makeInput(over: Partial<StopHookInput> = {}): StopHookInput {
  return {
    lastAssistantText:
      "# Understanding Report\n\n### 1. My current understanding\n...",
    cwd: "/tmp/work",
    sessionId: "session-xyz",
    parseErrorDir: "/tmp/work/.understanding-gate/parse-errors",
    env: {},
    ...over,
  };
}

describe("handleStop: kill switch", () => {
  it("returns disabled when UNDERSTANDING_GATE_DISABLE is set", () => {
    const deps = makeDeps();
    const out = handleStop(
      makeInput({ env: { UNDERSTANDING_GATE_DISABLE: "1" } }),
      deps,
    );
    expect(out.kind).toBe("disabled");
    expect(deps.parseReport).not.toHaveBeenCalled();
    expect(deps.saveReport).not.toHaveBeenCalled();
  });

  it.each(["1", "true", "TRUE", "yes", "on"])(
    "treats env value %s as disabled",
    (value) => {
      const out = handleStop(
        makeInput({ env: { UNDERSTANDING_GATE_DISABLE: value } }),
        makeDeps(),
      );
      expect(out.kind).toBe("disabled");
    },
  );

  it.each(["", "0", "false", "no", " off "])(
    "treats env value %j as enabled",
    (value) => {
      const out = handleStop(
        makeInput({ env: { UNDERSTANDING_GATE_DISABLE: value } }),
        makeDeps(),
      );
      // marker matches in the input, so enabled path -> saved
      expect(out.kind).not.toBe("disabled");
    },
  );
});

describe("handleStop: marker gating", () => {
  it("returns no_report when text lacks the 'Understanding Report' marker", () => {
    const deps = makeDeps();
    const out = handleStop(
      makeInput({ lastAssistantText: "Just some random reply, no report here." }),
      deps,
    );
    expect(out.kind).toBe("no_report");
    expect(deps.parseReport).not.toHaveBeenCalled();
    expect(deps.writeParseErrorLog).not.toHaveBeenCalled();
  });

  it("returns no_report on empty text without writing any log", () => {
    const deps = makeDeps();
    const out = handleStop(
      makeInput({ lastAssistantText: "" }),
      deps,
    );
    expect(out.kind).toBe("no_report");
    expect(deps.writeParseErrorLog).not.toHaveBeenCalled();
  });

  it("matches the marker case-insensitively when on a heading line", () => {
    const deps = makeDeps();
    handleStop(
      makeInput({ lastAssistantText: "## understanding REPORT\n\nbody..." }),
      deps,
    );
    expect(deps.parseReport).toHaveBeenCalled();
  });

  it("does NOT match a casual prose mention without a heading prefix", () => {
    const deps = makeDeps();
    const out = handleStop(
      makeInput({
        lastAssistantText:
          "I'll write an Understanding Report once I've checked the schema.",
      }),
      deps,
    );
    expect(out.kind).toBe("no_report");
    expect(deps.parseReport).not.toHaveBeenCalled();
  });
});

describe("handleStop: save path", () => {
  it("calls parseReport with sessionId as taskId default when env is empty", () => {
    const deps = makeDeps();
    handleStop(makeInput({ sessionId: "session-zzz" }), deps);
    expect(deps.parseReport).toHaveBeenCalledTimes(1);
    const [, defaults] = (deps.parseReport as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(defaults).toMatchObject({
      taskId: "session-zzz",
      createdAt: FIXED_NOW.toISOString(),
    });
  });

  it("prefers UNDERSTANDING_GATE_TASK_ID over sessionId", () => {
    const deps = makeDeps();
    handleStop(
      makeInput({
        sessionId: "session-zzz",
        env: { UNDERSTANDING_GATE_TASK_ID: "explicit-task-1" },
      }),
      deps,
    );
    const [, defaults] = (deps.parseReport as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(defaults.taskId).toBe("explicit-task-1");
  });

  it("forwards UNDERSTANDING_GATE_MODE when valid", () => {
    const deps = makeDeps();
    handleStop(
      makeInput({ env: { UNDERSTANDING_GATE_MODE: "grill_me" } }),
      deps,
    );
    const [, defaults] = (deps.parseReport as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(defaults.mode).toBe("grill_me");
  });

  it("falls back to the fast_confirm baseline when the env mode is out-of-enum", () => {
    const deps = makeDeps();
    handleStop(
      makeInput({ env: { UNDERSTANDING_GATE_MODE: "something-bogus" } }),
      deps,
    );
    const [, defaults] = (deps.parseReport as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(defaults.mode).toBe("fast_confirm");
  });

  it("returns saved with the saveReport result on parse success", () => {
    const deps = makeDeps();
    const out = handleStop(makeInput(), deps);
    expect(out.kind).toBe("saved");
    if (out.kind !== "saved") return;
    expect(out.path).toMatch(/task-1\.json$/);
    expect(out.written).toBe(true);
    expect(deps.saveReport).toHaveBeenCalledWith(validReport, {
      cwd: "/tmp/work",
    });
  });

  it("passes an empty SaveOptions when UNDERSTANDING_GATE_REPORT_DIR is set (lets persistence read env)", () => {
    const deps = makeDeps();
    handleStop(
      makeInput({ env: { UNDERSTANDING_GATE_REPORT_DIR: "/anywhere" } }),
      deps,
    );
    expect(deps.saveReport).toHaveBeenCalledWith(validReport, {});
  });
});

describe("handleStop: parse_error path", () => {
  it("writes a parse-error log and returns parse_error on parser failure", () => {
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
    const out = handleStop(makeInput(), deps);
    expect(out.kind).toBe("parse_error");
    if (out.kind !== "parse_error") return;
    expect(deps.saveReport).not.toHaveBeenCalled();
    expect(deps.writeParseErrorLog).toHaveBeenCalledTimes(1);
    const [dir, payload] = (
      deps.writeParseErrorLog as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(dir).toBe("/tmp/work/.understanding-gate/parse-errors");
    expect(payload).toContain("missing_sections");
    expect(payload).toContain("--- raw ---");
    expect(payload).toContain("Understanding Report");
    expect(out.error.reason).toBe("missing_sections");
  });

  it("still returns parse_error when the log writer itself throws", () => {
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
    const out = handleStop(makeInput(), deps);
    expect(out.kind).toBe("parse_error");
    if (out.kind !== "parse_error") return;
    expect(out.logPath).toBe("");
  });
});

describe("handleStop: fast_confirm-attempt breadcrumb", () => {
  const fastConfirmText = [
    "- I understood the task as: ship the gate",
    "- I will do: write the patch",
    "- I will not touch: unrelated tests",
    "- I will verify by: running vitest",
    "- Assumptions: env vars are set",
  ].join("\n");

  it("writes a no_marker_fast_confirm_attempt log when bullets match without the heading", () => {
    const deps = makeDeps();
    const out = handleStop(
      makeInput({ lastAssistantText: fastConfirmText }),
      deps,
    );
    expect(out.kind).toBe("no_report");
    if (out.kind !== "no_report") return;
    expect(out.logPath).toBe("/tmp/parse-errors/log.log");
    expect(deps.parseReport).not.toHaveBeenCalled();
    expect(deps.saveReport).not.toHaveBeenCalled();
    expect(deps.writeParseErrorLog).toHaveBeenCalledTimes(1);
    const [dir, payload] = (
      deps.writeParseErrorLog as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(dir).toBe("/tmp/work/.understanding-gate/parse-errors");
    expect(payload).toContain("no_marker_fast_confirm_attempt");
    expect(payload).toContain("fast_confirm");
    expect(payload).toContain("--- raw ---");
    expect(payload).toContain("I understood the task as");
  });

  it("does NOT log when only one or two bullets happen to match (below threshold)", () => {
    const deps = makeDeps();
    const out = handleStop(
      makeInput({
        lastAssistantText:
          "Sure, I will do that and Assumptions seem fine here.",
      }),
      deps,
    );
    expect(out.kind).toBe("no_report");
    expect(deps.writeParseErrorLog).not.toHaveBeenCalled();
  });

  it("forwards UNDERSTANDING_GATE_MODE into the breadcrumb payload", () => {
    const deps = makeDeps();
    handleStop(
      makeInput({
        lastAssistantText: fastConfirmText,
        env: { UNDERSTANDING_GATE_MODE: "grill_me" },
      }),
      deps,
    );
    const [, payload] = (
      deps.writeParseErrorLog as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(payload).toContain('"mode": "grill_me"');
  });

  it("degrades to plain no_report when the breadcrumb log writer throws", () => {
    const deps = makeDeps({
      writeParseErrorLog: vi.fn(() => {
        throw new Error("disk full");
      }),
    });
    const out = handleStop(
      makeInput({ lastAssistantText: fastConfirmText }),
      deps,
    );
    expect(out.kind).toBe("no_report");
    if (out.kind !== "no_report") return;
    expect(out.logPath).toBeUndefined();
  });

  it("does NOT log when the Understanding Report marker matches (save path takes over)", () => {
    const deps = makeDeps();
    const out = handleStop(
      makeInput({
        lastAssistantText: `# Understanding Report\n\n${fastConfirmText}`,
      }),
      deps,
    );
    expect(out.kind).toBe("saved");
    expect(deps.writeParseErrorLog).not.toHaveBeenCalled();
  });
});
