import { describe, expect, it } from "vitest";
import { createStore } from "@lannguyensi/hypothesis-tracker";
import {
  registerReportHypotheses,
  findHypothesesForReport,
  HYPOTHESIS_BRIDGE_PREFIX_RE,
} from "../src/index.js";
import type { UnderstandingReport } from "../src/schema/types.js";

const baseReport: UnderstandingReport = {
  taskId: "phase-1-5-task",
  mode: "fast_confirm",
  riskLevel: "medium",
  currentUnderstanding: "x",
  intendedOutcome: "y",
  derivedTodos: ["a"],
  acceptanceCriteria: ["b"],
  assumptions: [
    "session lives in cookie",
    "logout returns 200",
    "no SSR involved",
  ],
  openQuestions: [
    "where in the header?",
    "should it confirm before logout?",
  ],
  outOfScope: ["styling polish"],
  risks: ["redirect loop"],
  verificationPlan: ["click test"],
  requiresHumanApproval: true,
  approvalStatus: "pending",
  createdAt: "2026-04-30T11:30:00.000Z",
};

describe("registerReportHypotheses: happy path", () => {
  it("adds one hypothesis per assumption + open question (3 + 2 = 5 total)", () => {
    const store = createStore("session-1");
    const result = registerReportHypotheses(baseReport, store);
    expect(result.added).toHaveLength(5);
    expect(result.skipped).toHaveLength(0);
    expect(store.hypotheses).toHaveLength(5);
    expect(result.reportId).toBe("phase-1-5-task");
  });

  it("encodes kind + reportId in the hypothesis text via [ug:<id>:<kind>] prefix", () => {
    const store = createStore("session-2");
    registerReportHypotheses(baseReport, store);
    const assumptionTexts = store.hypotheses
      .map((h) => h.text)
      .filter((t) => t.includes(":assumption]"));
    const questionTexts = store.hypotheses
      .map((h) => h.text)
      .filter((t) => t.includes(":open_question]"));
    expect(assumptionTexts).toHaveLength(3);
    expect(questionTexts).toHaveLength(2);
    expect(assumptionTexts[0]).toMatch(
      /^\[ug:phase-1-5-task:assumption\] /,
    );
    expect(questionTexts[0]).toMatch(
      /^\[ug:phase-1-5-task:open_question\] /,
    );
  });

  it("preserves the original statement after the prefix", () => {
    const store = createStore();
    registerReportHypotheses(baseReport, store);
    expect(store.hypotheses[0].text).toContain("session lives in cookie");
    expect(store.hypotheses[3].text).toContain("where in the header?");
  });

  it("returns added entries with the tracker-assigned ids", () => {
    const store = createStore();
    const result = registerReportHypotheses(baseReport, store);
    for (const entry of result.added) {
      expect(typeof entry.id).toBe("string");
      expect(entry.id.length).toBeGreaterThan(0);
      const matching = store.hypotheses.find((h) => h.id === entry.id);
      expect(matching).toBeDefined();
    }
  });
});

describe("registerReportHypotheses: idempotency", () => {
  it("second call with same store + report yields zero adds, all skips", () => {
    const store = createStore();
    registerReportHypotheses(baseReport, store);
    const second = registerReportHypotheses(baseReport, store);
    expect(second.added).toHaveLength(0);
    expect(second.skipped).toHaveLength(5);
    expect(store.hypotheses).toHaveLength(5); // not duplicated
  });

  it("ignores entries with whitespace-only or empty text", () => {
    const noisy: UnderstandingReport = {
      ...baseReport,
      assumptions: ["valid one", "  ", "", "another valid"],
      openQuestions: [],
    };
    const store = createStore();
    const result = registerReportHypotheses(noisy, store);
    expect(result.added).toHaveLength(2);
    expect(store.hypotheses).toHaveLength(2);
  });

  it("idempotency is per-(reportId,kind,statement): different reports stack", () => {
    const reportA = { ...baseReport, taskId: "task-a" };
    const reportB = { ...baseReport, taskId: "task-b" };
    const store = createStore();
    registerReportHypotheses(reportA, store);
    registerReportHypotheses(reportB, store);
    expect(store.hypotheses).toHaveLength(10);
  });
});

describe("registerReportHypotheses: derived reportId fallback", () => {
  it("derives a stable id when taskId is empty", () => {
    const noTaskId: UnderstandingReport = { ...baseReport, taskId: "" };
    const a = registerReportHypotheses(noTaskId, createStore());
    const b = registerReportHypotheses(noTaskId, createStore());
    expect(a.reportId).toBe(b.reportId);
    expect(a.reportId).toMatch(/^derived-/);
  });

  it("derived id depends on report content, not on object identity", () => {
    const reportA: UnderstandingReport = {
      ...baseReport,
      taskId: "",
      assumptions: ["alpha"],
    };
    const reportB: UnderstandingReport = {
      ...baseReport,
      taskId: "",
      assumptions: ["beta"],
    };
    const a = registerReportHypotheses(reportA, createStore());
    const b = registerReportHypotheses(reportB, createStore());
    expect(a.reportId).not.toBe(b.reportId);
  });
});

describe("findHypothesesForReport", () => {
  it("returns only hypotheses tied to the given reportId", () => {
    const store = createStore();
    registerReportHypotheses({ ...baseReport, taskId: "alpha" }, store);
    registerReportHypotheses({ ...baseReport, taskId: "beta" }, store);
    const alphaOnly = findHypothesesForReport(store, "alpha");
    expect(alphaOnly).toHaveLength(5);
    for (const h of alphaOnly) {
      expect(h.text).toMatch(/\[ug:alpha:/);
    }
  });

  it("returns an empty array when the reportId is unknown", () => {
    const store = createStore();
    registerReportHypotheses(baseReport, store);
    expect(findHypothesesForReport(store, "no-such-id")).toEqual([]);
  });
});

describe("HYPOTHESIS_BRIDGE_PREFIX_RE", () => {
  it("captures reportId and kind from a well-formed text", () => {
    const m = HYPOTHESIS_BRIDGE_PREFIX_RE.exec(
      "[ug:my-task:assumption] something",
    );
    expect(m).not.toBeNull();
    expect(m![1]).toBe("my-task");
    expect(m![2]).toBe("assumption");
  });

  it("does not match a tracker hypothesis added outside the bridge", () => {
    expect(
      HYPOTHESIS_BRIDGE_PREFIX_RE.exec("just a regular hypothesis"),
    ).toBeNull();
  });
});
