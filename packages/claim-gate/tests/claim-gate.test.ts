import { describe, expect, it } from "vitest";
import { detectClaimType, evaluateClaim, isAllowed } from "../src/lib.js";

describe("detectClaimType", () => {
  it("detects architecture claims", () => {
    expect(detectClaimType("Das ist ein Architekturproblem")).toBe("architecture");
    expect(detectClaimType("this is an architecture flaw")).toBe("architecture");
  });

  it("detects root cause claims", () => {
    expect(detectClaimType("root cause is the database")).toBe("root_cause");
    expect(detectClaimType("das ist die eigentliche Ursache")).toBe("root_cause");
  });

  it("detects security claims", () => {
    expect(detectClaimType("CVE in the library")).toBe("security");
    expect(detectClaimType("authentication issue")).toBe("security");
  });

  it("detects network claims", () => {
    expect(detectClaimType("firewall is blocking port 443")).toBe("network");
    expect(detectClaimType("DNS resolution failing")).toBe("network");
  });

  it("detects configuration claims", () => {
    expect(detectClaimType("wrong config value")).toBe("configuration");
    expect(detectClaimType("environment variable missing")).toBe("configuration");
  });

  it("detects process claims", () => {
    expect(detectClaimType("process is not running")).toBe("process");
    expect(detectClaimType("service stopped unexpectedly")).toBe("process");
  });

  it("detects availability claims", () => {
    expect(detectClaimType("service is offline")).toBe("availability");
    expect(detectClaimType("endpoint unreachable")).toBe("availability");
  });

  it("detects token claims", () => {
    expect(detectClaimType("API key is wrong")).toBe("token");
    expect(detectClaimType("token expired")).toBe("token");
  });

  it("falls back to generic for unknown claims", () => {
    expect(detectClaimType("something is broken")).toBe("generic");
    expect(detectClaimType("I have no idea")).toBe("generic");
  });
});

describe("evaluateClaim", () => {
  it("blocks architecture claim with no context", () => {
    const result = evaluateClaim("Das ist ein Architekturproblem", {});
    expect(result.allowed).toBe(false);
    expect(result.type).toBe("architecture");
    expect(result.score).toBe(0);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.next_steps.length).toBeGreaterThan(0);
  });

  it("allows architecture claim when all prerequisites met", () => {
    const result = evaluateClaim("Das ist ein Architekturproblem", {
      readme_read: true,
      process_checked: true,
      config_checked: true,
      alternatives_considered: true,
    });
    expect(result.allowed).toBe(true);
    expect(result.score).toBe(100);
    expect(result.reasons).toHaveLength(0);
  });

  it("partially satisfied context gives partial score", () => {
    const result = evaluateClaim("architecture issue", {
      readme_read: true,
      process_checked: true,
      // config_checked and alternatives_considered missing
    });
    expect(result.allowed).toBe(false);
    expect(result.score).toBe(50); // 2 of 4 satisfied
  });

  it("blocks root_cause without evidence", () => {
    const result = evaluateClaim("root cause is the config", {
      readme_read: true,
      process_checked: true,
      config_checked: true,
      alternatives_considered: true,
      // has_evidence missing
    });
    expect(result.allowed).toBe(false);
  });

  it("allows root_cause with all prerequisites", () => {
    const result = evaluateClaim("root cause is the config", {
      readme_read: true,
      process_checked: true,
      config_checked: true,
      alternatives_considered: true,
      has_evidence: true,
    });
    expect(result.allowed).toBe(true);
  });

  it("allows process claim after process check only", () => {
    const result = evaluateClaim("process is not running", { process_checked: true });
    expect(result.allowed).toBe(true);
    expect(result.type).toBe("process");
  });

  it("blocks process claim without process check", () => {
    const result = evaluateClaim("process is not running", {});
    expect(result.allowed).toBe(false);
    expect(result.type).toBe("process");
  });

  it("allows network claim after health + process check", () => {
    const result = evaluateClaim("firewall blocking port 443", {
      health_checked: true,
      process_checked: true,
    });
    expect(result.allowed).toBe(true);
  });

  it("respects explicit type override", () => {
    const result = evaluateClaim("something odd", { process_checked: true }, "network");
    // network requires health_checked too
    expect(result.allowed).toBe(false);
    expect(result.type).toBe("network");
  });

  it("generic claim blocked without evidence", () => {
    const result = evaluateClaim("something is broken", {});
    expect(result.allowed).toBe(false);
    expect(result.type).toBe("generic");
  });

  it("generic claim allowed with evidence", () => {
    const result = evaluateClaim("something is broken", { has_evidence: true });
    expect(result.allowed).toBe(true);
  });
});

describe("isAllowed", () => {
  it("returns true when claim is allowed", () => {
    expect(isAllowed("process stopped", { process_checked: true })).toBe(true);
  });

  it("returns false when claim is blocked", () => {
    expect(isAllowed("architecture failure", {})).toBe(false);
  });
});
