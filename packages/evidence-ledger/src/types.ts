export type EntryType = "fact" | "hypothesis" | "rejected" | "unknown";

export type ConfidenceLevel = "high" | "medium" | "low";

export interface LedgerEntry {
  id: number;
  type: EntryType;
  content: string;
  source: string | null;
  confidence: ConfidenceLevel;
  session: string;
  createdAt: string;
  updatedAt: string;
}

export interface LedgerSummary {
  session: string;
  facts: LedgerEntry[];
  hypotheses: LedgerEntry[];
  rejected: LedgerEntry[];
  unknowns: LedgerEntry[];
}

export interface AddEntryOptions {
  type: EntryType;
  content: string;
  source?: string;
  confidence?: ConfidenceLevel;
  session?: string;
}

export interface RejectOptions {
  id: number;
  reason?: string;
}
