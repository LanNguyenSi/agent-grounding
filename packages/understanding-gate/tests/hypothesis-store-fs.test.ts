import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isValidHypothesis,
  loadOrCreateStore,
  saveStore,
} from "../src/core/hypothesis-store-fs.js";
import { syncHypothesesFromReport } from "../src/core/hypothesis-sync.js";
import type { UnderstandingReport } from "../src/schema/types.js";

let tmp: string;
let storePath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ug-store-"));
  storePath = join(tmp, "hypotheses.json");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const validHypothesis = {
  id: "h-1",
  text: "the bug is in foo",
  status: "unverified",
  evidence: [],
  required_checks: [],
  createdAt: "2026-04-30T00:00:00.000Z",
  updatedAt: "2026-04-30T00:00:00.000Z",
};

describe("isValidHypothesis", () => {
  it("accepts a fully-formed hypothesis", () => {
    expect(isValidHypothesis(validHypothesis)).toBe(true);
  });

  it.each([
    ["missing id", { ...validHypothesis, id: undefined }],
    ["missing text", { ...validHypothesis, text: undefined }],
    ["bogus status", { ...validHypothesis, status: "garbage" }],
    ["evidence not an array", { ...validHypothesis, evidence: {} }],
    ["required_checks not an array", { ...validHypothesis, required_checks: 0 }],
    ["missing createdAt", { ...validHypothesis, createdAt: undefined }],
    ["null entry", null],
    ["string entry", "not an object"],
  ])("rejects %s", (_label, entry) => {
    expect(isValidHypothesis(entry)).toBe(false);
  });
});

describe("loadOrCreateStore", () => {
  it("returns droppedCount=0 + a fresh store when the file is absent", () => {
    const out = loadOrCreateStore(storePath, "sess-fresh");
    expect(out.droppedCount).toBe(0);
    expect(out.store).toEqual({ session: "sess-fresh", hypotheses: [] });
  });

  it("preserves valid entries and counts the corrupt ones", () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        session: "sess-mixed",
        hypotheses: [
          validHypothesis,
          { ...validHypothesis, id: "h-2" },
          { broken: "no id" },
          null,
          { ...validHypothesis, status: "made-up" },
        ],
      }),
      "utf8",
    );
    const out = loadOrCreateStore(storePath, "fallback");
    expect(out.droppedCount).toBe(3);
    expect(out.store.session).toBe("sess-mixed");
    expect(out.store.hypotheses.map((h) => h.id)).toEqual(["h-1", "h-2"]);
  });

  it("falls back to a fresh store for malformed top-level JSON", () => {
    writeFileSync(storePath, "{not json", "utf8");
    const out = loadOrCreateStore(storePath, "sess-corrupt");
    expect(out.droppedCount).toBe(0);
    expect(out.store).toEqual({ session: "sess-corrupt", hypotheses: [] });
  });

  it("falls back when top-level shape is wrong", () => {
    writeFileSync(storePath, JSON.stringify({ hypotheses: "no" }), "utf8");
    const out = loadOrCreateStore(storePath, "sess-shape");
    expect(out.droppedCount).toBe(0);
    expect(out.store.hypotheses).toEqual([]);
  });
});

describe("saveStore", () => {
  it("round-trips through loadOrCreateStore", () => {
    saveStore(storePath, {
      session: "rt",
      hypotheses: [validHypothesis as never],
    });
    const back = loadOrCreateStore(storePath);
    expect(back.droppedCount).toBe(0);
    expect(back.store.hypotheses).toHaveLength(1);
    expect(back.store.hypotheses[0]?.id).toBe("h-1");
  });
});

describe("syncHypothesesFromReport reacts to dropped entries", () => {
  it("rewrites the store when corrupt entries are dropped, even with no new additions", () => {
    // Pre-seed the store with one valid + one corrupt entry. The report
    // re-emits the same assumption so result.added is empty, but the
    // sync should still rewrite to drop the corrupt row.
    const sameId = "h-existing";
    writeFileSync(
      storePath,
      JSON.stringify({
        session: "sess-drop",
        hypotheses: [
          { ...validHypothesis, id: sameId, text: "existing assumption" },
          { broken: "drop me" },
        ],
      }),
      "utf8",
    );

    const report: UnderstandingReport = {
      taskId: "t",
      mode: "fast_confirm",
      riskLevel: "low",
      currentUnderstanding: "u",
      intendedOutcome: "o",
      derivedTodos: ["a"],
      acceptanceCriteria: ["b"],
      assumptions: ["fresh assumption"],
      openQuestions: [],
      outOfScope: [],
      risks: [],
      verificationPlan: ["p"],
      requiresHumanApproval: false,
      approvalStatus: "approved",
      createdAt: "2026-04-30T00:00:00.000Z",
    };

    const out = syncHypothesesFromReport(report, {
      reportDir: join(tmp, "reports"),
      sessionId: "sess-drop",
    });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.droppedFromStore).toBe(1);

    const after = JSON.parse(readFileSync(storePath, "utf8"));
    expect(after.hypotheses.find((h: { broken?: string }) => h.broken)).toBeUndefined();
    expect(after.hypotheses).toHaveLength(2);
  });
});
