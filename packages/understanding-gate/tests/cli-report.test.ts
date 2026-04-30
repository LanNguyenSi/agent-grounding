import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReportList, runReportShow } from "../src/cli/report.js";
import { saveReport } from "../src/core/persistence.js";
import type { UnderstandingReport } from "../src/schema/types.js";

const baseReport: UnderstandingReport = {
  taskId: "ug-cli-1",
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
  createdAt: "2026-04-30T11:00:00.000Z",
};

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ug-cli-report-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("runReportList", () => {
  it("prints a 'no reports' message and exits 0 against an empty dir", () => {
    const result = runReportList({ dir: tmpDir });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toMatch(/no reports/);
    expect(result.stdout).toContain(tmpDir);
  });

  it("prints a table with header + rows when reports exist", () => {
    saveReport(baseReport, { dir: tmpDir });
    saveReport(
      { ...baseReport, taskId: "ug-cli-2", createdAt: "2026-04-30T12:00:00.000Z" },
      { dir: tmpDir, now: new Date("2026-04-30T12:00:00.000Z") },
    );
    const result = runReportList({ dir: tmpDir });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("createdAt");
    expect(result.stdout).toContain("ug-cli-1");
    expect(result.stdout).toContain("ug-cli-2");
    // Newest first.
    const idx1 = result.stdout.indexOf("ug-cli-1");
    const idx2 = result.stdout.indexOf("ug-cli-2");
    expect(idx2).toBeLessThan(idx1);
  });

  it("emits JSON when --json is set", () => {
    saveReport(baseReport, { dir: tmpDir });
    const result = runReportList({ dir: tmpDir, json: true });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].taskId).toBe("ug-cli-1");
  });

  it("emits an empty JSON array on an empty dir when --json", () => {
    const result = runReportList({ dir: tmpDir, json: true });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });
});

describe("runReportShow", () => {
  it("prints the full JSON for a known taskId", () => {
    saveReport(baseReport, { dir: tmpDir });
    const result = runReportShow({ id: "ug-cli-1", dir: tmpDir });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout);
    expect(parsed.taskId).toBe("ug-cli-1");
    expect(parsed.intendedOutcome).toBe("y");
  });

  it("exits 1 with a single-line stderr for an unknown id", () => {
    const result = runReportShow({ id: "no-such-thing", dir: tmpDir });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/no-such-thing/);
    // No raw multi-line Node stack frame should leak.
    expect(result.stderr).not.toMatch(/\n\s+at /);
  });

  it("exits 1 with parse_error for a corrupted file", () => {
    const path = join(tmpDir, "2026-04-30-broken-ug-cli-1.json");
    writeFileSync(path, "{not json", "utf8");
    const result = runReportShow({ id: path, dir: tmpDir });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/Failed to parse/);
  });
});
