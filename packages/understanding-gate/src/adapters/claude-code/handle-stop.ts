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
import { PARSE_ERROR_RAW_MAX_BYTES, truncateForLog } from "../error-log.js";

// Anchor at line start with a heading prefix so casual mentions like
// "I'll write an Understanding Report next" don't trigger the parser.
// The full / fast_confirm / grill_me prompts all instruct the agent to
// emit "# Understanding Report" or similar as the report's top-level
// heading.
export const REPORT_MARKER_RE = /^\s*#+\s*understanding\s+report\b/im;
// Re-exported from ../error-log.js (the single source of truth across
// both adapters). Kept here so any external importer that consumed the
// old per-adapter export keeps working.
export {
  PARSE_ERRORS_SUBDIR,
  SYNC_ERRORS_SUBDIR,
} from "../error-log.js";

// fast_confirm mode produces five bullet items with no "Understanding
// Report" heading, so REPORT_MARKER_RE never matches and the harvest
// path silently exits, leaving operators staring at an empty reports/
// dir with no breadcrumb to debug from. Detect attempts by counting the
// five distinct bullet prefixes from src/prompts/fast-confirm.ts.
//
// Threshold 4 (not 3): a natural-English reply that bullets "I will do
// X / I will not touch Y / I will verify by Z" hits 3 by accident — a
// realistic false-positive that would flood parse-errors/ with logs
// that have nothing to do with the gate. Requiring 4 of 5 still tolerates
// one mangled bullet without losing genuine attempts.
const FAST_CONFIRM_BULLETS: ReadonlyArray<RegExp> = [
  /^\s*[-*+]\s*i\s+understood\s+the\s+task\s+as\b/im,
  /^\s*[-*+]\s*i\s+will\s+do\b/im,
  /^\s*[-*+]\s*i\s+will\s+not\s+touch\b/im,
  /^\s*[-*+]\s*i\s+will\s+verify\s+by\b/im,
  /^\s*[-*+]\s*assumptions\b/im,
];
const FAST_CONFIRM_MIN_HITS = 4;

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

/** True when `text` is worth handing to the parser at all. */
export function looksLikeReportAttempt(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  return REPORT_MARKER_RE.test(text) || looksLikeFastConfirmAttempt(text);
}

/**
 * Decide which text the Stop hook feeds to the parser.
 *
 * `last_assistant_message` (0.2.1) is race-free but carries ONLY the
 * final assistant message. An agent that writes its Report and then
 * keeps working (the normal flow: report, tool calls, closing sentence)
 * ends the turn on that closing sentence, so preferring the payload
 * unconditionally meant the transcript walk — which collects the whole
 * trailing assistant run and WOULD find the report — was unreachable,
 * and no report was ever persisted.
 *
 * So: prefer the payload only when it actually looks like a report.
 * That keeps the race fix for the case it was written for (a report as
 * the final message, e.g. under `claude -p`, where the transcript may
 * not have been flushed yet) and reaches for the transcript otherwise.
 * When neither source looks like a report, return whatever text exists
 * so the caller can still take its usual `no_report` exit.
 *
 * Caveat worth knowing: some Claude Code builds do not persist mid-turn
 * assistant text to the transcript at all, in which case no source has
 * the report and nothing can be captured here. The reliable channel is
 * then the operator's approve command (harness task 61fd36db).
 */
export function selectReportText(
  payloadText: string,
  readTranscript: () => string,
): { text: string; source: "payload" | "transcript" | "none" } {
  if (looksLikeReportAttempt(payloadText)) {
    return { text: payloadText, source: "payload" };
  }
  const transcriptText = readTranscript();
  if (looksLikeReportAttempt(transcriptText)) {
    return { text: transcriptText, source: "transcript" };
  }
  const text = payloadText.length > 0 ? payloadText : transcriptText;
  return { text, source: "none" };
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

export function handleStop(
  input: StopHookInput,
  deps: StopHookDeps,
): StopHookOutcome {
  if (isTruthyEnv(input.env.UNDERSTANDING_GATE_DISABLE)) {
    return { kind: "disabled" };
  }

  const text = input.lastAssistantText;
  const hasReportMarker =
    typeof text === "string" && REPORT_MARKER_RE.test(text);
  const hasFastConfirmBullets =
    typeof text === "string" && looksLikeFastConfirmAttempt(text);

  if (!hasReportMarker && !hasFastConfirmBullets) {
    // Cheap escape: not a report and not even a fast_confirm bullet
    // pattern. No further work to do.
    return { kind: "no_report" };
  }
  if (typeof text !== "string" || text.length === 0) {
    return { kind: "no_report" };
  }

  // Adapter-supplied defaults for fields the v0 prompts don't ask the
  // agent to emit. The parser treats an inline `## Metadata` block as
  // authoritative for most fields; approvalStatus is always forced to
  // "pending" by parseReport regardless of what the metadata block contains.
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
    // Bind the report to the session that produced it. The value comes
    // from the hook payload, never from the agent's markdown (the
    // parser's metadata whitelist has no `sessionid` key), so a report
    // cannot claim a session it did not come from. Consumers strict-match
    // on this to decide which report an approval flips.
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
  )}\n\n--- raw ---\n${truncateForLog(text, PARSE_ERROR_RAW_MAX_BYTES)}\n`;
  let logPath = "";
  try {
    logPath = deps.writeParseErrorLog(errorDir, payload);
  } catch (err) {
    // Even the log write failed. Never throw (the harness must not be
    // blocked by the gate's own bookkeeping), but leave a last-resort
    // stderr breadcrumb so a completely-failed artifact write is not pure
    // silence. Guard the breadcrumb itself: stderr can also throw (EPIPE on
    // a closed pipe), and this function's contract is to never throw.
    try {
      console.error(
        `understanding-gate: failed to write parse-error log: ${String(err)}`,
      );
    } catch {
      /* stderr unavailable; nothing more we can safely do */
    }
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
