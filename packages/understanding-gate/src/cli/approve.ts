// `understanding-gate approve | revoke | status` subcommands.
//
// Source of truth for approval is the persisted Understanding Report's
// `approvalStatus` field. approve/revoke load the latest report for a
// task, flip the field, and write a new file (saveReport's content-hash
// filenames mean the original pending draft stays alongside as audit
// trail). status reports current state without mutating.

import {
  listReports,
  loadReport,
  resolveReportDir,
  saveReport,
  type ReportEntry,
} from "../core/persistence.js";
import {
  appendAuditLine,
  defaultAuditLogPath,
  type AuditEvent,
} from "../core/audit.js";
import { findLatestForTask, withApprovalStatus } from "../core/approval.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ApprovalOptions {
  taskId?: string;
  reportId?: string;
  /** Override report dir; falls back to env / cwd default. */
  dir?: string;
  /** Override cwd for default dir resolution + audit log location. */
  cwd?: string;
  /** "now" injection for tests. */
  now?: Date;
}

export interface StatusOptions {
  taskId?: string;
  dir?: string;
  cwd?: string;
}

export function runApprove(opts: ApprovalOptions = {}): CommandResult {
  const cwd = opts.cwd ?? process.cwd();
  const entry = pickEntry(opts);
  if (!entry.ok) return entry.result;

  const loaded = loadReport(entry.path, { dir: opts.dir, cwd });
  if (!loaded.ok) {
    return {
      stdout: "",
      stderr: `understanding-gate: failed to load report: ${loaded.error.message}\n`,
      exitCode: 1,
    };
  }

  const next = withApprovalStatus(loaded.report, "approved", "cli", opts.now);
  const saved = saveReport(next, { dir: opts.dir, cwd, now: opts.now });

  safeAudit(cwd, {
    kind: "approve",
    approvedBy: "cli",
    sessionId: null,
    taskId: next.taskId,
    reportPath: saved.path,
  });

  const dirShown = resolveReportDir({ dir: opts.dir, cwd });
  return {
    stdout:
      `understanding-gate: approved report for taskId="${next.taskId}".\n` +
      `  source:   ${entry.path}\n` +
      `  approved: ${saved.path}\n` +
      `  dir:      ${dirShown}\n`,
    stderr: "",
    exitCode: 0,
  };
}

export function runRevoke(opts: ApprovalOptions = {}): CommandResult {
  const cwd = opts.cwd ?? process.cwd();
  const entry = pickEntry(opts);
  if (!entry.ok) return entry.result;

  const loaded = loadReport(entry.path, { dir: opts.dir, cwd });
  if (!loaded.ok) {
    return {
      stdout: "",
      stderr: `understanding-gate: failed to load report: ${loaded.error.message}\n`,
      exitCode: 1,
    };
  }

  const next = withApprovalStatus(loaded.report, "pending", "cli", opts.now);
  const saved = saveReport(next, { dir: opts.dir, cwd, now: opts.now });

  safeAudit(cwd, {
    kind: "revoke",
    sessionId: null,
    taskId: next.taskId,
    reportPath: saved.path,
  });

  return {
    stdout:
      `understanding-gate: revoked approval for taskId="${next.taskId}" (status=pending).\n` +
      `  pending: ${saved.path}\n`,
    stderr: "",
    exitCode: 0,
  };
}

export function runStatus(opts: StatusOptions = {}): CommandResult {
  const cwd = opts.cwd ?? process.cwd();
  const dir = resolveReportDir({ dir: opts.dir, cwd });
  const entries = listReports({ dir: opts.dir, cwd });

  if (entries.length === 0) {
    return {
      stdout: `understanding-gate: no reports under ${dir}\n`,
      stderr: "",
      exitCode: 0,
    };
  }

  const lines: string[] = [`understanding-gate status (dir=${dir}):`];
  if (opts.taskId) {
    const latest = findLatestForTask(entries, opts.taskId);
    lines.push(formatEntryLine(opts.taskId, latest));
  } else {
    const grouped = groupByTask(entries);
    const taskIds = [...grouped.keys()].sort();
    for (const id of taskIds) {
      const latest = findLatestForTask(entries, id);
      lines.push(formatEntryLine(id, latest));
    }
  }

  return {
    stdout: `${lines.join("\n")}\n`,
    stderr: "",
    exitCode: 0,
  };
}

// --- internals ---------------------------------------------------------

type PickedEntry = { ok: true; path: string } | { ok: false; result: CommandResult };

function pickEntry(opts: ApprovalOptions): PickedEntry {
  const cwd = opts.cwd ?? process.cwd();
  const dir = resolveReportDir({ dir: opts.dir, cwd });

  // Explicit reportId wins over taskId. reportId may be a filename or
  // taskId; loadReport handles both.
  if (opts.reportId) {
    const loaded = loadReport(opts.reportId, { dir: opts.dir, cwd });
    if (!loaded.ok) {
      return {
        ok: false,
        result: {
          stdout: "",
          stderr: `understanding-gate: ${loaded.error.message}\n`,
          exitCode: 1,
        },
      };
    }
    return { ok: true, path: loaded.path };
  }

  const entries = listReports({ dir: opts.dir, cwd });
  if (entries.length === 0) {
    return {
      ok: false,
      result: {
        stdout: "",
        stderr: `understanding-gate: no reports found in ${dir}\n`,
        exitCode: 1,
      },
    };
  }

  if (opts.taskId) {
    const latest = findLatestForTask(entries, opts.taskId);
    if (!latest) {
      return {
        ok: false,
        result: {
          stdout: "",
          stderr: `understanding-gate: no report matching taskId="${opts.taskId}" in ${dir}\n`,
          exitCode: 1,
        },
      };
    }
    return { ok: true, path: latest.path };
  }

  const distinctTaskIds = new Set(entries.map((e) => e.taskId));
  if (distinctTaskIds.size > 1) {
    const sample = [...distinctTaskIds].slice(0, 5).join(", ");
    return {
      ok: false,
      result: {
        stdout: "",
        stderr:
          `understanding-gate: multiple reports for distinct taskIds in ${dir}; ` +
          `pass --task-id <id> to disambiguate (saw: ${sample}${
            distinctTaskIds.size > 5 ? ", ..." : ""
          }).\n`,
        exitCode: 1,
      },
    };
  }

  // Single taskId across all entries; pick the latest by sort key.
  const onlyTaskId = entries[0].taskId;
  const latest = findLatestForTask(entries, onlyTaskId);
  // findLatestForTask cannot return null here: entries[].taskId === onlyTaskId
  // by construction, so the filter has at least one match.
  return { ok: true, path: (latest as ReportEntry).path };
}

function safeAudit(cwd: string, event: AuditEvent): void {
  try {
    appendAuditLine(defaultAuditLogPath(cwd), event);
  } catch {
    // ignore: audit must not block the CLI.
  }
}

function formatEntryLine(taskId: string, latest: ReportEntry | null): string {
  if (!latest) return `  ${taskId}: (no entry)`;
  const stamp = latest.approvedAt ?? latest.createdAt ?? "";
  return `  ${taskId}: ${latest.approvalStatus}${stamp ? ` @ ${stamp}` : ""} — ${shortenPath(latest.path)}`;
}

function groupByTask(entries: ReportEntry[]): Map<string, ReportEntry[]> {
  const m = new Map<string, ReportEntry[]>();
  for (const e of entries) {
    const list = m.get(e.taskId) ?? [];
    list.push(e);
    m.set(e.taskId, list);
  }
  return m;
}

function shortenPath(p: string): string {
  // Resolve relative to cwd for readability; fall back to absolute.
  const cwd = process.cwd();
  return p.startsWith(cwd) ? `.${p.slice(cwd.length)}` : p;
}

