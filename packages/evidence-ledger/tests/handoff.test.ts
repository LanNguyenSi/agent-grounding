import { describe, expect, it } from "vitest";
import { buildHandoffMarkdown, buildHandoffJson } from "../src/handoff.js";
import type { LedgerEntry } from "../src/types.js";

function entry(overrides: Partial<LedgerEntry> & { id: number; type: LedgerEntry["type"]; content: string }): LedgerEntry {
  return {
    source: null,
    confidence: "medium",
    session: "default",
    createdAt: "2026-04-05T10:00:00.000Z",
    updatedAt: "2026-04-05T10:00:00.000Z",
    ...overrides,
  };
}

const sampleSummary = {
  facts: [
    entry({ id: 1, type: "fact", content: "Service is down", source: "logs", confidence: "high" }),
  ],
  hypotheses: [
    entry({ id: 2, type: "hypothesis", content: "OOM killer triggered" }),
  ],
  rejected: [
    entry({ id: 3, type: "rejected", content: "DNS issue", source: "disproven by traceroute" }),
  ],
  unknowns: [
    entry({ id: 4, type: "unknown", content: "When did the last deploy happen?" }),
  ],
};

const emptySummary = { facts: [], hypotheses: [], rejected: [], unknowns: [] };

describe("buildHandoffMarkdown", () => {
  it("includes all sections", () => {
    const md = buildHandoffMarkdown("debug-session", sampleSummary);
    expect(md).toContain("# Handoff — Session: debug-session");
    expect(md).toContain("## Confirmed Facts");
    expect(md).toContain("**Service is down**");
    expect(md).toContain("## Open Hypotheses");
    expect(md).toContain("OOM killer triggered");
    expect(md).toContain("## Rejected Hypotheses");
    expect(md).toContain("~~DNS issue~~");
    expect(md).toContain("## Open Questions");
    expect(md).toContain("When did the last deploy happen?");
    expect(md).toContain("## Next Steps");
  });

  it("includes status counts", () => {
    const md = buildHandoffMarkdown("test", sampleSummary);
    expect(md).toContain("1 confirmed facts");
    expect(md).toContain("1 open hypotheses");
    expect(md).toContain("1 rejected hypotheses");
    expect(md).toContain("1 open questions");
  });

  it("handles empty summary", () => {
    const md = buildHandoffMarkdown("empty", emptySummary);
    expect(md).toContain("_None yet._");
    expect(md).toContain("All resolved — ready to close");
  });

  it("includes sources and confidence", () => {
    const md = buildHandoffMarkdown("test", sampleSummary);
    expect(md).toContain("confidence: high");
    expect(md).toContain("source: logs");
  });
});

describe("buildHandoffJson", () => {
  it("returns structured object with all fields", () => {
    const json = buildHandoffJson("debug-session", sampleSummary);
    expect(json.session).toBe("debug-session");
    expect(json.generatedAt).toBeTruthy();
    expect(json.status.factsCount).toBe(1);
    expect(json.status.hypothesesCount).toBe(1);
    expect(json.status.rejectedCount).toBe(1);
    expect(json.status.unknownsCount).toBe(1);
    expect(json.facts).toHaveLength(1);
    expect(json.facts[0].content).toBe("Service is down");
    expect(json.openHypotheses).toHaveLength(1);
    expect(json.rejectedHypotheses).toHaveLength(1);
    expect(json.openQuestions).toHaveLength(1);
  });

  it("includes next steps", () => {
    const json = buildHandoffJson("test", sampleSummary);
    expect(json.nextSteps).toContain("Investigate open questions");
    expect(json.nextSteps).toContain("Validate or reject remaining hypotheses");
  });

  it("handles empty summary", () => {
    const json = buildHandoffJson("empty", emptySummary);
    expect(json.status.factsCount).toBe(0);
    expect(json.nextSteps).toContain("All resolved — ready to close");
  });

  it("preserves entry IDs", () => {
    const json = buildHandoffJson("test", sampleSummary);
    expect(json.facts[0].id).toBe(1);
    expect(json.openHypotheses[0].id).toBe(2);
  });
});
