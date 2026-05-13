// Owns the better-sqlite3 connection to evidence-ledger.
//
// evidence-ledger exposes a singleton getDb() that caches by first-call. The
// MCP server needs the cache (one open connection across many tool calls),
// but tests need to swap the path between cases. We honor EVIDENCE_LEDGER_DB
// on first connect and provide a `reset` for tests.

import Database from 'better-sqlite3';
import { getDb, resetDb } from '@lannguyensi/evidence-ledger';

export function ledgerDb(): Database.Database {
  // EVIDENCE_LEDGER_DB lets tests (and ad-hoc invocations) point at a temp
  // file instead of clobbering the user's real ~/.evidence-ledger/ledger.db.
  // evidence-ledger's getDb() takes the path as an arg — we pass it through.
  return getDb(process.env.EVIDENCE_LEDGER_DB);
}

export function resetLedgerDb(): void {
  resetDb();
}

export type LedgerStatus =
  | {
      status: 'ok';
      dbPath: string;
      entryCount: number;
      lastWriteAt: string | null;
    }
  | { status: 'error'; message: string };

// No-arg liveness probe for the evidence ledger. Designed for harness's
// MCP health probe (tools/call with empty arguments). Returns a structured
// shape rather than throwing so an unreachable ledger does not crash the
// server.
export function ledgerStatus(): LedgerStatus {
  try {
    const db = ledgerDb();
    const countRow = db
      .prepare('SELECT COUNT(*) AS c FROM entries')
      .get() as { c: number };
    const lastRow = db
      .prepare('SELECT MAX(created_at) AS t FROM entries')
      .get() as { t: string | null };
    return {
      status: 'ok',
      dbPath: process.env.EVIDENCE_LEDGER_DB ?? '<default>',
      entryCount: countRow.c,
      lastWriteAt: lastRow.t,
    };
  } catch (err) {
    return {
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
