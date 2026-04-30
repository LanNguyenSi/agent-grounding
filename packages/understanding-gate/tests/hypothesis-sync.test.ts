import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncHypothesesFromReport } from "../src/core/hypothesis-sync.js";
import { HYPOTHESES_STORE_FILENAME } from "../src/core/hypothesis-store-fs.js";
import type { UnderstandingReport } from "../src/schema/types.js";

const baseReport: UnderstandingReport = {
  taskId: "sync-task",
  mode: "fast_confirm",
  riskLevel: "low",
  currentUnderstanding: "x",
  intendedOutcome: "y",
  derivedTodos: ["a"],
  acceptanceCriteria: ["b"],
  assumptions: ["sync-assumption-1"],
  openQuestions: ["sync-question-1"],
  outOfScope: ["e"],
  risks: ["f"],
  verificationPlan: ["g"],
  requiresHumanApproval: true,
  approvalStatus: "pending",
  createdAt: "2026-04-30T12:00:00.000Z",
};

let tmp: string;
let reportDir: string;
let storePath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ug-sync-"));
  reportDir = join(tmp, "reports");
  mkdirSync(reportDir, { recursive: true });
  storePath = join(tmp, HYPOTHESES_STORE_FILENAME);
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("syncHypothesesFromReport", () => {
  it("creates the store file when none exists and writes hypotheses", () => {
    const out = syncHypothesesFromReport(baseReport, {
      reportDir,
      sessionId: "sess-1",
    });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.storePath).toBe(storePath);
    expect(existsSync(storePath)).toBe(true);
    const written = JSON.parse(readFileSync(storePath, "utf8"));
    expect(written.session).toBe("sess-1");
    expect(written.hypotheses).toHaveLength(2);
    expect(out.result.added).toHaveLength(2);
  });

  it("re-running against the existing store yields no new writes", () => {
    syncHypothesesFromReport(baseReport, { reportDir, sessionId: "sess-1" });
    const before = readFileSync(storePath, "utf8");
    const out2 = syncHypothesesFromReport(baseReport, {
      reportDir,
      sessionId: "sess-1",
    });
    expect(out2.kind).toBe("ok");
    if (out2.kind !== "ok") return;
    expect(out2.result.added).toHaveLength(0);
    expect(out2.result.skipped).toHaveLength(2);
    expect(readFileSync(storePath, "utf8")).toBe(before);
  });

  it("survives a corrupt existing store file by starting fresh", () => {
    writeFileSync(storePath, "{not json", "utf8");
    const out = syncHypothesesFromReport(baseReport, {
      reportDir,
      sessionId: "sess-x",
    });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.result.added).toHaveLength(2);
    const written = JSON.parse(readFileSync(storePath, "utf8"));
    expect(written.hypotheses).toHaveLength(2);
  });

  it("returns kind=error when reportDir cannot be written to", () => {
    // Make the parent path point to a regular file so mkdir/write
    // would fail. The wrapper catches and reports.
    const blocked = join(tmp, "blocked-file");
    writeFileSync(blocked, "i am not a dir", "utf8");
    const out = syncHypothesesFromReport(baseReport, {
      reportDir: join(blocked, "reports"),
      sessionId: "s",
    });
    expect(out.kind).toBe("error");
  });
});
