#!/usr/bin/env node
// Thin entrypoint for the Claude Code Stop hook. Reads stdin, locates the
// transcript, extracts the most recent assistant text, and runs the pure
// handler. All error paths exit 0 so the hook never blocks the harness.

import { readStdin } from "../io.js";
import { parseReport } from "../../core/parser.js";
import { saveReport } from "../../core/persistence.js";
import {
  PARSE_ERRORS_SUBDIR,
  SYNC_ERRORS_SUBDIR,
  resolveErrorDir,
  writeStampedLog,
} from "../error-log.js";
import { runSyncAndLog } from "../sync-and-log.js";
import { handleStop, selectReportText, type StopHookEnv } from "./handle-stop.js";
import { extractLastAssistantText } from "./transcript.js";

interface StopHookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  // 0.2.1: newer Claude Code releases ship the final assistant text
  // directly in the payload. Reading it sidesteps a race where Stop
  // fires before the transcript JSONL has been flushed (observed
  // under `claude -p`, where the report often hadn't landed on disk
  // yet when the hook ran). Fall back to the transcript file when
  // the field is missing (older harnesses).
  last_assistant_message?: string;
}

async function main(): Promise<void> {
  let raw = "";
  try {
    raw = await readStdin();
  } catch {
    return;
  }

  const payload = parsePayload(raw);
  if (!payload) return;

  const cwd = payload.cwd ?? process.cwd();
  const sessionId = payload.session_id ?? "claude-code-session";

  // Source selection (see selectReportText): the payload's
  // `last_assistant_message` wins only when it looks like a report, so
  // a report written mid-turn is still found by walking the transcript.
  // The transcript is read lazily, so the race-free payload fast path
  // costs no file IO. `last_assistant_message: ""` is treated as "field
  // not provided" rather than "persist nothing".
  const payloadText =
    typeof payload.last_assistant_message === "string"
      ? payload.last_assistant_message
      : "";
  const { text: lastAssistantText } = selectReportText(payloadText, () =>
    payload.transcript_path ? extractLastAssistantText(payload.transcript_path) : "",
  );
  if (!lastAssistantText) return;

  const env: StopHookEnv = {
    UNDERSTANDING_GATE_DISABLE: process.env.UNDERSTANDING_GATE_DISABLE,
    UNDERSTANDING_GATE_TASK_ID: process.env.UNDERSTANDING_GATE_TASK_ID,
    UNDERSTANDING_GATE_MODE: process.env.UNDERSTANDING_GATE_MODE,
    UNDERSTANDING_GATE_REPORT_DIR: process.env.UNDERSTANDING_GATE_REPORT_DIR,
  };

  const parseErrorDir = resolveParseErrorDir(cwd, env);

  const outcome = handleStop(
    {
      lastAssistantText,
      cwd,
      sessionId,
      parseErrorDir,
      env,
    },
    {
      parseReport,
      saveReport,
      writeParseErrorLog,
      now: () => new Date(),
    },
  );

  // Phase 1.5: register the report's assumptions + open questions in
  // the hypothesis-tracker store. Best-effort; failure does not affect
  // the saved report file but lands a side-channel log so dogfood can
  // see what went wrong without breaking the silent-exit-0 stance.
  if (outcome.kind === "saved") {
    runSyncAndLog(outcome.report, outcome.path, sessionId, {
      resolveSyncErrorDir: () => resolveSyncErrorDir(cwd, env),
      writeSyncErrorLog,
    });
  }
}

function parsePayload(raw: string): StopHookPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as StopHookPayload;
  } catch {
    return null;
  }
}

function resolveParseErrorDir(cwd: string, env: StopHookEnv): string {
  return resolveErrorDir(cwd, env, PARSE_ERRORS_SUBDIR);
}

function resolveSyncErrorDir(cwd: string, env: StopHookEnv): string {
  return resolveErrorDir(cwd, env, SYNC_ERRORS_SUBDIR);
}

function writeParseErrorLog(dir: string, payload: string): string {
  return writeStampedLog(dir, payload);
}

function writeSyncErrorLog(dir: string, payload: string): string {
  return writeStampedLog(dir, payload);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `understanding-gate claude-code stop hook failed silently: ${String(err)}\n`,
  );
});
