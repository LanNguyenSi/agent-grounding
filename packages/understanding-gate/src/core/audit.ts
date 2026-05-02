// Append-only JSONL audit log for Phase 2 enforcement. Every block,
// approval, revoke and force-bypass lands here so dogfood and incident
// review can reconstruct what the gate did.
//
// Append semantics: a single fs.appendFileSync per call. JSONL means
// callers can `tail -f` or stream-parse the log; a partial last line
// (very rare on POSIX append) is recoverable by skipping it. Writes
// under `PIPE_BUF` (4 KiB on Linux) are atomic with `O_APPEND`, so
// concurrent hook invocations interleave at line granularity rather
// than producing torn JSON. Audit lines are short (a few hundred
// bytes) so this holds in practice; oversized reasons could split
// only under pathological conditions.
//
// Trust boundary: the hook adapters resolve the audit-log path from
// `payload.cwd` (the cwd the harness reports) without validation.
// That's safe under the operative threat model: Claude Code and
// opencode are trusted by construction (they own the hook process's
// effective cwd via OS-level boundaries), and a compromised harness
// can already do anything this process can do regardless. If you
// need stricter sandboxing, drive cwd from a secrets store or run
// the gate inside a container with a fixed working directory.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const AUDIT_LOG_FILENAME = "audit.log";

export type AuditEvent =
  | {
      kind: "block";
      tool: string;
      reason: string;
      sessionId: string | null;
      taskId: string | null;
      adapter: "claude-code" | "opencode";
    }
  | {
      kind: "approve";
      approvedBy: "cli" | "marker_phrase" | "agent";
      sessionId: string | null;
      taskId: string;
      reportPath: string;
    }
  | {
      kind: "revoke";
      sessionId: string | null;
      taskId: string;
      reportPath: string;
    }
  | {
      kind: "force_bypass";
      tool: string;
      reason: string;
      sessionId: string | null;
      taskId: string | null;
      adapter: "claude-code" | "opencode";
    };

export function formatAuditLine(event: AuditEvent, now: Date = new Date()): string {
  return `${JSON.stringify({ at: now.toISOString(), ...event })}\n`;
}

// Best-effort append. Failures bubble (CLI surfaces them); the harness
// adapters wrap calls in try/catch so a broken disk never crashes the
// hook. Path resolution is the caller's concern; pass an absolute path.
export function appendAuditLine(
  logPath: string,
  event: AuditEvent,
  now: Date = new Date(),
): void {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, formatAuditLine(event, now), { encoding: "utf8" });
}

// Default location: <cwd>/.understanding-gate/audit.log. Mirrors the
// reports/ + parse-errors/ directory layout already in use.
export function defaultAuditLogPath(cwd: string): string {
  return resolve(cwd, ".understanding-gate", AUDIT_LOG_FILENAME);
}
