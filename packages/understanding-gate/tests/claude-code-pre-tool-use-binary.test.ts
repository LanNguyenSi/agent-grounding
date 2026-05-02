import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { saveReport } from "../src/core/persistence.js";
import { defaultAuditLogPath } from "../src/core/audit.js";
import type { UnderstandingReport } from "../src/schema/types.js";

// End-to-end check for the PreToolUse hook: spawn the compiled binary
// as Claude Code would, pipe a hook payload on stdin, and assert the
// exit code + stdout envelope + audit-log effect. Mirrors the Stop
// binary's harness style.

const PKG_ROOT = resolve(__dirname, "..");
const BINARY = resolve(PKG_ROOT, "dist/adapters/claude-code/pre-tool-use.js");

const baseReport: UnderstandingReport = {
  taskId: "session-bin",
  mode: "fast_confirm",
  riskLevel: "medium",
  currentUnderstanding: "x",
  intendedOutcome: "x",
  derivedTodos: ["t"],
  acceptanceCriteria: ["a"],
  assumptions: ["a"],
  openQuestions: ["q"],
  outOfScope: ["o"],
  risks: ["r"],
  verificationPlan: ["v"],
  requiresHumanApproval: true,
  approvalStatus: "pending",
  createdAt: "2026-05-01T10:00:00.000Z",
};

let tmp: string;

beforeAll(() => {
  if (!existsSync(BINARY)) {
    execFileSync("npm", ["run", "build"], { cwd: PKG_ROOT, stdio: "ignore" });
  }
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ug-pre-tool-use-bin-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function runHook(
  payload: Record<string, unknown>,
  envOverride: NodeJS.ProcessEnv = {},
): { code: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [BINARY], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...envOverride },
  });
  return {
    code: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("claude-code PreToolUse binary (end-to-end)", () => {
  it("blocks Edit with exit 2 and a deny envelope when no report exists", () => {
    const { code, stdout, stderr } = runHook({
      session_id: "session-bin",
      cwd: tmp,
      tool_name: "Edit",
      hook_event_name: "PreToolUse",
    });
    expect(code).toBe(2);
    const env = JSON.parse(stdout) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(env.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(stderr).toContain("Edit");

    // Audit-log entry written.
    const auditPath = defaultAuditLogPath(tmp);
    expect(existsSync(auditPath)).toBe(true);
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const event = JSON.parse(lines[0]) as { kind: string; tool: string };
    expect(event.kind).toBe("block");
    expect(event.tool).toBe("Edit");
  });

  it("allows silently when an approved report exists for the session", () => {
    saveReport(
      {
        ...baseReport,
        approvalStatus: "approved",
        approvedAt: "2026-05-02T08:00:00.000Z",
        approvedBy: "cli",
      },
      { cwd: tmp },
    );
    const { code, stdout } = runHook({
      session_id: "session-bin",
      cwd: tmp,
      tool_name: "Edit",
      hook_event_name: "PreToolUse",
    });
    expect(code).toBe(0);
    expect(stdout).toBe("");
    // No audit entry on the silent-allow path.
    expect(existsSync(defaultAuditLogPath(tmp))).toBe(false);
  });

  it("allows Read silently with no report", () => {
    const { code, stdout } = runHook({
      session_id: "session-bin",
      cwd: tmp,
      tool_name: "Read",
      hook_event_name: "PreToolUse",
    });
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  it("does not crash on malformed stdin JSON", () => {
    const result = spawnSync("node", [BINARY], {
      input: "garbage {{{",
      encoding: "utf8",
      env: process.env,
    });
    // Malformed input → degrade to allow → exit 0.
    expect(result.status, result.stderr ?? "").toBe(0);
  });

  it("respects UNDERSTANDING_GATE_DISABLE", () => {
    const { code } = runHook(
      {
        session_id: "session-bin",
        cwd: tmp,
        tool_name: "Bash",
        hook_event_name: "PreToolUse",
      },
      { UNDERSTANDING_GATE_DISABLE: "1" },
    );
    expect(code).toBe(0);
  });

  it("audits + allows when force-bypass env is valid", () => {
    const { code } = runHook(
      {
        session_id: "session-bin",
        cwd: tmp,
        tool_name: "Bash",
        hook_event_name: "PreToolUse",
      },
      {
        UNDERSTANDING_GATE_FORCE: "1",
        UNDERSTANDING_GATE_FORCE_REASON: "incident-recovery now",
      },
    );
    expect(code).toBe(0);
    const lines = readFileSync(defaultAuditLogPath(tmp), "utf8")
      .trim()
      .split("\n");
    const event = JSON.parse(lines[0]) as { kind: string; reason: string };
    expect(event.kind).toBe("force_bypass");
    expect(event.reason).toContain("incident-recovery");
  });
});
