import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { LedgerEntry, EntryType, ConfidenceLevel } from "./types.js";

// The ledger can capture debug evidence, paths, and command output, so on
// a shared host it must not be world-readable. Create the dir 0700 and the
// DB file 0600. `0o700` has no group/other bits, so the process umask
// cannot widen it.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function getDbPath(): string {
  const dir = join(homedir(), ".evidence-ledger");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  } else {
    // Retroactively tighten an existing install: older versions created
    // this dir at the umask default (typically 0755). Safe to chmod every
    // open because this path is exclusively the ledger's own dir. Custom
    // paths are NOT chmod'd here — their parent could be a shared dir
    // (e.g. /tmp) the caller never meant to lock down.
    chmodSync(dir, DIR_MODE);
  }
  return join(dir, "ledger.db");
}

let _db: Database.Database | null = null;
// The exact string passed to `new Database()` for the currently-open
// singleton (or null when no singleton is open). Used only in the
// "already open" error message; it never affects how a path is opened.
let _dbPath: string | null = null;
// Identity of the open singleton, frozen at open time as
// normalizeForComparison(resolved). Later requests are compared against
// this frozen key instead of re-normalizing _dbPath per call: a caller
// that opened a RELATIVE path and has since chdir'd would otherwise have
// both operands re-resolved against the new cwd, silently conflating two
// different databases (or spuriously splitting one) — the exact footgun
// this guard exists to prevent.
let _dbPathKey: string | null = null;

// `:memory:` is SQLite's special in-memory sentinel, not a filesystem
// path — path.resolve(":memory:") would turn it into
// "<cwd>/:memory:", silently breaking "the same :memory: request is the
// same database". Compare it literally; resolve everything else so a
// relative and an equivalent absolute path are recognized as the same
// database. This normalization is for comparison only — the value handed
// to `new Database()` is always the raw `resolved` from below, untouched.
function normalizeForComparison(path: string): string {
  return path === ":memory:" ? path : resolve(path);
}

export function getDb(dbPath?: string): Database.Database {
  if (_db) {
    // No explicit path: callers relying on "just give me the handle"
    // keep getting it, unconditionally, exactly as before this guard
    // existed.
    if (dbPath === undefined) return _db;
    // An explicit path that names the same database (after resolving
    // relative/absolute equivalence, judged against the open-time
    // identity key) is a no-op re-open — return the existing handle
    // rather than throwing.
    if (normalizeForComparison(dbPath) === _dbPathKey) {
      return _db;
    }
    // A caller asking for a genuinely different database while one is
    // already open would otherwise silently keep writing to the first
    // path — a footgun for tests and CLI tools that re-point the
    // singleton mid-process. Fail loudly and name both paths instead.
    throw new Error(
      `evidence-ledger: ledger already open at "${_dbPath}", requested "${dbPath}" — call resetDb() first to switch to a different path.`,
    );
  }
  const resolved = dbPath ?? getDbPath();
  // better-sqlite3 creates the DB file itself but refuses to create
  // intermediate directories. When a caller passes a custom path (e.g.
  // `.evidence-ledger/db.sqlite` relative to a fresh CI workspace),
  // ensure the parent dir exists so the constructor doesn't throw
  // `directory does not exist`. getDbPath() already mkdirs the default.
  const parent = dirname(resolved);
  if (parent && !existsSync(parent)) {
    mkdirSync(parent, { recursive: true, mode: DIR_MODE });
  }
  try {
    _db = new Database(resolved);
    // WAL lets concurrent hook processes read while one writes, instead
    // of colliding on SQLITE_BUSY. No-op for `:memory:` (stays `memory`).
    _db.pragma("journal_mode = WAL");
    // The dir is 0700, but the DB file inherits the default umask (0644)
    // on creation; force it to owner-only on every open — the ledger is
    // single-user-private by design. Skipped for `:memory:` (no file).
    if (resolved !== ":memory:" && existsSync(resolved)) {
      chmodSync(resolved, FILE_MODE);
    }
    migrate(_db);
    _dbPath = resolved;
    _dbPathKey = normalizeForComparison(resolved);
  } catch (err) {
    // Any failure configuring the handle — a broken better-sqlite3 native
    // binding, an un-creatable path, a read-only FS on the pragma/migrate,
    // or chmod EPERM — must not leave a half-open singleton. resetDb()
    // closes the partial handle (if any) and nulls _db (and the
    // remembered _dbPath — see resetDb below), so the next call reopens
    // cleanly instead of tripping the "already open" guard against a
    // path whose open actually failed. Rethrow a path-named error
    // preserving the cause.
    resetDb();
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `evidence-ledger: failed to open SQLite database at "${resolved}": ${reason}`,
      { cause: err },
    );
  }
  return _db;
}

export function resetDb(): void {
  // Close the prior handle before dropping the reference. Without this
  // callers that re-point the singleton to a new path (tests, CLI tools
  // with --ledger-db) silently leak the old SQLite connection, which
  // holds its journal file open and can trigger SQLITE_BUSY on
  // subsequent writes from other processes.
  if (_db) {
    try {
      _db.close();
    } catch {
      // better-sqlite3 double-close is a silent noop; close() only
      // throws when a statement is mid-execution or the handle is in
      // a similarly transient busy state. resetDb is a reset — callers
      // want forward progress, not a failure — so swallow and drop
      // the reference either way.
    }
  }
  _db = null;
  // Drop the remembered path + identity key along with the handle.
  // Defensive invariant-keeping ("_dbPath/_dbPathKey are set iff _db is
  // set"): the guard only ever consults them while _db is truthy, and
  // every successful open overwrites both, so a stale value is not
  // observable through the public API — but the invariant should hold
  // regardless of how resetDb was reached.
  _dbPath = null;
  _dbPathKey = null;
}

// SQL fragment for the canonical entries-table CHECK constraint. Kept
// in sync with the EntryType union in `types.ts`. Phase 5 #4 added
// `policy_decision`.
const ENTRY_TYPE_CHECK =
  "CHECK(type IN ('fact','hypothesis','rejected','unknown','policy_decision'))";

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      type        TEXT    NOT NULL ${ENTRY_TYPE_CHECK},
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

  // Phase 5 #4 — pre-existing ledgers have the old CHECK that omits
  // `policy_decision`. SQLite has no ALTER TABLE ... CHECK; the
  // canonical recipe is the rename-rebuild dance. Detect via the
  // stored DDL in sqlite_master and rebuild only when needed so a
  // fresh-install path stays a single CREATE TABLE statement.
  const tableSql = (
    db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='entries'",
      )
      .get() as { sql?: string } | undefined
  )?.sql;
  if (tableSql && !tableSql.includes("policy_decision")) {
    db.exec(`
      BEGIN;
      CREATE TABLE entries_new (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        type        TEXT    NOT NULL ${ENTRY_TYPE_CHECK},
        content     TEXT    NOT NULL,
        source      TEXT,
        confidence  TEXT    NOT NULL DEFAULT 'medium' CHECK(confidence IN ('high','medium','low')),
        session     TEXT    NOT NULL DEFAULT 'default',
        created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO entries_new
        (id, type, content, source, confidence, session, created_at, updated_at)
      SELECT
        id, type, content, source, confidence, session, created_at, updated_at
      FROM entries;
      DROP TABLE entries;
      ALTER TABLE entries_new RENAME TO entries;
      CREATE INDEX IF NOT EXISTS idx_session ON entries(session);
      CREATE INDEX IF NOT EXISTS idx_type    ON entries(type);
      COMMIT;
    `);
  }
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
  // INSERT then read-back run in one transaction so a concurrent writer
  // (another hook process) cannot delete the just-inserted row before we
  // re-select it. better-sqlite3 nests via savepoints, so this is safe
  // even if a caller wraps addEntry in its own transaction.
  const insert = db.transaction((): LedgerEntry => {
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
  });
  return insert();
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
  // Read, UPDATE, and read-back run in one transaction so they serialize
  // against a concurrent writer (via better-sqlite3's default 5s
  // busy_timeout) instead of interleaving. Nests via savepoints (see
  // addEntry).
  const reject = db.transaction((): LedgerEntry | null => {
    const entry = getEntry(db, id);
    if (!entry) return null;

    const newContent = reason
      ? `${entry.content} [rejected: ${reason}]`
      : entry.content;

    db.prepare(`
      UPDATE entries
      SET type = 'rejected', content = @content, updated_at = datetime('now')
      WHERE id = @id
    `).run({ id, content: newContent });

    return getEntry(db, id);
  });
  return reject();
}

export interface ListEntriesOptions {
  session?: string;
  type?: EntryType;
  /**
   * Phase 5 #5 — server-side recency filter. Pass an ISO-8601 UTC
   * timestamp (e.g. `"2026-05-01T08:00:00Z"`); rows with `created_at`
   * earlier than this are excluded at the SQL layer. Callers are
   * responsible for translating their `--since 1h` shorthand into an
   * absolute cutoff before passing it in.
   */
  sinceIso?: string;
  /**
   * Phase 5 #5 — server-side content prefix filter. Rows whose
   * `content` does NOT start with this string are excluded. Reduces
   * the wire payload when consumers (e.g. harness audit) only care
   * about a known prefix family like `policy_decision:`.
   */
  contentPrefix?: string;
}

export function listEntries(
  db: Database.Database,
  opts: ListEntriesOptions = {},
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
  if (opts.sinceIso !== undefined) {
    // Compare via SQLite's `datetime()` so both the stored
    // `YYYY-MM-DD HH:MM:SS` form and the ISO `YYYY-MM-DDTHH:MM:SSZ`
    // form normalize to the same value. Lexicographic comparison
    // fails between the two formats because `T` (0x54) > space
    // (0x20), so a same-day cutoff would silently exclude every row
    // stored under the `datetime('now')` form.
    conditions.push("datetime(created_at) >= datetime(@sinceIso)");
    params.sinceIso = opts.sinceIso;
  }
  if (opts.contentPrefix !== undefined && opts.contentPrefix.length > 0) {
    // Escape SQL LIKE metacharacters (% _ \) so a prefix like
    // `policy_decision:` matches literally rather than the underscore
    // wildcard. Use \\ as the LIKE escape character.
    const escaped = opts.contentPrefix.replace(/([\\%_])/g, "\\$1");
    conditions.push("content LIKE @contentPrefix ESCAPE '\\'");
    params.contentPrefix = `${escaped}%`;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM entries ${where} ORDER BY created_at ASC`)
    .all(params) as Record<string, unknown>[];
  return rows.map(mapRow);
}

export interface GetSummaryFilters {
  /**
   * Same shape as `ListEntriesOptions.sinceIso`. Filtered server-side
   * via SQL `created_at >= @sinceIso`.
   */
  sinceIso?: string;
  /** Same shape as `ListEntriesOptions.contentPrefix`. */
  contentPrefix?: string;
}

export function getSummary(
  db: Database.Database,
  session = "default",
  filters: GetSummaryFilters = {},
): {
  facts: LedgerEntry[];
  hypotheses: LedgerEntry[];
  rejected: LedgerEntry[];
  unknowns: LedgerEntry[];
  policyDecisions: LedgerEntry[];
} {
  const all = listEntries(db, { session, ...filters });
  return {
    facts: all.filter((e) => e.type === "fact"),
    hypotheses: all.filter((e) => e.type === "hypothesis"),
    rejected: all.filter((e) => e.type === "rejected"),
    unknowns: all.filter((e) => e.type === "unknown"),
    policyDecisions: all.filter((e) => e.type === "policy_decision"),
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

export function parseDuration(input: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(input.trim());
  if (!match) {
    throw new Error(
      `Invalid duration "${input}". Expected <number><unit> where unit is s/m/h/d (e.g. 30d, 24h, 15m, 3600s).`,
    );
  }
  const n = Number.parseInt(match[1], 10);
  const unit = match[2];
  const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]!;
  return n * unitMs;
}

export interface PruneResult {
  deleted: number;
  scanned: number;
  cutoff: string;
  dryRun: boolean;
  /**
   * Count of `policy_decision` rows older than `cutoff` that were left in
   * place because `includePolicyDecisions` was not set. Always 0 when
   * `includePolicyDecisions: true` (nothing to exempt) or when no
   * `policy_decision` rows are past the cutoff.
   */
  exemptedPolicyDecisions: number;
}

export function pruneEntries(
  db: Database.Database,
  opts: { olderThanMs: number; dryRun?: boolean; includePolicyDecisions?: boolean },
): PruneResult {
  // Defensive guard for library consumers. The CLI's parseDuration
  // already rejects these, but a direct caller passing NaN / Infinity
  // would otherwise hit a RangeError deep in `new Date(...)`, and a
  // negative number would push the cutoff into the future and silently
  // delete everything.
  if (!Number.isFinite(opts.olderThanMs) || opts.olderThanMs < 0) {
    throw new Error(
      `pruneEntries: olderThanMs must be a non-negative finite number, got ${opts.olderThanMs}`,
    );
  }

  // policy_decision rows are the orchestrator's audit trail (see
  // types.ts / Phase 5 #4): allow/deny/warn decisions a harness gate
  // made. Pruning them by default would quietly erase the evidence an
  // audit or incident review needs, so age-based prune EXEMPTS them
  // unless the caller explicitly opts in via includePolicyDecisions.
  const includePolicyDecisions = opts.includePolicyDecisions ?? false;
  const typeFilter = includePolicyDecisions ? "" : "AND type != 'policy_decision'";

  // SQLite's `datetime('now')` writes `YYYY-MM-DD HH:MM:SS` in UTC.
  // Build a cutoff in the same shape so lexicographic comparison in
  // SQL is correct. (ISO's `T` and trailing `Z` would otherwise sort
  // adjacent to but not equal to SQLite's space-separated form.)
  //
  // Boundary semantics: an entry is eligible only when created_at is
  // STRICTLY earlier than cutoff (`<`, not `<=`). An entry whose age is
  // exactly `olderThanMs` at the instant prune runs is therefore KEPT —
  // "older than N days" means age > N days, matching the CLI flag name.
  // See tests/ledger.test.ts "pruneEntries boundary semantics" for the
  // pinned behavior and its mutation-test note.
  const cutoff = new Date(Date.now() - opts.olderThanMs).toISOString().slice(0, 19).replace("T", " ");

  // Run both statements inside an IMMEDIATE transaction so a concurrent
  // reader sees either the pre- or post-state, never a torn read where
  // some entries survived and an equally-old sibling didn't.
  const run = db.transaction(() => {
    const scanned = (
      db.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }
    ).n;

    const exemptedPolicyDecisions = includePolicyDecisions
      ? 0
      : (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM entries WHERE created_at < @cutoff AND type = 'policy_decision'",
            )
            .get({ cutoff }) as { n: number }
        ).n;

    let deleted = 0;
    if (opts.dryRun) {
      deleted = (
        db
          .prepare(`SELECT COUNT(*) AS n FROM entries WHERE created_at < @cutoff ${typeFilter}`)
          .get({ cutoff }) as { n: number }
      ).n;
    } else {
      const result = db
        .prepare(`DELETE FROM entries WHERE created_at < @cutoff ${typeFilter}`)
        .run({ cutoff });
      deleted = result.changes;
    }
    return { deleted, scanned, exemptedPolicyDecisions };
  });

  const { deleted, scanned, exemptedPolicyDecisions } = run.immediate();
  return { deleted, scanned, cutoff, dryRun: opts.dryRun ?? false, exemptedPolicyDecisions };
}
