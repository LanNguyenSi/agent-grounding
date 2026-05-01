import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  addEntry,
  getEntry,
  rejectHypothesis,
  listEntries,
  getSummary,
  clearSession,
  listSessions,
  parseDuration,
  pruneEntries,
} from "../src/db.js";

let db: Database.Database;

function setupDb(): Database.Database {
  const d = new Database(":memory:");
  d.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT    NOT NULL CHECK(type IN ('fact','hypothesis','rejected','unknown')),
      content     TEXT    NOT NULL,
      source      TEXT,
      confidence  TEXT    NOT NULL DEFAULT 'medium' CHECK(confidence IN ('high','medium','low')),
      session     TEXT    NOT NULL DEFAULT 'default',
      created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_session ON entries(session);
    CREATE INDEX IF NOT EXISTS idx_type ON entries(type);
  `);
  return d;
}

beforeEach(() => {
  db = setupDb();
});

afterEach(() => {
  db.close();
});

describe("addEntry", () => {
  it("adds a fact with default confidence", () => {
    const entry = addEntry(db, { type: "fact", content: "process is running" });
    expect(entry.id).toBeTruthy();
    expect(entry.type).toBe("fact");
    expect(entry.content).toBe("process is running");
    expect(entry.confidence).toBe("medium");
    expect(entry.session).toBe("default");
    expect(entry.source).toBeNull();
  });

  it("adds a fact with source and high confidence", () => {
    const entry = addEntry(db, {
      type: "fact",
      content: "port 3000 is open",
      source: "netstat -tulpn",
      confidence: "high",
    });
    expect(entry.source).toBe("netstat -tulpn");
    expect(entry.confidence).toBe("high");
  });

  it("adds a hypothesis with custom session", () => {
    const entry = addEntry(db, {
      type: "hypothesis",
      content: "redis connection is failing",
      session: "debug-2026-04-02",
    });
    expect(entry.type).toBe("hypothesis");
    expect(entry.session).toBe("debug-2026-04-02");
  });

  it("adds an unknown entry", () => {
    const entry = addEntry(db, { type: "unknown", content: "why the process stopped" });
    expect(entry.type).toBe("unknown");
  });

  it("adds a rejected entry directly", () => {
    const entry = addEntry(db, { type: "rejected", content: "network is root cause" });
    expect(entry.type).toBe("rejected");
  });

  it("assigns incrementing IDs", () => {
    const a = addEntry(db, { type: "fact", content: "first" });
    const b = addEntry(db, { type: "fact", content: "second" });
    expect(b.id).toBeGreaterThan(a.id);
  });
});

describe("getEntry", () => {
  it("returns entry by id", () => {
    const added = addEntry(db, { type: "fact", content: "test fact" });
    const fetched = getEntry(db, added.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.content).toBe("test fact");
  });

  it("returns null for non-existent id", () => {
    expect(getEntry(db, 9999)).toBeNull();
  });
});

describe("rejectHypothesis", () => {
  it("marks a hypothesis as rejected", () => {
    const hyp = addEntry(db, { type: "hypothesis", content: "database is down" });
    const rejected = rejectHypothesis(db, hyp.id);
    expect(rejected).not.toBeNull();
    expect(rejected!.type).toBe("rejected");
    expect(rejected!.content).toContain("database is down");
  });

  it("appends reason to content when provided", () => {
    const hyp = addEntry(db, { type: "hypothesis", content: "token expired" });
    const rejected = rejectHypothesis(db, hyp.id, "token is still valid (checked expiry)");
    expect(rejected!.content).toContain("token expired");
    expect(rejected!.content).toContain("token is still valid (checked expiry)");
  });

  it("returns null for non-existent id", () => {
    expect(rejectHypothesis(db, 9999)).toBeNull();
  });

  it("can reject a fact too (flexible by design)", () => {
    const fact = addEntry(db, { type: "fact", content: "wrong assumption" });
    const rejected = rejectHypothesis(db, fact.id, "turned out to be wrong");
    expect(rejected!.type).toBe("rejected");
  });
});

describe("listEntries", () => {
  beforeEach(() => {
    addEntry(db, { type: "fact", content: "fact 1", session: "s1" });
    addEntry(db, { type: "hypothesis", content: "hyp 1", session: "s1" });
    addEntry(db, { type: "fact", content: "fact 2", session: "s2" });
    addEntry(db, { type: "unknown", content: "unknown 1", session: "s1" });
  });

  it("lists all entries for a session", () => {
    const entries = listEntries(db, { session: "s1" });
    expect(entries).toHaveLength(3);
  });

  it("filters by type within a session", () => {
    const facts = listEntries(db, { session: "s1", type: "fact" });
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe("fact 1");
  });

  it("lists entries across all sessions when no filter", () => {
    const all = listEntries(db);
    expect(all).toHaveLength(4);
  });

  it("returns empty array for unknown session", () => {
    expect(listEntries(db, { session: "nonexistent" })).toHaveLength(0);
  });
});

describe("getSummary", () => {
  beforeEach(() => {
    addEntry(db, { type: "fact", content: "confirmed: process dead", session: "debug" });
    addEntry(db, { type: "hypothesis", content: "maybe OOM killer", session: "debug" });
    addEntry(db, { type: "rejected", content: "network issue", session: "debug" });
    addEntry(db, { type: "unknown", content: "root cause unclear", session: "debug" });
    addEntry(db, { type: "fact", content: "different session", session: "other" });
  });

  it("groups entries by type for a session", () => {
    const summary = getSummary(db, "debug");
    expect(summary.facts).toHaveLength(1);
    expect(summary.hypotheses).toHaveLength(1);
    expect(summary.rejected).toHaveLength(1);
    expect(summary.unknowns).toHaveLength(1);
  });

  it("does not include entries from other sessions", () => {
    const summary = getSummary(db, "debug");
    const allContent = [
      ...summary.facts,
      ...summary.hypotheses,
      ...summary.rejected,
      ...summary.unknowns,
    ].map((e) => e.content);
    expect(allContent).not.toContain("different session");
  });

  it("returns empty summary for unknown session", () => {
    const summary = getSummary(db, "nonexistent");
    expect(summary.facts).toHaveLength(0);
    expect(summary.hypotheses).toHaveLength(0);
    expect(summary.rejected).toHaveLength(0);
    expect(summary.unknowns).toHaveLength(0);
  });
});

describe("getSummary — Phase 5 #5: server-side filters", () => {
  beforeEach(() => {
    db.prepare(
      "INSERT INTO entries (type, content, session, created_at) VALUES (?, ?, ?, ?)",
    ).run("fact", "policy_decision:review-before-merge:deny ...", "s1", "2026-04-30 08:00:00");
    db.prepare(
      "INSERT INTO entries (type, content, session, created_at) VALUES (?, ?, ?, ?)",
    ).run("fact", "policy_decision:review-before-merge:allow ...", "s1", "2026-04-30 11:00:00");
    db.prepare(
      "INSERT INTO entries (type, content, session, created_at) VALUES (?, ?, ?, ?)",
    ).run("fact", "agent-recorded fact unrelated to policy", "s1", "2026-04-30 11:30:00");
    db.prepare(
      "INSERT INTO entries (type, content, session, created_at) VALUES (?, ?, ?, ?)",
    ).run("hypothesis", "policy_decision:dogfood-recency:warn-degraded ...", "s1", "2026-04-30 11:45:00");
  });

  it("sinceIso filter excludes rows older than the cutoff", () => {
    const summary = getSummary(db, "s1", { sinceIso: "2026-04-30 11:00:00" });
    // deny@08:00 dropped; allow@11:00, fact@11:30, warn@11:45 kept
    expect(summary.facts).toHaveLength(2);
    expect(summary.hypotheses).toHaveLength(1);
    expect(summary.facts.map((e) => e.content).join("\n")).not.toContain("deny");
  });

  it("contentPrefix filter keeps only matching rows", () => {
    const summary = getSummary(db, "s1", { contentPrefix: "policy_decision:" });
    // 2 policy_decision facts + 1 policy_decision hypothesis; the
    // unrelated fact is excluded.
    expect(summary.facts).toHaveLength(2);
    expect(summary.hypotheses).toHaveLength(1);
    expect(summary.facts.every((e) => e.content.startsWith("policy_decision:"))).toBe(true);
  });

  it("sinceIso + contentPrefix compose", () => {
    const summary = getSummary(db, "s1", {
      sinceIso: "2026-04-30 11:00:00",
      contentPrefix: "policy_decision:",
    });
    // allow@11:00 + warn@11:45 (the 11:30 unrelated fact is excluded by prefix)
    expect(summary.facts).toHaveLength(1);
    expect(summary.hypotheses).toHaveLength(1);
  });

  it("contentPrefix escapes SQL LIKE metacharacters", () => {
    db.prepare(
      "INSERT INTO entries (type, content, session, created_at) VALUES (?, ?, ?, ?)",
    ).run("fact", "policy_decision:literal-match", "s2", "2026-04-30 12:00:00");
    db.prepare(
      "INSERT INTO entries (type, content, session, created_at) VALUES (?, ?, ?, ?)",
    ).run("fact", "policyXdecision:wildcard-spoof", "s2", "2026-04-30 12:01:00");
    // Naive LIKE without escape would let `policy_decision:` match
    // `policyXdecision:` because `_` is the LIKE single-char wildcard.
    const summary = getSummary(db, "s2", { contentPrefix: "policy_decision:" });
    expect(summary.facts).toHaveLength(1);
    expect(summary.facts[0]!.content).toBe("policy_decision:literal-match");
  });

  it("empty filters keep back-compat (returns full summary)", () => {
    const fullSummary = getSummary(db, "s1");
    const emptyFilteredSummary = getSummary(db, "s1", {});
    expect(emptyFilteredSummary.facts.length).toBe(fullSummary.facts.length);
    expect(emptyFilteredSummary.hypotheses.length).toBe(fullSummary.hypotheses.length);
  });
});

describe("clearSession", () => {
  it("removes all entries for a session", () => {
    addEntry(db, { type: "fact", content: "temp fact", session: "temp" });
    addEntry(db, { type: "hypothesis", content: "temp hyp", session: "temp" });
    addEntry(db, { type: "fact", content: "keep", session: "keep" });

    const deleted = clearSession(db, "temp");
    expect(deleted).toBe(2);

    const remaining = listEntries(db, { session: "keep" });
    expect(remaining).toHaveLength(1);
  });

  it("returns 0 for non-existent session", () => {
    expect(clearSession(db, "ghost-session")).toBe(0);
  });
});

describe("listSessions", () => {
  it("returns all unique session names", () => {
    addEntry(db, { type: "fact", content: "a", session: "alpha" });
    addEntry(db, { type: "fact", content: "b", session: "beta" });
    addEntry(db, { type: "fact", content: "c", session: "alpha" }); // duplicate

    const sessions = listSessions(db);
    expect(sessions).toContain("alpha");
    expect(sessions).toContain("beta");
    expect(sessions).toHaveLength(2);
  });

  it("returns empty array when no entries", () => {
    expect(listSessions(db)).toHaveLength(0);
  });
});

describe("parseDuration", () => {
  it("parses seconds, minutes, hours, days", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(parseDuration("7d")).toBe(604_800_000);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseDuration("  14d  ")).toBe(14 * 86_400_000);
  });

  it("rejects malformed input", () => {
    expect(() => parseDuration("")).toThrow(/Invalid duration/);
    expect(() => parseDuration("30")).toThrow(/Invalid duration/);
    expect(() => parseDuration("d30")).toThrow(/Invalid duration/);
    expect(() => parseDuration("30D")).toThrow(/Invalid duration/); // uppercase not allowed
    expect(() => parseDuration("30w")).toThrow(/Invalid duration/);
    expect(() => parseDuration("-5d")).toThrow(/Invalid duration/);
  });
});

describe("pruneEntries", () => {
  function insertWithDate(session: string, content: string, createdAt: string): void {
    db.prepare(
      `INSERT INTO entries (type, content, session, created_at, updated_at)
       VALUES ('fact', @content, @session, @createdAt, @createdAt)`,
    ).run({ content, session, createdAt });
  }

  function daysAgo(n: number): string {
    return new Date(Date.now() - n * 86_400_000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
  }

  it("deletes entries older than the cutoff and keeps younger ones", () => {
    insertWithDate("old", "40d old", daysAgo(40));
    insertWithDate("old", "31d old", daysAgo(31));
    insertWithDate("fresh", "1d old", daysAgo(1));
    addEntry(db, { type: "fact", content: "just now", session: "fresh" });

    const result = pruneEntries(db, { olderThanMs: 30 * 86_400_000 });

    expect(result.deleted).toBe(2);
    expect(result.scanned).toBe(4);
    expect(result.dryRun).toBe(false);

    const remaining = listEntries(db);
    expect(remaining).toHaveLength(2);
    expect(remaining.map((e) => e.content).sort()).toEqual(["1d old", "just now"]);
  });

  it("dry-run returns counts without mutating the DB", () => {
    insertWithDate("old", "40d old A", daysAgo(40));
    insertWithDate("old", "40d old B", daysAgo(40));
    addEntry(db, { type: "fact", content: "today", session: "fresh" });

    const before = listEntries(db);
    const result = pruneEntries(db, { olderThanMs: 30 * 86_400_000, dryRun: true });
    const after = listEntries(db);

    expect(result.deleted).toBe(2);
    expect(result.scanned).toBe(3);
    expect(result.dryRun).toBe(true);
    expect(after).toHaveLength(before.length);
  });

  it("returns zero when nothing is old enough", () => {
    addEntry(db, { type: "fact", content: "a" });
    addEntry(db, { type: "fact", content: "b" });

    const result = pruneEntries(db, { olderThanMs: 30 * 86_400_000 });
    expect(result.deleted).toBe(0);
    expect(result.scanned).toBe(2);
  });

  it("exposes the cutoff timestamp in SQLite's datetime format", () => {
    const result = pruneEntries(db, { olderThanMs: 1_000 });
    // YYYY-MM-DD HH:MM:SS — no 'T', no 'Z', no fractional seconds
    expect(result.cutoff).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("rejects invalid olderThanMs values", () => {
    expect(() => pruneEntries(db, { olderThanMs: Number.NaN })).toThrow(/non-negative finite/);
    expect(() => pruneEntries(db, { olderThanMs: Number.POSITIVE_INFINITY })).toThrow(
      /non-negative finite/,
    );
    expect(() => pruneEntries(db, { olderThanMs: -1 })).toThrow(/non-negative finite/);
  });
});
