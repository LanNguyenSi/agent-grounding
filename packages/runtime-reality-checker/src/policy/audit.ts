// Append-only JSONL audit log for the runtime-reality PreToolUse policy.
// Modeled on the understanding-gate audit pattern (see
// packages/understanding-gate/src/core/audit.ts), kept local rather than
// imported to avoid creating a runtime dependency edge between two
// sibling policy packages.
//
// Append semantics: a single fs.appendFileSync per call. JSONL means
// callers can `tail -f` or stream-parse the log; a partial last line
// is recoverable by skipping it. Writes under PIPE_BUF (4 KiB on Linux)
// are atomic with O_APPEND, so concurrent hook invocations typically
// interleave at line granularity rather than within a JSON record.
// Typical audit lines are a few hundred bytes; a critical-tier event
// whose `reason` enumerates drift across many processes can exceed
// PIPE_BUF, and on that path two concurrent writes may tear. The cost
// is a corrupted line that `tail -f` users skip, never a lost record
// or a crashed hook. Cap or rotate downstream if strict atomicity is
// needed.
//
// Failure mode: best-effort. The default writer catches every error and
// drops the audit line. The PreToolUse policy ALWAYS degrades to allow
// on internal failure, the audit pipe must never invert that contract.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const AUDIT_LOG_FILENAME = "audit.log";

export type AuditEventKind =
  | "disabled"
  | "skip-noprobe"
  | "probe-fail"
  | "warn"
  | "block";

// Which severity tier the underlying check produced, if any. `null` for
// non-drift kinds (disabled, skip-noprobe, probe-fail) and for the rare
// case where the policy decides without consulting the drift list.
export type AuditSeverity = "warning" | "critical" | null;

// Snapshot of every operator-facing env knob the handler honored on
// this call. Recording the knob STATE rather than just the names lets a
// later query distinguish "knob unset" from "knob present but ignored
// because the decision branch didn't reach it".
export interface AuditEnvOverrides {
  disable: boolean;
  warn_as_block: boolean;
  critical_as_warn: boolean;
  probe_fail_block: boolean;
}

export interface AuditEvent {
  kind: AuditEventKind;
  iso_timestamp: string;
  keyword: string | null;
  tool_name: string | null;
  command: string | null;
  trigger_category: string | null;
  drift_count: number;
  severity: AuditSeverity;
  env_overrides_applied: AuditEnvOverrides;
  reason: string;
}

export type AppendAudit = (event: AuditEvent) => void;

export function formatAuditLine(event: AuditEvent): string {
  return `${JSON.stringify(event)}\n`;
}

// Default location: <RUNTIME_REALITY_AUDIT_LOG> if set, else
// ~/.runtime-reality/audit.log. The env override accepts absolute or
// relative paths (relative is resolved against the process cwd, same
// as every other env-driven path in this package).
export function resolveDefaultAuditLogPath(env: NodeJS.ProcessEnv): string {
  const override = env.RUNTIME_REALITY_AUDIT_LOG?.trim();
  if (override) return resolve(override);
  return join(homedir(), ".runtime-reality", AUDIT_LOG_FILENAME);
}

// Build a writer that appends to `logPath`. Errors are swallowed,
// rationale in the file-level comment. Callers wire this up at the
// CLI boundary; tests inject their own capture function.
export function createJsonlAuditWriter(logPath: string): AppendAudit {
  return (event) => {
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, formatAuditLine(event), { encoding: "utf8" });
    } catch {
      // best-effort, see file-level comment
    }
  };
}
