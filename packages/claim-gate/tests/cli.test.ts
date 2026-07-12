/**
 * CLI entrypoint tests for claim-gate.
 *
 * Strategy: mock evaluateClaim and POLICIES so no real policy logic runs.
 * Tests verify that each boolean flag maps to the correct ClaimContext field,
 * that --json vs human output branches work, and that process.exit(1) is
 * called when a claim is blocked.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── module mocks ─────────────────────────────────────────────────────────────
// IMPORTANT: vi.mock factories are hoisted — do NOT reference top-level
// let/const variables inside. Use vi.fn() inline; configure via vi.mocked()
// in beforeEach instead.

vi.mock("../src/lib.js", () => ({
  evaluateClaim: vi.fn(),
  detectClaimType: vi.fn(() => "generic"),
  POLICIES: [
    {
      type: "root_cause",
      description: "Root cause claim",
      requires: ["readme_read", "has_evidence"],
    },
  ],
}));

// ── import after mocks ────────────────────────────────────────────────────────

import { buildProgram } from "../src/cli.js";
import * as libMod from "../src/lib.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function parse(args: string[]): void {
  buildProgram().parse(["node", "claim-gate", ...args]);
}

const ALLOWED_RESULT = {
  claim: "process is down",
  type: "process" as const,
  allowed: true,
  reasons: [] as string[],
  next_steps: [] as string[],
  score: 100,
};

const BLOCKED_RESULT = {
  claim: "root cause is DB",
  type: "root_cause" as const,
  allowed: false,
  reasons: ["README not read"],
  next_steps: ["Read README.md"],
  score: 0,
};

// ── setup / teardown ─────────────────────────────────────────────────────────

let logSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(libMod.evaluateClaim).mockReturnValue(ALLOWED_RESULT);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  // Throw a sentinel so execution stops (matching real process.exit behavior)
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`EXIT:${code ?? ""}`);
  }) as typeof process.exit);
});

afterEach(() => {
  logSpy.mockRestore();
  exitSpy.mockRestore();
});

// ── check command: flag → context mapping ────────────────────────────────────

describe("check command — flag to context mapping", () => {
  it("no flags → all context fields are undefined", () => {
    parse(["check", "process is down"]);
    expect(libMod.evaluateClaim).toHaveBeenCalledWith(
      "process is down",
      {
        readme_read: undefined,
        process_checked: undefined,
        config_checked: undefined,
        health_checked: undefined,
        has_evidence: undefined,
        alternatives_considered: undefined,
      },
      undefined,
    );
  });

  it("--readme sets readme_read=true", () => {
    parse(["check", "some claim", "--readme"]);
    expect(libMod.evaluateClaim).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ readme_read: true }),
      undefined,
    );
  });

  it("--process sets process_checked=true", () => {
    parse(["check", "some claim", "--process"]);
    expect(libMod.evaluateClaim).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ process_checked: true }),
      undefined,
    );
  });

  it("--config sets config_checked=true", () => {
    parse(["check", "some claim", "--config"]);
    expect(libMod.evaluateClaim).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ config_checked: true }),
      undefined,
    );
  });

  it("--health sets health_checked=true", () => {
    parse(["check", "some claim", "--health"]);
    expect(libMod.evaluateClaim).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ health_checked: true }),
      undefined,
    );
  });

  it("--evidence sets has_evidence=true", () => {
    parse(["check", "some claim", "--evidence"]);
    expect(libMod.evaluateClaim).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ has_evidence: true }),
      undefined,
    );
  });

  it("--alternatives sets alternatives_considered=true", () => {
    parse(["check", "some claim", "--alternatives"]);
    expect(libMod.evaluateClaim).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ alternatives_considered: true }),
      undefined,
    );
  });

  it("--type passes type override as third argument", () => {
    parse(["check", "some claim", "--type", "network"]);
    expect(libMod.evaluateClaim).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "network",
    );
  });

  it("multiple flags are all forwarded correctly", () => {
    parse(["check", "claim", "--readme", "--evidence", "--alternatives"]);
    expect(libMod.evaluateClaim).toHaveBeenCalledWith(
      "claim",
      expect.objectContaining({
        readme_read: true,
        has_evidence: true,
        alternatives_considered: true,
        process_checked: undefined,
        config_checked: undefined,
        health_checked: undefined,
      }),
      undefined,
    );
  });
});

// ── check command: output branches ───────────────────────────────────────────

describe("check command — output", () => {
  it("outputs JSON when --json and claim is allowed", () => {
    parse(["check", "some claim", "--json"]);
    const output = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.allowed).toBe(true);
    expect(parsed.claim).toBe("process is down");
    // No process.exit called when allowed
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("outputs JSON when --json and claim is blocked — returns early, no exit", () => {
    vi.mocked(libMod.evaluateClaim).mockReturnValueOnce(BLOCKED_RESULT);
    parse(["check", "root cause is DB", "--json"]);
    const output = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output);
    expect(parsed.allowed).toBe(false);
    // --json path returns early before process.exit
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("calls process.exit(1) when claim is blocked (human output)", () => {
    vi.mocked(libMod.evaluateClaim).mockReturnValueOnce(BLOCKED_RESULT);
    expect(() => parse(["check", "root cause is DB"])).toThrow("EXIT:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does NOT call process.exit when claim is allowed (human output)", () => {
    parse(["check", "process is down"]);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("human output includes ALLOWED status text when allowed", () => {
    parse(["check", "process is down"]);
    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allLogs).toContain("ALLOWED");
  });

  it("human output includes BLOCKED status text when blocked", () => {
    vi.mocked(libMod.evaluateClaim).mockReturnValueOnce(BLOCKED_RESULT);
    expect(() => parse(["check", "root cause is DB"])).toThrow("EXIT:1");
    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allLogs).toContain("BLOCKED");
  });
});

// ── --version ────────────────────────────────────────────────────────────────
// Regression test for a version desync: the CLI used to hardcode a version
// string separate from package.json, so a release bump could silently leave
// `claim-gate --version` printing a stale number. The version must be
// derived from package.json, not duplicated.

describe("--version", () => {
  it("reports the version from package.json", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(buildProgram().version()).toBe(pkg.version);
  });
});

// ── policies command ─────────────────────────────────────────────────────────

describe("policies command", () => {
  it("prints policy types from POLICIES", () => {
    parse(["policies"]);
    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allLogs).toContain("root_cause");
  });

  it("prints policy description", () => {
    parse(["policies"]);
    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allLogs).toContain("Root cause claim");
  });
});
