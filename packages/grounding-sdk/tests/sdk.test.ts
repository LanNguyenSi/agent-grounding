import { describe, expect, it } from "vitest";
import {
  createStore,
  deriveContextFromSession,
  track,
  validate,
  verify,
  type GroundingSession,
  type Hypothesis,
  type LedgerSummary,
} from "../src/index.js";
import { initSession, advancePhase } from "grounding-wrapper";

function mkSession(): GroundingSession {
  return initSession({ keyword: "crash", problem: "server throws 500 on /health" });
}

function driveToDone(session: GroundingSession): GroundingSession {
  let current = session;
  // Walk the phase machine until no active phase remains. `advancePhase`
  // marks the current phase done and arms the next one; stop when no
  // phase is active any more.
  for (let guard = 0; guard < 20; guard++) {
    const status = current.phase_status;
    const anyActive = Object.values(status).some((s) => s === "active");
    if (!anyActive) break;
    current = advancePhase(current);
  }
  return current;
}

function mkLedgerSummary(
  facts: number,
  rejected: number,
  session = "s1",
): LedgerSummary {
  const nowIso = new Date().toISOString();
  const mk = (n: number, type: "fact" | "rejected") =>
    Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      type,
      content: `${type}-${i}`,
      source: null,
      confidence: "medium" as const,
      session,
      createdAt: nowIso,
      updatedAt: nowIso,
    }));
  return {
    session,
    facts: mk(facts, "fact"),
    hypotheses: [],
    rejected: mk(rejected, "rejected"),
    unknowns: [],
  };
}

describe("verify", () => {
  it("rejects a strong root-cause claim with no evidence", () => {
    const result = verify("the cache is the root cause", {}, "root_cause");
    expect(result.allowed).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("accepts a claim when the required prereqs are flagged", () => {
    const result = verify(
      "the cache is the root cause",
      {
        readmeRead: true,
        processChecked: true,
        configChecked: true,
        healthChecked: true,
        hasEvidence: true,
        alternativesConsidered: true,
      },
      "root_cause",
    );
    expect(result.allowed).toBe(true);
    expect(result.score).toBeGreaterThan(0);
  });

  it("defaults evidence to {} when omitted — strong claim rejected", () => {
    // With no evidence flags set, even the fall-through 'generic' policy
    // (which only requires `has_evidence`) should deny a hard claim.
    const result = verify("any strong claim");
    expect(result.allowed).toBe(false);
    expect(result.score).toBeLessThan(100);
  });
});

describe("track", () => {
  it("registers a hypothesis with auto-generated id + timestamps", () => {
    const store = createStore("t1");
    const h: Hypothesis = track(store, "migration is incomplete");
    expect(h.id).toBeTruthy();
    expect(h.text).toBe("migration is incomplete");
    expect(h.status).toBe("unverified");
    expect(h.required_checks).toEqual([]);
    expect(store.hypotheses).toHaveLength(1);
  });

  it("accepts a TrackInput object with required checks", () => {
    const store = createStore("t2");
    const h = track(store, {
      text: "DB is slow",
      requiredChecks: ["check pg_stat_activity", "check slow query log"],
    });
    expect(h.required_checks).toHaveLength(2);
    expect(h.required_checks[0].done).toBe(false);
  });

  it("keeps multiple hypotheses in the same store", () => {
    const store = createStore("t3");
    track(store, "h1");
    track(store, "h2");
    track(store, "h3");
    expect(store.hypotheses).toHaveLength(3);
    const ids = store.hypotheses.map((h) => h.id);
    expect(new Set(ids).size).toBe(3);
  });
});

describe("validate", () => {
  it("falls back to phase-only context when no ledgerSummary is passed", () => {
    const session = mkSession();
    const result = validate({ session, claim: "fixed it" });
    expect(result).toHaveProperty("derivedContext");
    expect(result.derivedContext.has_evidence).toBe(false);
    expect(result.derivedContext.alternatives_considered).toBe(false);
  });

  it("surfaces ledger signals in the derived context", () => {
    const session = mkSession();
    const summary = mkLedgerSummary(3, 2);
    const result = validate({
      session,
      claim: "fixed it",
      ledgerSummary: summary,
    });
    expect(result.derivedContext.has_evidence).toBe(true);
    expect(result.derivedContext.alternatives_considered).toBe(true);
  });

  it("flips allowed: true once the session has advanced and ledger is populated", () => {
    const session = driveToDone(mkSession());
    const summary = mkLedgerSummary(5, 2);
    const result = validate({
      session,
      claim: "cache invalidation is the root cause",
      type: "root_cause",
      ledgerSummary: summary,
    });
    expect(result.derivedContext.readme_read).toBe(true);
    expect(result.derivedContext.process_checked).toBe(true);
    expect(result.allowed).toBe(true);
  });
});

describe("deriveContextFromSession", () => {
  it("treats skipped phases as satisfied (avoids deadlock)", () => {
    const session = mkSession();
    // Force doc-reading to skipped.
    (session.phase_status as Record<string, string>)["doc-reading"] = "skipped";
    const ctx = deriveContextFromSession(session);
    expect(ctx.readme_read).toBe(true);
  });

  it("treats pending/active phases as not-satisfied", () => {
    const session = mkSession();
    const ctx = deriveContextFromSession(session);
    // Fresh session: doc-reading is active, runtime-inspection pending.
    expect(ctx.readme_read).toBe(false);
    expect(ctx.process_checked).toBe(false);
  });
});

describe("end-to-end: track → verify → validate", () => {
  it("supports the documented workflow", () => {
    // 1. Track a hypothesis.
    const store = createStore("e2e-session");
    const h = track(store, {
      text: "the retry loop is masking a 503 from upstream",
      requiredChecks: ["grep the access log", "inspect retry policy"],
    });
    expect(h.status).toBe("unverified");

    // 2. Verify a derivative claim with explicit evidence flags.
    const verifyResult = verify(
      "the 503 is from upstream, not local",
      {
        readmeRead: true,
        processChecked: true,
        configChecked: true,
        healthChecked: true,
        hasEvidence: true,
        alternativesConsidered: true,
      },
      "root_cause",
    );
    expect(verifyResult.allowed).toBe(true);

    // 3. Validate against a completed session + ledger.
    const session = driveToDone(mkSession());
    const summary = mkLedgerSummary(4, 1);
    const validateResult = validate({
      session,
      claim: "ship the fix — upstream 503 confirmed",
      type: "root_cause",
      ledgerSummary: summary,
    });
    expect(validateResult.allowed).toBe(true);
    expect(validateResult.derivedContext.has_evidence).toBe(true);
  });
});
