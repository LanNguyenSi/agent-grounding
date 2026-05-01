import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSyncAndLog } from "../src/adapters/claude-code/sync-and-log.js";
import { writeAtomicText } from "../src/core/fs.js";
import type { UnderstandingReport } from "../src/schema/types.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ug-sync-log-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const baseReport: UnderstandingReport = {
  taskId: "ug-sync-log",
  mode: "fast_confirm",
  riskLevel: "low",
  currentUnderstanding: "u",
  intendedOutcome: "o",
  derivedTodos: ["a"],
  acceptanceCriteria: ["b"],
  assumptions: ["c"],
  openQuestions: [],
  outOfScope: [],
  risks: [],
  verificationPlan: ["p"],
  requiresHumanApproval: false,
  approvalStatus: "approved",
  createdAt: "2026-04-30T12:00:00.000Z",
};

describe("runSyncAndLog", () => {
  it("returns ok and writes no log when sync succeeds", () => {
    const reportDir = join(tmp, "reports");
    mkdirSync(reportDir, { recursive: true });
    const reportPath = join(reportDir, "x.json");
    const syncErrDir = join(tmp, "sync-errors");

    const outcome = runSyncAndLog(baseReport, reportPath, "session-ok", {
      resolveSyncErrorDir: () => syncErrDir,
      writeSyncErrorLog: (dir, payload) => {
        const path = join(dir, "should-not-be-called.log");
        writeAtomicText(path, payload);
        return path;
      },
    });

    expect(outcome.kind).toBe("ok");
    expect(existsSync(syncErrDir)).toBe(false);
  });

  it("writes a sync-error log and returns kind=error when sync fails", () => {
    // Force the underlying saveStore to fail by staging a directory
    // exactly where the helper would write hypotheses.json.
    const reportDir = join(tmp, "reports");
    mkdirSync(reportDir, { recursive: true });
    const reportPath = join(reportDir, "x.json");
    const blockingStore = join(tmp, "hypotheses.json");
    mkdirSync(blockingStore, { recursive: true });

    const syncErrDir = join(tmp, "sync-errors");
    const outcome = runSyncAndLog(baseReport, reportPath, "session-fail", {
      resolveSyncErrorDir: () => syncErrDir,
      writeSyncErrorLog: (dir, payload) => {
        const path = join(dir, "stamp.log");
        writeAtomicText(path, payload);
        return path;
      },
    });

    expect(outcome.kind).toBe("error");
    if (outcome.kind !== "error") return;
    expect(existsSync(syncErrDir)).toBe(true);
    const logs = readdirSync(syncErrDir).filter((n) => n.endsWith(".log"));
    expect(logs).toHaveLength(1);
    const logBody = readFileSync(join(syncErrDir, logs[0]!), "utf8");
    expect(logBody).toBe(outcome.message);
  });

  it("swallows a writeSyncErrorLog throw rather than rethrowing", () => {
    const reportDir = join(tmp, "reports");
    mkdirSync(reportDir, { recursive: true });
    const reportPath = join(reportDir, "x.json");
    mkdirSync(join(tmp, "hypotheses.json"), { recursive: true });

    expect(() =>
      runSyncAndLog(baseReport, reportPath, "session-double-fail", {
        resolveSyncErrorDir: () => join(tmp, "sync-errors"),
        writeSyncErrorLog: () => {
          throw new Error("disk full");
        },
      }),
    ).not.toThrow();
  });
});
