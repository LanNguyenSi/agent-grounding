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
