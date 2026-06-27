// Tests for the module-level singleton behaviour of getDb/resetDb.
// Distinct from ledger.test.ts which exercises the data helpers against
// an in-memory DB handed in directly.

import { describe, expect, it, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  statSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, resetDb, addEntry } from "../src/db.js";

const tmpRoots: string[] = [];

afterEach(() => {
  resetDb();
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function mkTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "evidence-ledger-singleton-"));
  tmpRoots.push(dir);
  return dir;
}

describe("getDb — parent-dir creation", () => {
  it("creates missing parent directory for a custom dbPath", () => {
    const root = mkTmp();
    const nested = join(root, "deeply", "nested", "dir", "ledger.db");
    expect(existsSync(join(root, "deeply"))).toBe(false);

    const db = getDb(nested);
    expect(existsSync(nested)).toBe(true);
    expect(existsSync(join(root, "deeply", "nested", "dir"))).toBe(true);

    // Writing works — parent dir is now real.
    addEntry(db, { type: "fact", content: "smoke", session: "s" });
  });

  it("noop when parent already exists", () => {
    const root = mkTmp();
    const path = join(root, "ledger.db");
    // Parent (root) already exists — call should succeed without error.
    const db = getDb(path);
    expect(existsSync(path)).toBe(true);
    addEntry(db, { type: "fact", content: "ok", session: "s" });
  });
});

describe("getDb — WAL, permissions, open guard (M3/M4)", () => {
  it("opens file-backed DBs in WAL mode", () => {
    const path = join(mkTmp(), "wal.db");
    const db = getDb(path);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("leaves an in-memory DB at its default journal mode (WAL no-ops)", () => {
    const db = getDb(":memory:");
    expect(db.pragma("journal_mode", { simple: true })).toBe("memory");
  });

  it("creates the parent dir 0700 and the DB file 0600", () => {
    if (process.platform === "win32") return; // POSIX permission bits only
    const root = mkTmp();
    const dir = join(root, "private");
    const path = join(dir, "ledger.db");
    getDb(path);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("throws a path-named error when the database cannot be opened", () => {
    const root = mkTmp();
    // Put a *file* where getDb expects a parent directory, so the native
    // open fails with ENOTDIR. The guard must rethrow naming the path
    // rather than leaking the raw better-sqlite3 error.
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "x");
    const badPath = join(blocker, "ledger.db");
    expect(() => getDb(badPath)).toThrow(/failed to open SQLite database/);
    expect(() => getDb(badPath)).toThrow(badPath);
  });

  it("leaves no singleton behind a failed open, so the next open succeeds", () => {
    const root = mkTmp();
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "x");
    expect(() => getDb(join(blocker, "bad.db"))).toThrow();
    // The failed open must have nulled _db (not cached a half-open
    // handle), so a fresh good path opens cleanly and is writable.
    const good = join(root, "good.db");
    const db = getDb(good);
    expect(existsSync(good)).toBe(true);
    addEntry(db, { type: "fact", content: "after failed open", session: "s" });
  });

  it("forces a pre-existing world-readable DB file down to 0600 on open", () => {
    if (process.platform === "win32") return; // POSIX permission bits only
    const path = join(mkTmp(), "preexisting.db");
    // Simulate a ledger created by an older version at the umask default.
    writeFileSync(path, "");
    chmodSync(path, 0o644);
    getDb(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("resetDb — closes the prior handle", () => {
  it("closes the previous connection before dropping the reference", () => {
    const path = join(mkTmp(), "a.db");
    const db1 = getDb(path);
    addEntry(db1, { type: "fact", content: "before reset", session: "s" });

    resetDb();

    // The old handle should refuse further operations because close()
    // was called on it — better-sqlite3 throws `TypeError: The database
    // connection is not open`. We don't assert on the exact message to
    // stay resilient to version bumps, just that it throws.
    expect(() =>
      addEntry(db1, { type: "fact", content: "after reset", session: "s" }),
    ).toThrow();
  });

  it("allows re-opening at a different path after reset", () => {
    const pathA = join(mkTmp(), "a.db");
    const pathB = join(mkTmp(), "b.db");

    const dbA = getDb(pathA);
    addEntry(dbA, { type: "fact", content: "for A", session: "s" });

    resetDb();

    const dbB = getDb(pathB);
    // Fresh DB — session "s" should have no entries from A.
    expect(dbB).not.toBe(dbA);
    addEntry(dbB, { type: "fact", content: "for B", session: "s" });
    expect(existsSync(pathA)).toBe(true);
    expect(existsSync(pathB)).toBe(true);
  });

  it("tolerates being called twice in a row (idempotent)", () => {
    const path = join(mkTmp(), "x.db");
    getDb(path);
    resetDb();
    // No error on second call even though _db is already null.
    expect(() => resetDb()).not.toThrow();
  });

  it("tolerates being called before getDb (null handle)", () => {
    expect(() => resetDb()).not.toThrow();
  });

  it("survives a handle that has already been closed externally", () => {
    const path = join(mkTmp(), "y.db");
    const db = getDb(path);
    db.close();
    // Our resetDb catches the double-close error internally and still
    // drops the reference so subsequent getDb opens a fresh handle.
    expect(() => resetDb()).not.toThrow();
    const freshPath = join(mkTmp(), "z.db");
    const db2 = getDb(freshPath);
    expect(db2).not.toBe(db);
    addEntry(db2, { type: "fact", content: "after external close", session: "s" });
  });
});
