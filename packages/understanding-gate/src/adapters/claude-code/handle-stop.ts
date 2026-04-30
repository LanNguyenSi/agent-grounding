// Pure handler for the Claude Code `Stop` hook.
//
// The binary at stop.ts reads the JSONL transcript, extracts the most
// recent assistant message text, and passes it here. This module:
//   1. Bails fast if the text doesn't look like a Report (no marker).
//   2. Runs parseReport with caller-supplied defaults (taskId from env,
//      mode from env if set).
//   3. On parse success, calls saveReport.
//   4. On parse failure, writes a side-channel parse-error log under
//      <reportDir>/../parse-errors/ so dogfood evidence is never lost.
//
// All filesystem effects go through deps so tests can stub them. Returns
// a structured outcome; never throws (the binary's last-resort guard
// degrades to "exit 0 silent" anyway, but the typed outcome makes the
// behaviour explicit at the source level).

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

// Anchor at line start with a heading prefix so casual mentions like
// "I'll write an Understanding Report next" don't trigger the parser.
// The full / fast_confirm / grill_me prompts all instruct the agent to
// emit "# Understanding Report" or similar as the report's top-level
// heading.
export const REPORT_MARKER_RE = /^\s*#+\s*understanding\s+report\b/im;
export const PARSE_ERRORS_SUBDIR = "parse-errors";

export interface StopHookDeps {
  parseReport: (markdown: string, defaults?: ParseDefaults) => ParseResult;
  saveReport: (report: UnderstandingReport, opts?: SaveOptions) => SaveResult;
  /** Atomic write side-channel. Returns the path written. */
  writeParseErrorLog: (
    dir: string,
    payload: string,
  ) => string;
  /** "now" injection for parse-error filename + report.createdAt fallback. */
  now: () => Date;
}

export interface StopHookEnv {
  UNDERSTANDING_GATE_DISABLE?: string;
  UNDERSTANDING_GATE_TASK_ID?: string;
  UNDERSTANDING_GATE_MODE?: string;
  UNDERSTANDING_GATE_REPORT_DIR?: string;
}

export interface StopHookInput {
  /** Concatenated text content of the most recent assistant message. */
  lastAssistantText: string;
  /** Working directory of the claude-code session (from hook payload). */
  cwd: string;
  /** Session id from the hook payload, used as taskId fallback. */
  sessionId: string;
  /** Directory where parse-error logs go; binary computes from cwd/env. */
  parseErrorDir: string;
  /** Hook env (process.env subset). */
  env: StopHookEnv;
}

export type StopHookOutcome =
  | { kind: "disabled" }
  | { kind: "no_report" }
  | { kind: "saved"; path: string; written: boolean }
  | { kind: "parse_error"; logPath: string; error: ParseError };

export function handleStop(
  input: StopHookInput,
  deps: StopHookDeps,
): StopHookOutcome {
  if (isTruthyEnv(input.env.UNDERSTANDING_GATE_DISABLE)) {
    return { kind: "disabled" };
  }

  const text = input.lastAssistantText;
  if (typeof text !== "string" || !REPORT_MARKER_RE.test(text)) {
    return { kind: "no_report" };
  }

  const defaults: ParseDefaults = {
    taskId: input.env.UNDERSTANDING_GATE_TASK_ID || input.sessionId,
    createdAt: deps.now().toISOString(),
  };
  const mode = normaliseMode(input.env.UNDERSTANDING_GATE_MODE);
  if (mode) defaults.mode = mode;

  const result = deps.parseReport(text, defaults);
  if (result.ok) {
    const saveOpts = saveOptionsFromInput(input);
    const saved = deps.saveReport(result.report, saveOpts);
    return { kind: "saved", path: saved.path, written: saved.written };
  }

  // Parse failure: keep the raw text + error in a side-channel log so we
  // can debug why a Report was rejected. Best-effort.
  const errorDir = input.parseErrorDir;
  const stamp = deps.now().toISOString().replace(/[:.]/g, "-");
  const payload = `${JSON.stringify(
    {
      reason: result.error.reason,
      missing: result.error.missing,
      schemaErrors: result.error.schemaErrors,
      message: result.error.message,
      stamp,
      sessionId: input.sessionId,
    },
    null,
    2,
  )}\n\n--- raw ---\n${text}\n`;
  let logPath = "";
  try {
    logPath = deps.writeParseErrorLog(errorDir, payload);
  } catch {
    // even the log write failed; swallow per "never block the harness".
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

function saveOptionsFromInput(input: StopHookInput): SaveOptions {
  if (input.env.UNDERSTANDING_GATE_REPORT_DIR) return {};
  return { cwd: input.cwd };
}
