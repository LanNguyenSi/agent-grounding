import { describe, expect, it } from "vitest";
import {
  findLatestForTask,
  isApproved,
  withApprovalStatus,
} from "../src/core/approval.js";
import type { ReportEntry } from "../src/core/persistence.js";
import type { UnderstandingReport } from "../src/schema/types.js";

function entry(overrides: Partial<ReportEntry> = {}): ReportEntry {
  return {
    path: "/tmp/dummy.json",
    taskId: "task-a",
    mode: "fast_confirm",
    riskLevel: "medium",
    approvalStatus: "pending",
    createdAt: "2026-05-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("findLatestForTask", () => {
  it("returns null when no entry matches", () => {
    expect(findLatestForTask([entry({ taskId: "x" })], "y")).toBeNull();
  });

  it("returns the only matching entry", () => {
    const e = entry();
    expect(findLatestForTask([e], "task-a")).toBe(e);
  });

  it("prefers approvedAt over createdAt when sorting", () => {
    const older = entry({
      path: "/tmp/older.json",
      createdAt: "2026-05-01T10:00:00.000Z",
    });
    const newerApproved = entry({
      path: "/tmp/newer.json",
      createdAt: "2026-05-01T10:00:00.000Z", // same draft time
      approvalStatus: "approved",
      approvedAt: "2026-05-02T08:00:00.000Z",
    });
    const latest = findLatestForTask([older, newerApproved], "task-a");
    expect(latest?.path).toBe("/tmp/newer.json");
    expect(latest?.approvalStatus).toBe("approved");
  });

  it("falls back to createdAt when no approvedAt is present", () => {
    const a = entry({ path: "/tmp/a.json", createdAt: "2026-05-01T10:00:00.000Z" });
    const b = entry({ path: "/tmp/b.json", createdAt: "2026-05-02T10:00:00.000Z" });
    expect(findLatestForTask([a, b], "task-a")?.path).toBe("/tmp/b.json");
  });

  it("ignores entries for other taskIds", () => {
    const wrong = entry({ taskId: "other", createdAt: "2026-05-09T10:00:00.000Z" });
    const right = entry({ path: "/tmp/right.json" });
    expect(findLatestForTask([wrong, right], "task-a")?.path).toBe("/tmp/right.json");
  });
});

describe("isApproved", () => {
  it("returns false for null", () => {
    expect(isApproved(null)).toBe(false);
  });
  it("returns false for non-approved entries", () => {
    expect(isApproved(entry({ approvalStatus: "pending" }))).toBe(false);
    expect(isApproved(entry({ approvalStatus: "rejected" }))).toBe(false);
    expect(isApproved(entry({ approvalStatus: "revision_requested" }))).toBe(false);
  });
  it("returns true only for approved", () => {
    expect(isApproved(entry({ approvalStatus: "approved" }))).toBe(true);
  });
});

describe("withApprovalStatus", () => {
  const baseReport: UnderstandingReport = {
    taskId: "task-a",
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

  it("sets approvedAt + approvedBy when approving", () => {
    const now = new Date("2026-05-02T11:00:00.000Z");
    const next = withApprovalStatus(baseReport, "approved", "cli", now);
    expect(next.approvalStatus).toBe("approved");
    expect(next.approvedAt).toBe("2026-05-02T11:00:00.000Z");
    expect(next.approvedBy).toBe("cli");
  });

  it("clears approvedAt + approvedBy when reverting to pending", () => {
    const approved: UnderstandingReport = {
      ...baseReport,
      approvalStatus: "approved",
      approvedAt: "2026-05-02T11:00:00.000Z",
      approvedBy: "cli",
    };
    const next = withApprovalStatus(approved, "pending", "cli");
    expect(next.approvalStatus).toBe("pending");
    expect(next.approvedAt).toBeUndefined();
    expect(next.approvedBy).toBeUndefined();
  });

  it("does not mutate the input", () => {
    const before = JSON.parse(JSON.stringify(baseReport)) as UnderstandingReport;
    withApprovalStatus(baseReport, "approved", "cli", new Date());
    expect(baseReport).toEqual(before);
  });

  it("refreshes createdAt to `now` on every state flip", () => {
    // The persisted file is a snapshot of report state; createdAt is
    // the snapshot's birth time, not the original draft time. This is
    // load-bearing for findLatestForTask's sort: the most recent flip
    // must beat older snapshots in the same dir.
    const t1 = new Date("2026-05-02T11:00:00.000Z");
    const t2 = new Date("2026-05-02T12:00:00.000Z");
    const approved = withApprovalStatus(baseReport, "approved", "cli", t1);
    const revoked = withApprovalStatus(approved, "pending", "cli", t2);
    expect(approved.createdAt).toBe(t1.toISOString());
    expect(revoked.createdAt).toBe(t2.toISOString());
    expect(approved.createdAt).not.toBe(baseReport.createdAt);
  });
});
