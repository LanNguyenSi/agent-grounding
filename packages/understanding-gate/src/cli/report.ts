// `understanding-gate report` subcommands. Thin wrappers over the
// persistence module; all formatting (table / json) lives here.

import {
  listReports,
  loadReport,
  resolveReportDir,
  type ReportEntry,
} from "../core/persistence.js";

export type ReportListResult = {
  exitCode: 0 | 1;
  stdout: string;
  stderr: string;
};

export function runReportList(opts: {
  dir?: string;
  json?: boolean;
  cwd?: string;
}): ReportListResult {
  const entries = listReports({ dir: opts.dir, cwd: opts.cwd });
  if (opts.json) {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify(entries, null, 2)}\n`,
      stderr: "",
    };
  }
  if (entries.length === 0) {
    const dir = resolveReportDir({ dir: opts.dir, cwd: opts.cwd });
    return {
      exitCode: 0,
      stdout: `understanding-gate: no reports under ${dir}\n`,
      stderr: "",
    };
  }
  return {
    exitCode: 0,
    stdout: formatTable(entries),
    stderr: "",
  };
}

export function runReportShow(opts: {
  id: string;
  dir?: string;
  cwd?: string;
}): ReportListResult {
  const result = loadReport(opts.id, { dir: opts.dir, cwd: opts.cwd });
  if (!result.ok) {
    return {
      exitCode: 1,
      stdout: "",
      stderr: `understanding-gate: ${result.error.message}\n`,
    };
  }
  return {
    exitCode: 0,
    stdout: `${JSON.stringify(result.report, null, 2)}\n`,
    stderr: "",
  };
}

function formatTable(entries: ReportEntry[]): string {
  const header = ["createdAt", "taskId", "mode", "risk", "status"];
  const rows = entries.map((e) => [
    e.createdAt || "(unknown)",
    e.taskId,
    e.mode,
    e.riskLevel,
    e.approvalStatus,
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  const lines = [fmt(header), fmt(widths.map((w) => "-".repeat(w)))];
  for (const r of rows) lines.push(fmt(r));
  return `${lines.join("\n")}\n`;
}
