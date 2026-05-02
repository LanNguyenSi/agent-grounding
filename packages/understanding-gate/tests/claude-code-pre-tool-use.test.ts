import { describe, expect, it, vi } from "vitest";
import { handlePreToolUse } from "../src/adapters/claude-code/handle-pre-tool-use.js";
import type { ReportEntry } from "../src/core/persistence.js";
import type { AuditEvent } from "../src/core/audit.js";

function makeDeps(entries: ReportEntry[] = []) {
  const audits: Array<{ cwd: string; event: AuditEvent }> = [];
  return {
    audits,
    deps: {
      listReports: vi.fn(() => entries),
      now: () => new Date("2026-05-02T12:00:00.000Z"),
      appendAudit: vi.fn((cwd: string, event: AuditEvent) => {
        audits.push({ cwd, event });
      }),
    },
  };
}

function entry(overrides: Partial<ReportEntry> = {}): ReportEntry {
  return {
    path: "/tmp/r.json",
    taskId: "session-x",
    mode: "fast_confirm",
    riskLevel: "medium",
    approvalStatus: "pending",
    createdAt: "2026-05-01T10:00:00.000Z",
    ...overrides,
  };
}

const PAYLOAD = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: "session-x",
    cwd: "/tmp/proj",
    tool_name: "Edit",
    hook_event_name: "PreToolUse",
    ...over,
  });

describe("handlePreToolUse: payload parsing", () => {
  it("degrades to allow when stdin is empty", () => {
    const { deps, audits } = makeDeps();
    const r = handlePreToolUse("", {}, deps);
    expect(r.exitCode).toBe(0);
    expect(r.decision.decision).toBe("allow");
    expect(r.degraded).toBe(true);
    expect(audits).toHaveLength(0);
  });

  it("degrades to allow on non-JSON stdin", () => {
    const { deps } = makeDeps();
    const r = handlePreToolUse("not json", {}, deps);
    expect(r.exitCode).toBe(0);
    expect(r.degraded).toBe(true);
  });

  it("degrades to allow on JSON array (not an object)", () => {
    const { deps } = makeDeps();
    const r = handlePreToolUse("[1,2,3]", {}, deps);
    expect(r.exitCode).toBe(0);
    expect(r.degraded).toBe(true);
  });

  it("degrades to allow when tool_name is missing", () => {
    const { deps } = makeDeps();
    const r = handlePreToolUse(JSON.stringify({ session_id: "x" }), {}, deps);
    expect(r.exitCode).toBe(0);
    expect(r.degraded).toBe(true);
  });
});

describe("handlePreToolUse: enforcement decisions", () => {
  it("allows Read silently with no report", () => {
    const { deps } = makeDeps();
    const r = handlePreToolUse(PAYLOAD({ tool_name: "Read" }), {}, deps);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.decision.mode).toBe("readonly_tool");
  });

  it("blocks Edit with exit 2 + JSON envelope when no report", () => {
    const { deps, audits } = makeDeps();
    const r = handlePreToolUse(PAYLOAD(), {}, deps);
    expect(r.exitCode).toBe(2);
    const env = JSON.parse(r.stdout) as {
      hookSpecificOutput: {
        hookEventName: string;
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };
    expect(env.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(env.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(env.hookSpecificOutput.permissionDecisionReason).toContain("Edit");
    expect(r.stderr).toContain("Edit");
    expect(audits).toHaveLength(1);
    expect(audits[0].event.kind).toBe("block");
    expect(audits[0].cwd).toBe("/tmp/proj");
  });

  it("blocks when latest report is pending", () => {
    const { deps, audits } = makeDeps([
      entry({ approvalStatus: "pending" }),
    ]);
    const r = handlePreToolUse(PAYLOAD(), {}, deps);
    expect(r.exitCode).toBe(2);
    expect(r.decision.mode).toBe("not_approved");
    expect(audits).toHaveLength(1);
  });

  it("allows silently when latest report is approved", () => {
    const { deps, audits } = makeDeps([
      entry({
        approvalStatus: "approved",
        approvedAt: "2026-05-02T08:00:00.000Z",
      }),
    ]);
    const r = handlePreToolUse(PAYLOAD(), {}, deps);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.decision.mode).toBe("approved");
    expect(audits).toHaveLength(0);
  });

  it("respects UNDERSTANDING_GATE_TASK_ID over session_id when looking up reports", () => {
    const { deps, audits } = makeDeps([
      entry({ taskId: "explicit-task", approvalStatus: "approved", approvedAt: "z" }),
      entry({ taskId: "session-x", approvalStatus: "pending" }),
    ]);
    const r = handlePreToolUse(
      PAYLOAD(),
      { UNDERSTANDING_GATE_TASK_ID: "explicit-task" },
      deps,
    );
    expect(r.decision.mode).toBe("approved");
    expect(r.exitCode).toBe(0);
    expect(audits).toHaveLength(0);
  });

  it("audits a force_bypass and allows", () => {
    const { deps, audits } = makeDeps();
    const r = handlePreToolUse(
      PAYLOAD({ tool_name: "Bash" }),
      {
        UNDERSTANDING_GATE_FORCE: "1",
        UNDERSTANDING_GATE_FORCE_REASON: "incident-recovery now",
      },
      deps,
    );
    expect(r.decision.mode).toBe("force_bypass");
    expect(r.exitCode).toBe(0);
    expect(audits).toHaveLength(1);
    expect(audits[0].event.kind).toBe("force_bypass");
  });

  it("blocks force_invalid (FORCE without reason)", () => {
    const { deps, audits } = makeDeps();
    const r = handlePreToolUse(
      PAYLOAD({ tool_name: "Bash" }),
      { UNDERSTANDING_GATE_FORCE: "1" },
      deps,
    );
    expect(r.decision.mode).toBe("force_invalid");
    expect(r.exitCode).toBe(2);
    expect(audits).toHaveLength(1);
    expect(audits[0].event.kind).toBe("block");
  });

  it("respects UNDERSTANDING_GATE_DISABLE", () => {
    const { deps, audits } = makeDeps();
    const r = handlePreToolUse(
      PAYLOAD({ tool_name: "Edit" }),
      { UNDERSTANDING_GATE_DISABLE: "1" },
      deps,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(audits).toHaveLength(0);
  });

  it("never throws when listReports throws", () => {
    const { audits } = makeDeps();
    const deps = {
      listReports: vi.fn(() => {
        throw new Error("disk on fire");
      }),
      now: () => new Date(),
      appendAudit: vi.fn((cwd: string, event: AuditEvent) => {
        audits.push({ cwd, event });
      }),
    };
    expect(() => handlePreToolUse(PAYLOAD(), {}, deps)).not.toThrow();
    const r = handlePreToolUse(PAYLOAD(), {}, deps);
    expect(r.exitCode).toBe(2); // no entries → block
  });

  it("never throws when appendAudit throws", () => {
    const deps = {
      listReports: vi.fn((): ReportEntry[] => []),
      now: () => new Date(),
      appendAudit: vi.fn(() => {
        throw new Error("audit broken");
      }),
    };
    expect(() => handlePreToolUse(PAYLOAD(), {}, deps)).not.toThrow();
    const r = handlePreToolUse(PAYLOAD(), {}, deps);
    expect(r.exitCode).toBe(2); // decision unchanged by audit failure
  });
});
