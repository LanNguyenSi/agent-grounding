// Pure helpers around approval state. The persisted Understanding Report
// itself is the source of truth (Phase 2 scope clarification: no separate
// approval.json marker file). The CLI flips `approvalStatus` via
// loadReport → withApprovalStatus → saveReport; the PreToolUse hook
// reads the latest report for the active session and consults the field.

import type {
  ApprovalStatus,
  UnderstandingReport,
} from "../schema/types.js";
import type { ReportEntry } from "./persistence.js";

export type ApproveActor = "cli" | "marker_phrase" | "force" | "agent";

// Pick the most recent persisted entry for `taskId`. "Most recent" prefers
// `approvedAt` when present so a freshly approved version supersedes the
// pending draft it was derived from (both share the original `createdAt`).
// Falls back to `createdAt` for fully pending histories.
export function findLatestForTask(
  entries: ReportEntry[],
  taskId: string,
): ReportEntry | null {
  const matches = entries.filter((e) => e.taskId === taskId);
  if (matches.length === 0) return null;
  matches.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  return matches[0];
}

export function isApproved(entry: ReportEntry | null): boolean {
  return !!entry && entry.approvalStatus === "approved";
}

// Return a copy of `report` with approval state set to `status`. Sets
// approvedAt + approvedBy when approving; clears them on revoke. Pure —
// callers persist by passing the result to saveReport.
//
// Refreshes `createdAt` to `now` on every state flip so saveReport
// produces a new content-hash-keyed file AND `findLatestForTask`'s sort
// (which falls back to createdAt) sees the latest snapshot win. The
// previous snapshot is left in the dir as an audit trail; the
// authoritative timeline of state changes is the JSONL audit.log.
export function withApprovalStatus(
  report: UnderstandingReport,
  status: ApprovalStatus,
  who: ApproveActor,
  now: Date = new Date(),
): UnderstandingReport {
  const next: UnderstandingReport = {
    ...report,
    approvalStatus: status,
    createdAt: now.toISOString(),
  };
  if (status === "approved") {
    next.approvedAt = now.toISOString();
    next.approvedBy = who;
  } else {
    delete next.approvedAt;
    delete next.approvedBy;
  }
  return next;
}

function sortKey(entry: ReportEntry): string {
  return entry.approvedAt ?? entry.createdAt ?? "";
}
