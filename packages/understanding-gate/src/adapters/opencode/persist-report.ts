// Pure handler for the opencode `message.updated` event.
//
// The plugin entrypoint (persist-report-plugin.ts) fetches the assistant
// message's text parts via the opencode client and hands them here. This
// module:
//   1. Bails fast on missing report marker.
//   2. Runs parseReport with caller-supplied defaults.
//   3. On success, saveReport.
//   4. On parse failure, side-channel parse-error log so dogfood evidence
//      is never lost.
//
// Shape mirrors handle-stop.ts exactly, on purpose — opencode and
// claude-code disagree on transport (in-process plugin vs binary) but
// agree on every step after "we extracted the assistant text".

import type { UnderstandingReport } from "../../schema/types.js";
import type {
  ParseDefaults,
  ParseError,
  ParseResult,
} from "../../core/parser.js";
import type {
  SaveOptions,
  SaveResult,
} from "../../core/persistence.js";
import { PARSE_ERROR_RAW_MAX_BYTES, truncateForLog } from "../error-log.js";

export const REPORT_MARKER_RE = /^\s*#+\s*understanding\s+report\b/im;
// Re-exported from ../error-log.js (the single source of truth across
// both adapters). Kept here so any external importer that consumed the
// old per-adapter export keeps working.
export {
  PARSE_ERRORS_SUBDIR,
  SYNC_ERRORS_SUBDIR,
} from "../error-log.js";

export interface PersistReportDeps {
  parseReport: (markdown: string, defaults?: ParseDefaults) => ParseResult;
  saveReport: (report: UnderstandingReport, opts?: SaveOptions) => SaveResult;
  /** Atomic write side-channel. Returns the path written. */
  writeParseErrorLog: (dir: string, payload: string) => string;
  /** "now" injection for parse-error filename + report.createdAt fallback. */
  now: () => Date;
}

export interface PersistReportEnv {
  UNDERSTANDING_GATE_DISABLE?: string;
  UNDERSTANDING_GATE_TASK_ID?: string;
  UNDERSTANDING_GATE_MODE?: string;
  UNDERSTANDING_GATE_REPORT_DIR?: string;
}

export interface PersistReportInput {
  /** Concatenated text content of the most recent assistant message. */
  lastAssistantText: string;
  /** Working directory of the opencode session (from PluginInput.directory). */
  cwd: string;
  /** opencode session id, used as taskId fallback. */
  sessionId: string;
  /** Directory where parse-error logs go; plugin shim computes from cwd/env. */
  parseErrorDir: string;
  /** Hook env (process.env subset). */
  env: PersistReportEnv;
}

export type PersistReportOutcome =
  | { kind: "disabled" }
  | { kind: "no_report" }
  | {
      kind: "saved";
      path: string;
      written: boolean;
      report: UnderstandingReport;
    }
  | { kind: "parse_error"; logPath: string; error: ParseError };

export function handlePersistReport(
  input: PersistReportInput,
  deps: PersistReportDeps,
): PersistReportOutcome {
  if (isTruthyEnv(input.env.UNDERSTANDING_GATE_DISABLE)) {
    return { kind: "disabled" };
  }

  const text = input.lastAssistantText;
  if (typeof text !== "string" || !REPORT_MARKER_RE.test(text)) {
    return { kind: "no_report" };
  }

  // Adapter-supplied defaults for fields the v0 prompts don't ask the
  // agent to emit. The parser treats an inline `## Metadata` block as
  // authoritative for most fields, but approvalStatus is exempt: parseReport
  // hard-resets it to "pending" so only the operator CLI can approve.
  // taskId is bound via `boundTaskId`, not `taskId`: it must win over an
  // agent-authored `taskid` key in the report's own Metadata block (see the
  // taskId binding comment in parser.ts, agent-tasks 2078873e).
  const defaults: ParseDefaults = {
    boundTaskId: input.env.UNDERSTANDING_GATE_TASK_ID || input.sessionId,
    createdAt: deps.now().toISOString(),
    mode: "fast_confirm",
    riskLevel: "medium",
  };
  const mode = normaliseMode(input.env.UNDERSTANDING_GATE_MODE);
  if (mode) defaults.mode = mode;

  const result = deps.parseReport(text, defaults);
  if (result.ok) {
    // Same session binding as the Claude Code adapter (handle-stop.ts):
    // taken from the runtime, never from the agent's markdown. Kept in
    // lockstep so a consumer's strict sessionId match behaves the same
    // under both runtimes.
    // saveReport does not re-validate, so guard the field's schema
    // contract (string, minLength 1) here rather than persist a value
    // that the schema would reject.
    const report: UnderstandingReport =
      typeof input.sessionId === "string" && input.sessionId.length > 0
        ? { ...result.report, sessionId: input.sessionId }
        : result.report;
    const saveOpts = saveOptionsFromInput(input);
    const saved = deps.saveReport(report, saveOpts);
    return {
      kind: "saved",
      path: saved.path,
      written: saved.written,
      report,
    };
  }

  const stamp = deps.now().toISOString().replace(/[:.]/g, "-");
  const payload = `${JSON.stringify(
    {
      reason: result.error.reason,
      missing: result.error.missing,
      malformedSections: result.error.malformedSections ?? [],
      schemaErrors: result.error.schemaErrors,
      message: result.error.message,
      stamp,
      sessionId: input.sessionId,
      adapter: "opencode",
    },
    null,
    2,
  )}\n\n--- raw ---\n${truncateForLog(text, PARSE_ERROR_RAW_MAX_BYTES)}\n`;
  let logPath = "";
  try {
    logPath = deps.writeParseErrorLog(input.parseErrorDir, payload);
  } catch {
    // Even the log write failed; swallow per "never block the harness".
  }
  return { kind: "parse_error", logPath, error: result.error };
}

// --- helpers ------------------------------------------------------------

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function normaliseMode(
  raw: string | undefined,
): "fast_confirm" | "grill_me" | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if (v === "fast_confirm" || v === "grill_me") return v;
  return null;
}

function saveOptionsFromInput(input: PersistReportInput): SaveOptions {
  if (input.env.UNDERSTANDING_GATE_REPORT_DIR) return {};
  return { cwd: input.cwd };
}
