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

// "cli" is the only actor currently used by withApprovalStatus call sites.
// "force" is reserved for a future force-approve path. Variants that let an
// agent self-approve via transcript content were removed as a security fix.
export type ApproveActor = "cli" | "force";

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
  // expiredAt is the harness's stamp for how a report reached "expired"
  // (expirePersistedReport()); it describes that specific past state, not
  // the report's current state. Once a caller flips the status away from
  // "expired" (approve or revoke), the stale timestamp must not survive
  // into the new snapshot -- otherwise saveReport would persist a
  // self-contradictory record, e.g. {status: "approved", expiredAt: ...}
  // (agent-grounding 5120938c, review round 2).
  if (status !== "expired") {
    delete next.expiredAt;
  }
  return next;
}

function sortKey(entry: ReportEntry): string {
  return entry.approvedAt ?? entry.createdAt ?? "";
}
