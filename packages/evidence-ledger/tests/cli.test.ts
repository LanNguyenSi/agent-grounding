/**
 * CLI entrypoint tests for evidence-ledger.
 *
 * Strategy: mock all db/display/handoff lib functions so no real DB is touched.
 * Each test calls buildProgram().parse() with a synthetic argv, then asserts
 * the mocked lib function was called with the expected arguments and defaults.
 *
 * process.exit is mocked globally so destructive commands (clear, prune, reject)
 * don't abort the test process.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── module mocks (hoisted) ───────────────────────────────────────────────────

vi.mock("../src/db.js", () => ({
  getDb: vi.fn(() => ({})),
  addEntry: vi.fn(() => ({
    id: 1,
    type: "fact",
    content: "test",
    source: null,
    confidence: "high",
    session: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  })),
  rejectHypothesis: vi.fn(() => ({
    id: 2,
    type: "rejected",
    content: "some hyp",
    source: null,
    confidence: "medium",
    session: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  })),
  listEntries: vi.fn(() => []),
  getSummary: vi.fn(() => ({
    facts: [],
    hypotheses: [],
    rejected: [],
    unknowns: [],
    policyDecisions: [],
  })),
  clearSession: vi.fn(() => 3),
  listSessions: vi.fn(() => ["default", "other"]),
  parseDuration: vi.fn(() => 86_400_000),
  pruneEntries: vi.fn(() => ({
    dryRun: false,
    cutoff: "2026-01-01T00:00:00.000Z",
    scanned: 10,
    deleted: 3,
  })),
}));

vi.mock("../src/display.js", () => ({
  printSummary: vi.fn(),
  printEntry: vi.fn(),
  formatEntry: vi.fn(() => "formatted-entry"),
}));

vi.mock("../src/handoff.js", () => ({
  buildHandoffMarkdown: vi.fn(() => "# Handoff\n"),
  buildHandoffJson: vi.fn(() => ({ session: "default", generatedAt: "2026-01-01T00:00:00.000Z" })),
}));

// ── import after mocks are declared (vitest hoists vi.mock) ─────────────────

import { buildProgram } from "../src/cli.js";
import * as dbMod from "../src/db.js";
import * as displayMod from "../src/display.js";
import * as handoffMod from "../src/handoff.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function parse(args: string[]): void {
  buildProgram().parse(["node", "ledger", ...args]);
}

// ── setup / teardown ─────────────────────────────────────────────────────────

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  // Throw a sentinel error so execution stops (matching real process.exit behavior)
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`EXIT:${code ?? ""}`);
  }) as typeof process.exit);
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  exitSpy.mockRestore();
});

// ── fact ─────────────────────────────────────────────────────────────────────

describe("fact command", () => {
  it("calls addEntry with type=fact, default confidence=high, default session=default", () => {
    parse(["fact", "service is up"]);
    expect(dbMod.addEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "fact",
        content: "service is up",
        confidence: "high",
        session: "default",
      }),
    );
  });

  it("passes --confidence and --session overrides", () => {
    parse(["fact", "service is up", "--confidence", "low", "--session", "my-session"]);
    expect(dbMod.addEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        confidence: "low",
        session: "my-session",
      }),
    );
  });

  it("passes --source to addEntry", () => {
    parse(["fact", "port open", "--source", "netstat"]);
    expect(dbMod.addEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ source: "netstat" }),
    );
  });

  it("calls printEntry with the returned entry", () => {
    parse(["fact", "x"]);
    expect(displayMod.printEntry).toHaveBeenCalledTimes(1);
  });
});

// ── hypothesis ───────────────────────────────────────────────────────────────

describe("hypothesis command", () => {
  it("calls addEntry with type=hypothesis, default confidence=medium", () => {
    parse(["hypothesis", "maybe DNS"]);
    expect(dbMod.addEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: "hypothesis",
        content: "maybe DNS",
        confidence: "medium",
        session: "default",
      }),
    );
  });

  it("accepts alias 'hyp'", () => {
    parse(["hyp", "could be firewall"]);
    expect(dbMod.addEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "hypothesis" }),
    );
  });
});

// ── reject (destructive) ─────────────────────────────────────────────────────

describe("reject command", () => {
  it("calls rejectHypothesis with numeric id", () => {
    parse(["reject", "42"]);
    expect(dbMod.rejectHypothesis).toHaveBeenCalledWith(expect.anything(), 42, undefined);
  });

  it("passes --reason to rejectHypothesis", () => {
    parse(["reject", "5", "--reason", "proved false"]);
    expect(dbMod.rejectHypothesis).toHaveBeenCalledWith(expect.anything(), 5, "proved false");
  });

  it("calls process.exit(1) when entry not found", () => {
    vi.mocked(dbMod.rejectHypothesis).mockReturnValueOnce(null as never);
    expect(() => parse(["reject", "999"])).toThrow("EXIT:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("calls printEntry when entry is found", () => {
    parse(["reject", "2"]);
    expect(displayMod.printEntry).toHaveBeenCalledTimes(1);
  });
});

// ── clear (destructive) ──────────────────────────────────────────────────────

describe("clear command", () => {
  it("calls clearSession with default session", () => {
    parse(["clear"]);
    expect(dbMod.clearSession).toHaveBeenCalledWith(expect.anything(), "default");
  });

  it("uses --session override", () => {
    parse(["clear", "--session", "staging"]);
    expect(dbMod.clearSession).toHaveBeenCalledWith(expect.anything(), "staging");
  });

  it("logs the count of cleared entries", () => {
    vi.mocked(dbMod.clearSession).mockReturnValueOnce(7);
    parse(["clear", "--session", "test"]);
    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allLogs).toContain("7");
    expect(allLogs).toContain("test");
  });
});

// ── prune (destructive) ──────────────────────────────────────────────────────

describe("prune command", () => {
  it("calls parseDuration with the --older-than value", () => {
    parse(["prune", "--older-than", "30d"]);
    expect(dbMod.parseDuration).toHaveBeenCalledWith("30d");
  });

  it("calls pruneEntries with olderThanMs from parseDuration", () => {
    vi.mocked(dbMod.parseDuration).mockReturnValueOnce(259_200_000); // 3d
    parse(["prune", "--older-than", "3d"]);
    expect(dbMod.pruneEntries).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ olderThanMs: 259_200_000 }),
    );
  });

  it("passes dryRun=true when --dry-run flag set", () => {
    parse(["prune", "--older-than", "1d", "--dry-run"]);
    expect(dbMod.pruneEntries).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dryRun: true }),
    );
  });

  it("outputs JSON when --json flag set", () => {
    parse(["prune", "--older-than", "1d", "--json"]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"deleted"'));
  });

  it("outputs human text without --json", () => {
    parse(["prune", "--older-than", "1d"]);
    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allLogs).toContain("scanned");
  });

  it("calls process.exit(1) when parseDuration throws", () => {
    vi.mocked(dbMod.parseDuration).mockImplementationOnce(() => {
      throw new Error("invalid duration");
    });
    expect(() => parse(["prune", "--older-than", "bad"])).toThrow("EXIT:1");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(dbMod.pruneEntries).not.toHaveBeenCalled();
  });

  it("outputs JSON error when parseDuration throws with --json flag", () => {
    vi.mocked(dbMod.parseDuration).mockImplementationOnce(() => {
      throw new Error("bad duration");
    });
    expect(() => parse(["prune", "--older-than", "bad", "--json"])).toThrow("EXIT:1");
    const logged = logSpy.mock.calls[0]?.[0] as string;
    expect(JSON.parse(logged)).toEqual({ error: "bad duration" });
  });
});

// ── show ─────────────────────────────────────────────────────────────────────

describe("show command", () => {
  it("calls getSummary with default session and then printSummary", () => {
    parse(["show"]);
    expect(dbMod.getSummary).toHaveBeenCalledWith(expect.anything(), "default");
    expect(displayMod.printSummary).toHaveBeenCalledTimes(1);
  });

  it("passes --session override", () => {
    parse(["show", "--session", "prod"]);
    expect(dbMod.getSummary).toHaveBeenCalledWith(expect.anything(), "prod");
  });
});

// ── list ─────────────────────────────────────────────────────────────────────

describe("list command", () => {
  it("calls listEntries with default session", () => {
    parse(["list"]);
    expect(dbMod.listEntries).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ session: "default" }),
    );
  });

  it("passes --type filter", () => {
    parse(["list", "--type", "fact"]);
    expect(dbMod.listEntries).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ type: "fact" }),
    );
  });

  it("prints 'No entries found' when list is empty", () => {
    vi.mocked(dbMod.listEntries).mockReturnValueOnce([]);
    parse(["list"]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No entries found"));
  });

  it("calls formatEntry for each entry when list is non-empty", () => {
    const fakeEntry = {
      id: 1,
      type: "fact" as const,
      content: "x",
      source: null,
      confidence: "high" as const,
      session: "default",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    vi.mocked(dbMod.listEntries).mockReturnValueOnce([fakeEntry, fakeEntry]);
    parse(["list"]);
    expect(displayMod.formatEntry).toHaveBeenCalledTimes(2);
  });
});

// ── sessions ─────────────────────────────────────────────────────────────────

describe("sessions command", () => {
  it("calls listSessions and prints session names", () => {
    vi.mocked(dbMod.listSessions).mockReturnValueOnce(["alpha", "beta"]);
    parse(["sessions"]);
    const allLogs = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(allLogs).toContain("alpha");
    expect(allLogs).toContain("beta");
  });

  it("prints 'No sessions yet' when empty", () => {
    vi.mocked(dbMod.listSessions).mockReturnValueOnce([]);
    parse(["sessions"]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No sessions yet"));
  });
});

// ── handoff ──────────────────────────────────────────────────────────────────

describe("handoff command", () => {
  it("calls buildHandoffMarkdown without --json", () => {
    parse(["handoff"]);
    expect(handoffMod.buildHandoffMarkdown).toHaveBeenCalledTimes(1);
    expect(handoffMod.buildHandoffJson).not.toHaveBeenCalled();
  });

  it("calls buildHandoffJson with --json", () => {
    parse(["handoff", "--json"]);
    expect(handoffMod.buildHandoffJson).toHaveBeenCalledTimes(1);
    expect(handoffMod.buildHandoffMarkdown).not.toHaveBeenCalled();
  });

  it("passes session to getSummary", () => {
    parse(["handoff", "--session", "my-debug"]);
    expect(dbMod.getSummary).toHaveBeenCalledWith(expect.anything(), "my-debug");
  });
});

// ── export command ───────────────────────────────────────────────────────────

describe("export command", () => {
  it("outputs valid JSON with session field", () => {
    vi.mocked(dbMod.getSummary).mockReturnValueOnce({
      facts: [],
      hypotheses: [],
      rejected: [],
      unknowns: [],
      policyDecisions: [],
    });
    parse(["export"]);
    const raw = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty("session", "default");
    expect(parsed).toHaveProperty("exportedAt");
  });
});
