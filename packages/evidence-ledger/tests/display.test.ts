import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { printSummary } from "../src/display.js";
import type { LedgerEntry } from "../src/types.js";

function entry(
  overrides: Partial<LedgerEntry> & { id: number; type: LedgerEntry["type"]; content: string },
): LedgerEntry {
  return {
    source: null,
    confidence: "medium",
    session: "default",
    createdAt: "2026-04-05T10:00:00.000Z",
    updatedAt: "2026-04-05T10:00:00.000Z",
    ...overrides,
  };
}

const emptyBuckets = { facts: [], hypotheses: [], rejected: [], unknowns: [], policyDecisions: [] };

describe("printSummary — policy_decision bucket", () => {
  let logs: string[];
  let spy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logs = [];
    spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "));
    });
  });
  afterEach(() => {
    spy.mockRestore();
  });

  it("renders a POLICY DECISIONS section and counts it in the total", () => {
    printSummary(
      {
        ...emptyBuckets,
        facts: [entry({ id: 1, type: "fact", content: "service is up" })],
        policyDecisions: [
          entry({ id: 2, type: "policy_decision", content: "blocked rm -rf without approval" }),
        ],
      },
      "sess",
    );
    const out = logs.join("\n");
    expect(out).toContain("POLICY DECISIONS (1)");
    expect(out).toContain("blocked rm -rf without approval");
    // total counts the 5th bucket: 1 fact + 1 policy decision.
    expect(out).toContain("2 entries total");
  });

  it("omits the POLICY DECISIONS section when there are none", () => {
    printSummary(
      { ...emptyBuckets, facts: [entry({ id: 1, type: "fact", content: "f" })] },
      "sess",
    );
    expect(logs.join("\n")).not.toContain("POLICY DECISIONS");
  });
});
