// Load expected-process baselines from disk.
//
// One JSON file per keyword (domain), shape matches `ExpectedProcess[]`
// from lib.ts so a config edit is a direct edit to the runtime contract.
// Default lookup path: `~/.runtime-reality/expectations/<keyword>.json`,
// overridable via the `RUNTIME_REALITY_EXPECTATIONS_DIR` env var.
//
// Loader is pure-ish (the only IO is the readFile / existsSync); a
// loadErr return code lets the handler keep the fail-open contract
// even when the on-disk state is broken or missing.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExpectedProcess, StartupMode } from "../lib.js";

export interface ExpectationsFile {
  domain: string;
  processes: ExpectedProcess[];
}

export type ExpectationsLoadResult =
  | { ok: true; file: ExpectationsFile }
  | { ok: false; reason: "not_found" | "invalid_json" | "invalid_shape" | "io_error"; detail?: string };

export function defaultExpectationsDir(home: string = homedir()): string {
  return join(home, ".runtime-reality", "expectations");
}

export function expectationsPathFor(keyword: string, dir: string): string {
  // Strict slug guard: keyword is operator-supplied via env / session.
  // Reject anything that could escape the dir (path separators, ..).
  if (!/^[A-Za-z0-9_.-]+$/.test(keyword)) {
    return ""; // caller treats "" as not_found
  }
  return join(dir, `${keyword}.json`);
}

const VALID_STARTUP: readonly StartupMode[] = [
  "systemd",
  "docker",
  "pm2",
  "manual",
  "cron",
  "unknown",
];

function isExpectedProcess(value: unknown): value is ExpectedProcess {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  if (typeof p.name !== "string" || p.name.length === 0) return false;
  if (
    p.expected_startup !== undefined &&
    !VALID_STARTUP.includes(p.expected_startup as StartupMode)
  ) {
    return false;
  }
  if (p.expected_port !== undefined && typeof p.expected_port !== "number") return false;
  return true;
}

export function parseExpectationsFile(raw: string): ExpectationsLoadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: "invalid_json", detail: String(err) };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "invalid_shape", detail: "root is not an object" };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.domain !== "string") {
    return { ok: false, reason: "invalid_shape", detail: "missing domain string" };
  }
  if (!Array.isArray(obj.processes)) {
    return { ok: false, reason: "invalid_shape", detail: "processes is not an array" };
  }
  for (let i = 0; i < obj.processes.length; i += 1) {
    if (!isExpectedProcess(obj.processes[i])) {
      return { ok: false, reason: "invalid_shape", detail: `processes[${i}] invalid` };
    }
  }
  return {
    ok: true,
    file: { domain: obj.domain, processes: obj.processes as ExpectedProcess[] },
  };
}

/** Max bytes we'll read from an expectations JSON. A real file is <10 KB;
 * this cap exists so a runaway `cat /dev/zero >file.json` doesn't OOM
 * the hook and violate the fail-open contract by tarpit. */
export const MAX_EXPECTATIONS_BYTES = 1_048_576; // 1 MiB

export function loadExpectations(
  keyword: string,
  dir: string = defaultExpectationsDir(),
): ExpectationsLoadResult {
  const path = expectationsPathFor(keyword, dir);
  if (path === "" || !existsSync(path)) {
    return { ok: false, reason: "not_found" };
  }
  let raw: string;
  try {
    const stat = statSync(path);
    if (stat.size > MAX_EXPECTATIONS_BYTES) {
      return {
        ok: false,
        reason: "io_error",
        detail: `expectations file exceeds ${MAX_EXPECTATIONS_BYTES} byte cap (was ${stat.size})`,
      };
    }
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { ok: false, reason: "io_error", detail: String(err) };
  }
  return parseExpectationsFile(raw);
}
