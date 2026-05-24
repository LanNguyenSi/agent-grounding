// Shared error-log helpers for the Stop / persist-report adapters.
//
// The claude-code Stop binary (adapters/claude-code/stop.ts) and the
// opencode persist-report plugin (adapters/opencode/persist-report-plugin.ts)
// both drop side-channel log files for parse failures and post-save
// hypothesis-sync failures under `<cwd>/.understanding-gate/<subdir>/`
// (or `dirname($UNDERSTANDING_GATE_REPORT_DIR)/<subdir>/` when the env
// override is set). Both directory resolution and the stamped-filename
// writer are byte-equivalent across the two adapters; this module is
// the single source of truth so a future fix lands in one place.
//
// Importers: `adapters/claude-code/stop.ts`, `adapters/opencode/persist-report-plugin.ts`.
// `handle-stop.ts` (claude-code) and `persist-report.ts` (opencode)
// re-export the SUBDIR constants from here so any external caller that
// imported the per-adapter copy keeps working.

import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { writeAtomicText } from "../core/fs.js";

export const PARSE_ERRORS_SUBDIR = "parse-errors";
export const SYNC_ERRORS_SUBDIR = "sync-errors";

/**
 * Minimal env shape both adapters' env types satisfy. Kept narrow so a
 * test or future caller can supply only what's read here rather than a
 * full StopHookEnv / PersistReportEnv shape.
 */
export interface ErrorLogEnv {
  UNDERSTANDING_GATE_REPORT_DIR?: string;
}

/**
 * Resolve the on-disk directory for a stamped error log. Honours
 * `$UNDERSTANDING_GATE_REPORT_DIR` (treated as a sibling of the reports
 * dir, so `<reports>/../<subdir>`) and falls back to
 * `<cwd>/.understanding-gate/<subdir>` otherwise.
 */
export function resolveErrorDir(
  cwd: string,
  env: ErrorLogEnv,
  subdir: string,
): string {
  const reportDirEnv = env.UNDERSTANDING_GATE_REPORT_DIR;
  if (reportDirEnv && reportDirEnv.length > 0) {
    return resolve(dirname(reportDirEnv), subdir);
  }
  return resolve(cwd, ".understanding-gate", subdir);
}

/**
 * Cap for the `--- raw ---` section of parse-error logs. A runaway agent
 * emitting MBs of assistant text would otherwise write MBs to disk on
 * every parse failure. 64 KiB is enough to surface the report's failing
 * section in operator debugging.
 */
export const PARSE_ERROR_RAW_MAX_BYTES = 64 * 1024;

/**
 * Truncate `text` to at most `maxBytes` UTF-8 bytes and append a marker
 * with the byte count that was dropped. Bytes — not characters — because
 * the goal is bounding on-disk size.
 *
 * Byte slicing can land mid-UTF-8-sequence. `Buffer.subarray(...).toString("utf8")`
 * replaces the trailing partial sequence with U+FFFD rather than stripping
 * it; the `overflow` count is still measured against the original
 * `byteLength` so the marker stays byte-accurate.
 */
export function truncateForLog(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  const overflow = buf.byteLength - maxBytes;
  const truncated = buf.subarray(0, maxBytes).toString("utf8");
  return `${truncated}\n[truncated ${overflow} more bytes]`;
}

/**
 * Atomic stamped-log writer. Filename is
 * `<ISO-timestamp>-<6-hex-bytes>.log`. Returns the absolute path so the
 * caller can surface it (e.g. for tests or operator inspection).
 */
export function writeStampedLog(dir: string, payload: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${stamp}-${randomBytes(3).toString("hex")}.log`;
  const path = join(dir, filename);
  writeAtomicText(path, payload);
  return path;
}
