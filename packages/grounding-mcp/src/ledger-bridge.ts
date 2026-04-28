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
