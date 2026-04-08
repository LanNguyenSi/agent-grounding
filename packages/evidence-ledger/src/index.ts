/**
 * Evidence Ledger — public API
 *
 * Track facts, hypotheses, and rejections during agent debugging sessions.
 */

export type { LedgerEntry, EntryType, ConfidenceLevel, LedgerSummary, AddEntryOptions } from "./types.js";

export {
  getDb,
  resetDb,
  addEntry,
  getEntry,
  rejectHypothesis,
  listEntries,
  getSummary,
  clearSession,
  listSessions,
} from "./db.js";
