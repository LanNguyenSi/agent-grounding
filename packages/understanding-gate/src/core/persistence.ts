// Local fs persistence for parsed Understanding Reports. Adapter code
// (Phase 1.3 / 1.4) calls saveReport when the agent emits a Report; the
// CLI calls listReports / loadReport for inspection.
//
// Layout: <dir>/<isoDateTime>-<slug>.json. <dir> defaults to
// `.understanding-gate/reports/` under cwd; the env var
// UNDERSTANDING_GATE_REPORT_DIR overrides.
//
// Writes are atomic (write tmp file, fsync, rename) so a crash mid-write
// never leaves a partial file. Saves are idempotent on byte-identical
// content keyed by taskId — a re-emit of the same report does not bump
// the file mtime or create a duplicate.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { writeAtomicText } from "./fs.js";
import { UNDERSTANDING_REPORT_SCHEMA } from "../schema/report-schema.js";
import type { UnderstandingReport } from "../schema/types.js";

export const DEFAULT_REPORT_DIR = ".understanding-gate/reports";
export const REPORT_DIR_ENV = "UNDERSTANDING_GATE_REPORT_DIR";

export type SaveOptions = {
  /** Override the report dir. Beats env. */
  dir?: string;
  /** Override cwd when resolving the default dir. */
  cwd?: string;
  /** Override "now" for filename generation. Pure-test hook. */
  now?: Date;
};

export type SaveResult = { path: string; written: boolean };

export type ReportEntry = {
  path: string;
  taskId: string;
  mode: UnderstandingReport["mode"];
  riskLevel: UnderstandingReport["riskLevel"];
  approvalStatus: UnderstandingReport["approvalStatus"];
  createdAt: string;
};

export type ListOptions = { dir?: string; cwd?: string };

export function resolveReportDir(opts: ListOptions = {}): string {
  if (opts.dir) return resolve(opts.dir);
  const fromEnv = process.env[REPORT_DIR_ENV];
  if (fromEnv && fromEnv.length > 0) return resolve(fromEnv);
  const cwd = opts.cwd ?? process.cwd();
  return resolve(cwd, DEFAULT_REPORT_DIR);
}

export function saveReport(
  report: UnderstandingReport,
  opts: SaveOptions = {},
): SaveResult {
  const dir = resolveReportDir(opts);
  mkdirSync(dir, { recursive: true });

  const slug = sanitizeSlug(report.taskId) || "report";
  const json = canonicalJSON(report);

  // Idempotency: a file with the same taskId AND byte-identical canonical
  // JSON already on disk -> no-op. We scan only filenames ending in
  // "-<slug>.json" to keep the cost bounded.
  const existing = findExistingByContent(dir, slug, json);
  if (existing) {
    return { path: existing, written: false };
  }

  const isoStamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const filename = `${isoStamp}-${slug}.json`;
  const finalPath = join(dir, filename);

  writeAtomicText(finalPath, json);
  return { path: finalPath, written: true };
}

export function listReports(opts: ListOptions = {}): ReportEntry[] {
  const dir = resolveReportDir(opts);
  if (!existsSync(dir)) return [];
  const entries: ReportEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    let parsed: UnderstandingReport;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as UnderstandingReport;
    } catch {
      continue; // skip files we can't parse rather than crashing the listing
    }
    entries.push({
      path,
      taskId: parsed.taskId,
      mode: parsed.mode,
      riskLevel: parsed.riskLevel,
      approvalStatus: parsed.approvalStatus,
      createdAt: parsed.createdAt ?? "",
    });
  }
  entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return entries;
}

export type LoadError = { reason: "not_found" | "parse_error"; message: string };
export type LoadResult =
  | { ok: true; report: UnderstandingReport; path: string }
  | { ok: false; error: LoadError };

export function loadReport(
  idOrPath: string,
  opts: ListOptions = {},
): LoadResult {
  const path = resolveLoadPath(idOrPath, opts);
  if (!path) {
    return {
      ok: false,
      error: { reason: "not_found", message: `No report matching "${idOrPath}"` },
    };
  }
  try {
    const report = JSON.parse(
      readFileSync(path, "utf8"),
    ) as UnderstandingReport;
    return { ok: true, report, path };
  } catch (err) {
    return {
      ok: false,
      error: {
        reason: "parse_error",
        message: `Failed to parse ${path}: ${(err as Error).message}`,
      },
    };
  }
}

// --- internals ----------------------------------------------------------

function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// Stable JSON: keys serialize in the order they appear in
// UNDERSTANDING_REPORT_SCHEMA.properties. Sourcing this from the schema
// (the single source of truth for the on-wire shape) means a future
// schema field cannot be silently stripped from persisted reports
// because someone forgot to update a parallel list here.
const KEY_ORDER: readonly (keyof UnderstandingReport)[] = Object.keys(
  UNDERSTANDING_REPORT_SCHEMA.properties,
) as (keyof UnderstandingReport)[];

function canonicalJSON(report: UnderstandingReport): string {
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
    if (report[key] !== undefined) {
      ordered[key] = report[key];
    }
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function findExistingByContent(
  dir: string,
  slug: string,
  desired: string,
): string | null {
  if (!existsSync(dir)) return null;
  const suffix = `-${slug}.json`;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(suffix)) continue;
    const path = join(dir, name);
    let actual: string;
    try {
      actual = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    if (actual === desired) return path;
  }
  return null;
}


function resolveLoadPath(idOrPath: string, opts: ListOptions): string | null {
  if (isAbsolute(idOrPath)) {
    return existsSync(idOrPath) ? idOrPath : null;
  }

  const dir = resolveReportDir(opts);
  if (!existsSync(dir)) return null;

  // Direct filename match.
  const direct = join(dir, idOrPath);
  if (existsSync(direct)) return direct;

  // Treat idOrPath as a taskId; pick the most recent matching file.
  const slug = sanitizeSlug(idOrPath);
  const suffix = `-${slug}.json`;
  const matches = readdirSync(dir)
    .filter((n) => n.endsWith(suffix))
    .sort()
    .reverse();
  if (matches.length > 0) return join(dir, matches[0]);

  // Fallback: scan for a file whose JSON has the literal taskId.
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      const r = JSON.parse(readFileSync(path, "utf8")) as UnderstandingReport;
      if (r.taskId === idOrPath) return path;
    } catch {
      continue;
    }
  }
  return null;
}
