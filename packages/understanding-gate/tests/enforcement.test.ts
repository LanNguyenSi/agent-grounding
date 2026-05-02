import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_WRITE_TOOLS,
  OPENCODE_WRITE_TOOLS,
  decideEnforcement,
} from "../src/core/enforcement.js";

const W = CLAUDE_CODE_WRITE_TOOLS;

describe("decideEnforcement: kill-switch", () => {
  it("returns disabled allow when UNDERSTANDING_GATE_DISABLE is truthy", () => {
    const d = decideEnforcement({
      tool: "Edit",
      writeToolNames: W,
      reportExists: false,
      reportApproved: false,
      env: { UNDERSTANDING_GATE_DISABLE: "1" },
    });
    expect(d.decision).toBe("allow");
    expect(d.mode).toBe("disabled");
  });

  for (const v of ["true", "yes", "on", "TRUE", " 1 "]) {
    it(`treats "${v}" as truthy disable`, () => {
      const d = decideEnforcement({
        tool: "Edit",
        writeToolNames: W,
        reportExists: false,
        reportApproved: false,
        env: { UNDERSTANDING_GATE_DISABLE: v },
      });
      expect(d.decision).toBe("allow");
    });
  }

  it("ignores empty / non-truthy disable values", () => {
    for (const v of ["", "0", "false", "no"]) {
      const d = decideEnforcement({
        tool: "Edit",
        writeToolNames: W,
        reportExists: false,
        reportApproved: false,
        env: { UNDERSTANDING_GATE_DISABLE: v },
      });
      expect(d.decision).toBe("block");
    }
  });
});

describe("decideEnforcement: read-only allow-list", () => {
  for (const tool of ["Read", "Grep", "Glob", "LS", "Task", "TodoWrite"]) {
    it(`always allows non-write tool "${tool}" without a report`, () => {
      const d = decideEnforcement({
        tool,
        writeToolNames: W,
        reportExists: false,
        reportApproved: false,
        env: {},
      });
      expect(d.decision).toBe("allow");
      expect(d.mode).toBe("readonly_tool");
    });
  }
});

describe("decideEnforcement: write-tool gating", () => {
  for (const tool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]) {
    it(`blocks "${tool}" with no report`, () => {
      const d = decideEnforcement({
        tool,
        writeToolNames: W,
        reportExists: false,
        reportApproved: false,
        env: {},
      });
      expect(d.decision).toBe("block");
      expect(d.mode).toBe("no_report");
      expect(d.reason).toContain(tool);
    });

    it(`blocks "${tool}" with a pending report`, () => {
      const d = decideEnforcement({
        tool,
        writeToolNames: W,
        reportExists: true,
        reportApproved: false,
        env: {},
      });
      expect(d.decision).toBe("block");
      expect(d.mode).toBe("not_approved");
    });

    it(`allows "${tool}" with an approved report`, () => {
      const d = decideEnforcement({
        tool,
        writeToolNames: W,
        reportExists: true,
        reportApproved: true,
        env: {},
      });
      expect(d.decision).toBe("allow");
      expect(d.mode).toBe("approved");
    });
  }
});

describe("decideEnforcement: force bypass", () => {
  it("blocks when FORCE is set but reason missing", () => {
    const d = decideEnforcement({
      tool: "Edit",
      writeToolNames: W,
      reportExists: false,
      reportApproved: false,
      env: { UNDERSTANDING_GATE_FORCE: "1" },
    });
    expect(d.decision).toBe("block");
    expect(d.mode).toBe("force_invalid");
  });

  it("blocks when FORCE reason is too short", () => {
    const d = decideEnforcement({
      tool: "Edit",
      writeToolNames: W,
      reportExists: false,
      reportApproved: false,
      env: {
        UNDERSTANDING_GATE_FORCE: "1",
        UNDERSTANDING_GATE_FORCE_REASON: "short",
      },
    });
    expect(d.decision).toBe("block");
    expect(d.mode).toBe("force_invalid");
  });

  it("allows when FORCE reason is >= 10 chars", () => {
    const d = decideEnforcement({
      tool: "Bash",
      writeToolNames: W,
      reportExists: false,
      reportApproved: false,
      env: {
        UNDERSTANDING_GATE_FORCE: "1",
        UNDERSTANDING_GATE_FORCE_REASON: "incident-recovery now",
      },
    });
    expect(d.decision).toBe("allow");
    expect(d.mode).toBe("force_bypass");
    expect(d.reason).toContain("incident-recovery now");
  });

  it("FORCE does not override the read-only allow short-circuit", () => {
    const d = decideEnforcement({
      tool: "Read",
      writeToolNames: W,
      reportExists: false,
      reportApproved: false,
      env: {
        UNDERSTANDING_GATE_FORCE: "1",
        UNDERSTANDING_GATE_FORCE_REASON: "incident-recovery",
      },
    });
    // Read is read-only first, so the FORCE branch never runs; mode must
    // stay "readonly_tool" (not "force_bypass") so audit volume reflects
    // reality.
    expect(d.decision).toBe("allow");
    expect(d.mode).toBe("readonly_tool");
  });
});

describe("decideEnforcement: opencode tool names", () => {
  it("blocks the lowercase `write` tool with no report", () => {
    const d = decideEnforcement({
      tool: "write",
      writeToolNames: OPENCODE_WRITE_TOOLS,
      reportExists: false,
      reportApproved: false,
      env: {},
    });
    expect(d.decision).toBe("block");
  });

  it("does not block claude-code-cased `Write` against the opencode set", () => {
    const d = decideEnforcement({
      tool: "Write",
      writeToolNames: OPENCODE_WRITE_TOOLS,
      reportExists: false,
      reportApproved: false,
      env: {},
    });
    expect(d.decision).toBe("allow");
    expect(d.mode).toBe("readonly_tool");
  });
});
