import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LedgerEntry, EntryType, ConfidenceLevel } from "./types.js";

function getDbPath(): string {
  const dir = join(homedir(), ".evidence-ledger");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "ledger.db");
}

let _db: Database.Database | null = null;

export function getDb(dbPath?: string): Database.Database {
  if (_db) return _db;
  _db = new Database(dbPath ?? getDbPath());
  migrate(_db);
  return _db;
}

export function resetDb(): void {
  _db = null;
}

function migrate(db: Database.Database): void {
  db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_type    ON entries(type);
  `);
}

function mapRow(row: Record<string, unknown>): LedgerEntry {
  return {
    id: row.id as number,
    type: row.type as EntryType,
    content: row.content as string,
    source: (row.source as string | null) ?? null,
    confidence: row.confidence as ConfidenceLevel,
    session: row.session as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function addEntry(
  db: Database.Database,
  opts: {
    type: EntryType;
    content: string;
    source?: string | null;
    confidence?: ConfidenceLevel;
    session?: string;
  },
): LedgerEntry {
  const stmt = db.prepare(`
    INSERT INTO entries (type, content, source, confidence, session)
    VALUES (@type, @content, @source, @confidence, @session)
  `);
  const result = stmt.run({
    type: opts.type,
    content: opts.content,
    source: opts.source ?? null,
    confidence: opts.confidence ?? "medium",
    session: opts.session ?? "default",
  });
  return getEntry(db, result.lastInsertRowid as number)!;
}

export function getEntry(db: Database.Database, id: number): LedgerEntry | null {
  const row = db.prepare("SELECT * FROM entries WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? mapRow(row) : null;
}

export function rejectHypothesis(
  db: Database.Database,
  id: number,
  reason?: string,
): LedgerEntry | null {
  const entry = getEntry(db, id);
  if (!entry) return null;

  const newContent = reason ? `${entry.content} [rejected: ${reason}]` : entry.content;

  db.prepare(`
    UPDATE entries
    SET type = 'rejected', content = @content, updated_at = datetime('now')
    WHERE id = @id
  `).run({ id, content: newContent });

  return getEntry(db, id);
}

export function listEntries(
  db: Database.Database,
  opts: { session?: string; type?: EntryType } = {},
): LedgerEntry[] {
  const conditions: string[] = [];
  const params: Record<string, string> = {};

  if (opts.session) {
    conditions.push("session = @session");
    params.session = opts.session;
  }
  if (opts.type) {
    conditions.push("type = @type");
    params.type = opts.type;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM entries ${where} ORDER BY created_at ASC`)
    .all(params) as Record<string, unknown>[];
  return rows.map(mapRow);
}

export function getSummary(
  db: Database.Database,
  session = "default",
): {
  facts: LedgerEntry[];
  hypotheses: LedgerEntry[];
  rejected: LedgerEntry[];
  unknowns: LedgerEntry[];
} {
  const all = listEntries(db, { session });
  return {
    facts: all.filter((e) => e.type === "fact"),
    hypotheses: all.filter((e) => e.type === "hypothesis"),
    rejected: all.filter((e) => e.type === "rejected"),
    unknowns: all.filter((e) => e.type === "unknown"),
  };
}

export function clearSession(db: Database.Database, session: string): number {
  const result = db.prepare("DELETE FROM entries WHERE session = ?").run(session);
  return result.changes;
}

export function listSessions(db: Database.Database): string[] {
  const rows = db
    .prepare("SELECT DISTINCT session FROM entries ORDER BY session")
    .all() as { session: string }[];
  return rows.map((r) => r.session);
}
