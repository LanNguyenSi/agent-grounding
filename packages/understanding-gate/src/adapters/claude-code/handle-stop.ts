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
export const SYNC_ERRORS_SUBDIR = "sync-errors";

// fast_confirm mode produces five bullet items with no "Understanding
// Report" heading, so REPORT_MARKER_RE never matches and the harvest
// path silently exits — leaving operators staring at an empty reports/
// dir with no breadcrumb to debug from. Detect attempts by counting the
// five distinct bullet prefixes from src/prompts/fast-confirm.ts; a
// threshold of three avoids matching a casual "I will do X." reply that
// only happens to share one prefix.
const FAST_CONFIRM_BULLETS: ReadonlyArray<RegExp> = [
  /^\s*[-*+]\s*i\s+understood\s+the\s+task\s+as\b/im,
  /^\s*[-*+]\s*i\s+will\s+do\b/im,
  /^\s*[-*+]\s*i\s+will\s+not\s+touch\b/im,
  /^\s*[-*+]\s*i\s+will\s+verify\s+by\b/im,
  /^\s*[-*+]\s*assumptions\b/im,
];
const FAST_CONFIRM_MIN_HITS = 3;

export function looksLikeFastConfirmAttempt(text: string): boolean {
  let hits = 0;
  for (const re of FAST_CONFIRM_BULLETS) {
    if (re.test(text)) {
      hits += 1;
      if (hits >= FAST_CONFIRM_MIN_HITS) return true;
    }
  }
  return false;
}

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
  | { kind: "no_report"; logPath?: string }
  | {
      kind: "saved";
      path: string;
      written: boolean;
      report: UnderstandingReport;
    }
  | { kind: "parse_error"; logPath: string; error: ParseError };

const PREVIEW_CHARS = 200;

export function handleStop(
  input: StopHookInput,
  deps: StopHookDeps,
): StopHookOutcome {
  if (isTruthyEnv(input.env.UNDERSTANDING_GATE_DISABLE)) {
    return { kind: "disabled" };
  }

  const text = input.lastAssistantText;
  if (typeof text !== "string" || !REPORT_MARKER_RE.test(text)) {
    // Cheap escape hatch for the common case (any non-report turn) before
    // the more expensive bullet-pattern probe.
    if (typeof text !== "string" || text.length === 0) {
      return { kind: "no_report" };
    }
    if (!looksLikeFastConfirmAttempt(text)) {
      return { kind: "no_report" };
    }
    // The agent emitted what looks like a fast_confirm response but
    // without the heading the marker regex requires. The harvest path
    // can't persist it, but the operator deserves a breadcrumb instead
    // of an empty reports/ dir.
    const stamp = deps.now().toISOString().replace(/[:.]/g, "-");
    const payload = `${JSON.stringify(
      {
        reason: "no_marker_fast_confirm_attempt",
        mode: normaliseMode(input.env.UNDERSTANDING_GATE_MODE) ?? "fast_confirm",
        textLength: text.length,
        preview: text.slice(0, PREVIEW_CHARS),
        stamp,
        sessionId: input.sessionId,
        hint:
          "fast_confirm bullets matched but the '# Understanding Report' " +
          "heading required by handle-stop.ts is missing — the prompt " +
          "snippet uses '# Fast Confirm Mode'. Either switch to grill_me " +
          "(emits the required heading + sections) or accept that " +
          "fast_confirm relies on the .pending-approval marker alone.",
      },
      null,
      2,
    )}\n\n--- raw ---\n${text}\n`;
    let logPath: string | undefined;
    try {
      logPath = deps.writeParseErrorLog(input.parseErrorDir, payload);
    } catch {
      // even the log write failed; degrade to silent no_report.
    }
    return logPath ? { kind: "no_report", logPath } : { kind: "no_report" };
  }

  // Adapter-supplied defaults for fields the v0 prompts don't ask the
  // agent to emit. The parser still treats an inline `## Metadata` block
  // as authoritative when present.
  const defaults: ParseDefaults = {
    taskId: input.env.UNDERSTANDING_GATE_TASK_ID || input.sessionId,
    createdAt: deps.now().toISOString(),
    mode: "fast_confirm",
    riskLevel: "medium",
  };
  const mode = normaliseMode(input.env.UNDERSTANDING_GATE_MODE);
  if (mode) defaults.mode = mode;

  const result = deps.parseReport(text, defaults);
  if (result.ok) {
    const saveOpts = saveOptionsFromInput(input);
    const saved = deps.saveReport(result.report, saveOpts);
    return {
      kind: "saved",
      path: saved.path,
      written: saved.written,
      report: result.report,
    };
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
