// opencode plugin entry point. Hooks the runtime `event` channel and
// auto-persists Understanding Reports emitted by assistant messages.
//
// All runtime types are imported with `import type` so the package's dist
// has no runtime dependency on @opencode-ai/* — only a structural type
// dependency at build time.
//
// Loading: opencode reads its `plugin` config and imports each entry. The
// `init --target opencode` command writes a shim file at
// `.opencode/plugin/understanding-gate-persist-report.ts` that re-exports
// the function below as default. The user adds an entry to `opencode.json`
// pointing at that file (documented in the printed init message).

import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { parseReport } from "../../core/parser.js";
import { saveReport } from "../../core/persistence.js";
import { syncHypothesesFromReport } from "../../core/hypothesis-sync.js";
import { writeAtomicText } from "../../core/fs.js";
import {
  PARSE_ERRORS_SUBDIR,
  SYNC_ERRORS_SUBDIR,
  handlePersistReport,
  type PersistReportEnv,
} from "./persist-report.js";
import type {
  OpencodeHooks,
  OpencodePlugin,
  OpencodePluginInput,
} from "./opencode-types.js";
import { extractAssistantText } from "./extract.js";

export const persistReportPlugin: OpencodePlugin = async (
  ctx: OpencodePluginInput,
): Promise<OpencodeHooks> => {
  return {
    event: async ({ event }) => {
      if (event.type !== "message.updated") return;
      const properties = (event as { properties?: unknown }).properties;
      const info =
        properties && typeof properties === "object"
          ? (properties as { info?: { role?: string; finish?: string; sessionID?: string; id?: string } }).info
          : undefined;
      if (!info || info.role !== "assistant") return;
      // Only act when the assistant message has terminated; intermediate
      // updates would re-parse half-formed reports on every part flush.
      if (!info.finish) return;
      if (!info.sessionID || !info.id) return;

      // Fetch the message + parts so we have the full assistant text.
      // Errors are swallowed: a plugin throw would surface in opencode's
      // diagnostic stream, which is exactly the noise we promised to avoid.
      let text = "";
      try {
        const result = await ctx.client.session.message({
          path: { id: info.sessionID, messageID: info.id },
        });
        text = extractAssistantText(result);
      } catch {
        return;
      }
      if (!text) return;

      const env: PersistReportEnv = {
        UNDERSTANDING_GATE_DISABLE: process.env.UNDERSTANDING_GATE_DISABLE,
        UNDERSTANDING_GATE_TASK_ID: process.env.UNDERSTANDING_GATE_TASK_ID,
        UNDERSTANDING_GATE_MODE: process.env.UNDERSTANDING_GATE_MODE,
        UNDERSTANDING_GATE_REPORT_DIR:
          process.env.UNDERSTANDING_GATE_REPORT_DIR,
      };

      const cwd = ctx.directory;
      const parseErrorDir = resolveParseErrorDir(cwd, env);

      const outcome = handlePersistReport(
        {
          lastAssistantText: text,
          cwd,
          sessionId: info.sessionID,
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

      // Phase 1.5: register assumptions + open questions in the
      // hypothesis-tracker store. Best-effort and never throws — same
      // "don't crash the harness" stance as the rest of the plugin.
      // On error, drop a side-channel log so the failure is visible
      // on disk without raising in the plugin runtime.
      if (outcome.kind === "saved") {
        const sync = syncHypothesesFromReport(outcome.report, {
          reportDir: dirname(outcome.path),
          sessionId: info.sessionID,
        });
        if (sync.kind === "error") {
          try {
            writeSyncErrorLog(resolveSyncErrorDir(cwd, env), sync.message);
          } catch {
            // ignore: side-channel must not crash the plugin either.
          }
        }
      }
    },
  };
};

export default persistReportPlugin;

// --- helpers (mirror the claude-code Stop binary) -----------------------

function resolveParseErrorDir(cwd: string, env: PersistReportEnv): string {
  return resolveErrorDir(cwd, env, PARSE_ERRORS_SUBDIR);
}

function resolveSyncErrorDir(cwd: string, env: PersistReportEnv): string {
  return resolveErrorDir(cwd, env, SYNC_ERRORS_SUBDIR);
}

function resolveErrorDir(
  cwd: string,
  env: PersistReportEnv,
  subdir: string,
): string {
  const reportDirEnv = env.UNDERSTANDING_GATE_REPORT_DIR;
  if (reportDirEnv && reportDirEnv.length > 0) {
    return resolve(dirname(reportDirEnv), subdir);
  }
  return resolve(cwd, ".understanding-gate", subdir);
}

function writeParseErrorLog(dir: string, payload: string): string {
  return writeStampedLog(dir, payload);
}

function writeSyncErrorLog(dir: string, payload: string): string {
  return writeStampedLog(dir, payload);
}

function writeStampedLog(dir: string, payload: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${stamp}-${randomBytes(3).toString("hex")}.log`;
  const path = join(dir, filename);
  writeAtomicText(path, payload);
  return path;
}
