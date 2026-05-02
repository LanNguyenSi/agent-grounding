import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runApprove,
  runRevoke,
  runStatus,
} from "../src/cli/approve.js";
import {
  listReports,
  saveReport,
} from "../src/core/persistence.js";
import { defaultAuditLogPath } from "../src/core/audit.js";
import { findLatestForTask } from "../src/core/approval.js";
import type { UnderstandingReport } from "../src/schema/types.js";

const baseReport: UnderstandingReport = {
  taskId: "session-cli",
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

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ug-cli-approve-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("runApprove", () => {
  it("errors when there are no reports", () => {
    const r = runApprove({ cwd: tmp });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("no reports");
  });

  it("approves the only report and writes an audit entry", () => {
    saveReport(baseReport, { cwd: tmp });
    const r = runApprove({
      cwd: tmp,
      now: new Date("2026-05-02T11:00:00.000Z"),
    });
    expect(r.exitCode).toBe(0);
    const entries = listReports({ cwd: tmp });
    const approved = entries.filter((e) => e.approvalStatus === "approved");
    expect(approved).toHaveLength(1);
    expect(approved[0].approvedAt).toBe("2026-05-02T11:00:00.000Z");

    const auditPath = defaultAuditLogPath(tmp);
    expect(existsSync(auditPath)).toBe(true);
    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as { kind: string; approvedBy: string };
    expect(entry.kind).toBe("approve");
    expect(entry.approvedBy).toBe("cli");
  });

  it("disambiguates by --task-id when multiple distinct taskIds exist", () => {
    saveReport(baseReport, { cwd: tmp });
    saveReport({ ...baseReport, taskId: "other-task" }, { cwd: tmp });
    const ambig = runApprove({ cwd: tmp });
    expect(ambig.exitCode).toBe(1);
    expect(ambig.stderr).toContain("multiple reports");

    const ok = runApprove({ cwd: tmp, taskId: "session-cli" });
    expect(ok.exitCode).toBe(0);
    const entries = listReports({ cwd: tmp });
    const approved = entries.filter((e) => e.approvalStatus === "approved");
    expect(approved).toHaveLength(1);
    expect(approved[0].taskId).toBe("session-cli");
  });

  it("preserves the original pending file (audit trail)", () => {
    const saved = saveReport(baseReport, { cwd: tmp });
    runApprove({ cwd: tmp, now: new Date() });
    expect(existsSync(saved.path)).toBe(true);
    const original = JSON.parse(
      readFileSync(saved.path, "utf8"),
    ) as UnderstandingReport;
    expect(original.approvalStatus).toBe("pending");
  });
});

describe("runRevoke", () => {
  it("flips an approved report back to pending", () => {
    saveReport({ ...baseReport, approvalStatus: "approved" }, { cwd: tmp });
    const r = runRevoke({ cwd: tmp });
    expect(r.exitCode).toBe(0);
    const entries = listReports({ cwd: tmp });
    // Latest entry (by approvedAt fallback createdAt) should now be pending
    const sorted = entries
      .slice()
      .sort((a, b) =>
        (b.approvedAt ?? b.createdAt).localeCompare(a.approvedAt ?? a.createdAt),
      );
    expect(sorted[0].approvalStatus).toBe("pending");

    const lines = readFileSync(defaultAuditLogPath(tmp), "utf8")
      .trim()
      .split("\n");
    expect(JSON.parse(lines[lines.length - 1] ?? "{}").kind).toBe("revoke");
  });

  // Regression net for the load-bearing audit story: a revoke after a
  // real approve must clear approvedAt/approvedBy AND bump createdAt so
  // findLatestForTask picks the revoked snapshot, not the older approved
  // one whose `approvedAt` would otherwise win the sort.
  it("approve → revoke → findLatestForTask returns the revoked snapshot", () => {
    saveReport(baseReport, { cwd: tmp });
    runApprove({
      cwd: tmp,
      now: new Date("2026-05-02T11:00:00.000Z"),
    });
    runRevoke({
      cwd: tmp,
      now: new Date("2026-05-02T12:00:00.000Z"),
    });

    const entries = listReports({ cwd: tmp });
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const latest = findLatestForTask(entries, "session-cli");
    expect(latest).not.toBeNull();
    expect(latest?.approvalStatus).toBe("pending");
    expect(latest?.approvedAt).toBeUndefined();
  });
});

describe("runStatus", () => {
  it("reports 'no reports' on empty dir", () => {
    const r = runStatus({ cwd: tmp });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("no reports");
  });

  it("lists entries grouped by taskId", () => {
    saveReport(baseReport, { cwd: tmp });
    saveReport({ ...baseReport, taskId: "other-task" }, { cwd: tmp });
    const r = runStatus({ cwd: tmp });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("session-cli");
    expect(r.stdout).toContain("other-task");
    expect(r.stdout).toContain("pending");
  });

  it("filters by --task-id", () => {
    saveReport(baseReport, { cwd: tmp });
    saveReport({ ...baseReport, taskId: "other-task" }, { cwd: tmp });
    const r = runStatus({ cwd: tmp, taskId: "session-cli" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("session-cli");
    expect(r.stdout).not.toContain("other-task");
  });

  it("never mutates files (no audit entry)", () => {
    saveReport(baseReport, { cwd: tmp });
    runStatus({ cwd: tmp });
    expect(existsSync(defaultAuditLogPath(tmp))).toBe(false);
  });

  it("shows the approved status after runApprove", () => {
    saveReport(baseReport, { cwd: tmp });
    runApprove({ cwd: tmp, now: new Date("2026-05-02T11:00:00.000Z") });
    const r = runStatus({ cwd: tmp });
    expect(r.stdout).toContain("approved");
    expect(r.stdout).toContain("2026-05-02");
  });
});
