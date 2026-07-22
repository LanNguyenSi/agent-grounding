import { describe, expect, it, vi } from "vitest";
import {
  handleStop,
  type StopHookDeps,
  type StopHookInput,
} from "../src/adapters/claude-code/handle-stop.js";
import {
  PARSE_ERROR_RAW_MAX_BYTES,
  truncateForLog,
} from "../src/adapters/error-log.js";
import type { UnderstandingReport } from "../src/schema/types.js";
import { parseReport, type ParseResult } from "../src/core/parser.js";

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
  priorArt: ["h"],
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
  it("calls parseReport with sessionId as boundTaskId default when env is empty", () => {
    const deps = makeDeps();
    handleStop(makeInput({ sessionId: "session-zzz" }), deps);
    expect(deps.parseReport).toHaveBeenCalledTimes(1);
    const [, defaults] = (deps.parseReport as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(defaults).toMatchObject({
      boundTaskId: "session-zzz",
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
    expect(defaults.boundTaskId).toBe("explicit-task-1");
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
    // The persisted report is the parsed one plus the session binding
    // taken from the hook payload (never from the agent's markdown).
    expect(deps.saveReport).toHaveBeenCalledWith(
      { ...validReport, sessionId: "session-xyz" },
      { cwd: "/tmp/work" },
    );
    expect(out.report.sessionId).toBe("session-xyz");
  });

  it("passes an empty SaveOptions when UNDERSTANDING_GATE_REPORT_DIR is set (lets persistence read env)", () => {
    const deps = makeDeps();
    handleStop(
      makeInput({ env: { UNDERSTANDING_GATE_REPORT_DIR: "/anywhere" } }),
      deps,
    );
    expect(deps.saveReport).toHaveBeenCalledWith(
      { ...validReport, sessionId: "session-xyz" },
      {},
    );
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

  it("caps the raw assistant-text section so a 1 MB input writes a bounded log", () => {
    const oneMb = `# Understanding Report\n\n${"x".repeat(1024 * 1024)}`;
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
    handleStop(makeInput({ lastAssistantText: oneMb }), deps);
    const [, payload] = (
      deps.writeParseErrorLog as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(typeof payload).toBe("string");
    expect((payload as string).length).toBeLessThan(100 * 1024);
    expect(payload as string).toContain("[truncated ");
    expect(payload as string).toContain("more bytes]");
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

describe("truncateForLog", () => {
  it("returns the input unchanged when under the limit", () => {
    expect(truncateForLog("short", PARSE_ERROR_RAW_MAX_BYTES)).toBe("short");
  });
  it("appends a byte-accurate truncation marker when over the limit", () => {
    const input = "a".repeat(70 * 1024);
    const out = truncateForLog(input, 64 * 1024);
    expect(out.startsWith("a".repeat(64 * 1024))).toBe(true);
    expect(out).toContain(`[truncated ${70 * 1024 - 64 * 1024} more bytes]`);
  });
});

describe("handleStop: fast_confirm bullet routing", () => {
  // agent-tasks/eaac8fe5: fast_confirm bullets no longer dead-end in a
  // breadcrumb. The handler routes them to parseReport, which now maps
  // the 5 bullet prefixes to canonical sections + validates against the
  // fast_confirm-relaxed schema. The breadcrumb has been replaced by
  // the existing parse_error log surface (kind: "parse_error") for
  // the subset of inputs where bullets look right but parsing still
  // fails (e.g., wrong mode in env).
  const fastConfirmText = [
    "- I understood the task as: ship the gate",
    "- I will do: write the patch",
    "- I will not touch: unrelated tests",
    "- I will verify by: running vitest",
    "- Assumptions: env vars are set",
  ].join("\n");

  it("routes bullets to parseReport (no early-return; parser sees them)", () => {
    const deps = makeDeps();
    handleStop(
      makeInput({ lastAssistantText: fastConfirmText }),
      deps,
    );
    expect(deps.parseReport).toHaveBeenCalledTimes(1);
    const [text, defaults] = (
      deps.parseReport as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    expect(text).toBe(fastConfirmText);
    // Default mode is fast_confirm; the parser will pick the relaxed
    // schema based on this and bullet-map the 5 prefixes.
    expect(defaults.mode).toBe("fast_confirm");
  });

  it("does NOT route when below the 4-of-5 threshold (3 incidental bullet matches)", () => {
    const deps = makeDeps();
    const out = handleStop(
      makeInput({
        lastAssistantText: [
          "- I will do the refactor next sprint",
          "- I will not touch the legacy auth code",
          "- I will verify by running the suite",
        ].join("\n"),
      }),
      deps,
    );
    expect(out.kind).toBe("no_report");
    expect(deps.parseReport).not.toHaveBeenCalled();
    expect(deps.writeParseErrorLog).not.toHaveBeenCalled();
  });

  it("tolerates indented and mixed-marker bullets in the heuristic", () => {
    const deps = makeDeps();
    handleStop(
      makeInput({
        lastAssistantText: [
          "  * I understood the task as: foo",
          "  + I will do: bar",
          "  - I will not touch: baz",
          "  * I will verify by: qux",
        ].join("\n"),
      }),
      deps,
    );
    expect(deps.parseReport).toHaveBeenCalledTimes(1);
  });

  it("forwards UNDERSTANDING_GATE_MODE into parseReport defaults", () => {
    const deps = makeDeps();
    handleStop(
      makeInput({
        lastAssistantText: fastConfirmText,
        env: { UNDERSTANDING_GATE_MODE: "grill_me" },
      }),
      deps,
    );
    expect(deps.parseReport).toHaveBeenCalledTimes(1);
    const [, defaults] = (
      deps.parseReport as ReturnType<typeof vi.fn>
    ).mock.calls[0];
    // Env mode overrides the default "fast_confirm"; the parser will
    // then run the strict schema against the 5 bullets and (correctly)
    // reject as the bullets do not satisfy the strict 9-section shape.
    expect(defaults.mode).toBe("grill_me");
  });

  it("emits parse_error (not no_report) when bullets reach parser but fail validation", () => {
    // Simulate a parser failure: the dep mock can return ok:false.
    const deps = makeDeps({
      parseReport: vi.fn(() => ({
        ok: false as const,
        error: {
          reason: "missing_sections" as const,
          missing: ["currentUnderstanding"],
          schemaErrors: [],
          message: "Missing required sections",
        },
      })),
    });
    const out = handleStop(
      makeInput({ lastAssistantText: fastConfirmText }),
      deps,
    );
    expect(out.kind).toBe("parse_error");
    expect(deps.writeParseErrorLog).toHaveBeenCalledTimes(1);
  });

  it("does NOT route when the Understanding Report marker matches (save path takes over)", () => {
    const deps = makeDeps();
    const out = handleStop(
      makeInput({
        lastAssistantText: `# Understanding Report\n\n${fastConfirmText}`,
      }),
      deps,
    );
    expect(out.kind).toBe("saved");
    expect(deps.parseReport).toHaveBeenCalledTimes(1);
  });
});

describe("handleStop: never silent for a report-marker message (discovery C1)", () => {
  // The incident shape: a `## Understanding Report` marker (so REPORT_MARKER_RE
  // matches) with sections written as bold labels rather than `##` headings.
  const INCIDENT_MARKDOWN = `## Understanding Report

**My current understanding:**
Fix the parser to accept bold-label sections.

**Intended outcome:**
A bold-label report parses and is saved, not dropped.

**Derived todos:**
- accept bold-label section headers
- never leave zero artifacts

**Acceptance criteria:**
- bold-label report yields a saved report

**Assumptions:**
- bold labels use ** markers

**Open questions:**
- none

**Out of scope:**
- changing the SECTIONS list

**Risks:**
- false-positive bold promotion

**Verification plan:**
- unit tests

**Prior art:**
- no equivalent in the codebase, building new

## Metadata
taskId: incident-c1
mode: grill_me
riskLevel: high
requiresHumanApproval: true
`;

  it("saves the report (kind:saved) for the bold-label incident shape", () => {
    // Use the REAL parser so the fix is exercised end to end.
    const deps = makeDeps({ parseReport });
    const out = handleStop(
      makeInput({ lastAssistantText: INCIDENT_MARKDOWN }),
      deps,
    );
    expect(out.kind).toBe("saved");
  });

  it("returns parse_error (never no_report) when the marker matches but parsing fails", () => {
    const deps = makeDeps({
      parseReport: vi.fn(
        (): ParseResult => ({
          ok: false,
          error: {
            reason: "missing_sections",
            missing: ["currentUnderstanding"],
            schemaErrors: [],
            message: "Missing required sections",
          },
        }),
      ),
    });
    const out = handleStop(
      makeInput({
        lastAssistantText: "## Understanding Report\n\nno parseable sections here",
      }),
      deps,
    );
    expect(out.kind).toBe("parse_error");
    expect(deps.writeParseErrorLog).toHaveBeenCalledTimes(1);
  });

  it("leaves a stderr breadcrumb (still parse_error) when the parse-error log write throws", () => {
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
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
      writeParseErrorLog: vi.fn(() => {
        throw new Error("disk full");
      }),
    });
    const out = handleStop(
      makeInput({ lastAssistantText: "## Understanding Report\n\ngarbage" }),
      deps,
    );
    expect(out.kind).toBe("parse_error");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to write parse-error log"),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining("disk full"),
    );
    consoleErrorSpy.mockRestore();
  });
});


describe("handleStop: session binding cannot be forged (task 0a3227fe)", () => {
  it("stamps the sessionId from the hook payload, ignoring any `sessionId` the agent wrote in Metadata", () => {
    // The parser's METADATA_KEYS whitelist has no `sessionid` entry, so
    // agent markdown cannot reach the field. Assert the end-to-end
    // consequence: the persisted binding is the runtime's session, not
    // the one the report claims. A forged binding would let an agent
    // aim its report at another session's approval.
    const deps = makeDeps();
    handleStop(
      makeInput({
        sessionId: "real-session",
        lastAssistantText: [
          "## Understanding Report",
          "",
          "**Metadata**",
          "",
          "taskId: task-1",
          "sessionId: attacker-session",
          "mode: grill_me",
          "riskLevel: low",
        ].join("\n"),
      }),
      deps,
    );
    const [saved] = (deps.saveReport as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(saved.sessionId).toBe("real-session");
  });

  it("leaves sessionId unset when the payload carries no session id", () => {
    const deps = makeDeps();
    const out = handleStop(makeInput({ sessionId: "" }), deps);
    expect(out.kind).toBe("saved");
    const [saved] = (deps.saveReport as ReturnType<typeof vi.fn>).mock.calls[0];
    expect("sessionId" in saved).toBe(false);
  });
});
