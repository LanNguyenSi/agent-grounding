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
import { listReports, saveReport } from "../../core/persistence.js";
import { syncHypothesesFromReport } from "../../core/hypothesis-sync.js";
import { writeAtomicText } from "../../core/fs.js";
import {
  appendAuditLine,
  defaultAuditLogPath,
  type AuditEvent,
} from "../../core/audit.js";
import { findLatestForTask, isApproved } from "../../core/approval.js";
import {
  OPENCODE_WRITE_TOOLS,
  decideEnforcement,
} from "../../core/enforcement.js";
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
  OpencodeToolExecuteBeforeInput,
  OpencodeToolExecuteBeforeOutput,
} from "./opencode-types.js";
import { extractAssistantText } from "./extract.js";

export const persistReportPlugin: OpencodePlugin = async (
  ctx: OpencodePluginInput,
): Promise<OpencodeHooks> => {
  const cwd = ctx.directory;
  return {
    "tool.execute.before": (
      input: OpencodeToolExecuteBeforeInput,
      _output: OpencodeToolExecuteBeforeOutput,
    ) => {
      enforceBeforeToolExecute(cwd, input);
    },
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
      // Two failure modes to handle without ever throwing back into the
      // plugin runtime:
      //   1. The promise rejects (e.g. fetch internals throw) — caught
      //      below, drop a transport-error log breadcrumb, return.
      //   2. The promise resolves with { error, data: undefined } because
      //      the SDK runs throwOnError:false by default — same treatment.
      const env: PersistReportEnv = {
        UNDERSTANDING_GATE_DISABLE: process.env.UNDERSTANDING_GATE_DISABLE,
        UNDERSTANDING_GATE_TASK_ID: process.env.UNDERSTANDING_GATE_TASK_ID,
        UNDERSTANDING_GATE_MODE: process.env.UNDERSTANDING_GATE_MODE,
        UNDERSTANDING_GATE_REPORT_DIR:
          process.env.UNDERSTANDING_GATE_REPORT_DIR,
      };
      const parseErrorDir = resolveParseErrorDir(cwd, env);

      let text = "";
      try {
        const result = await ctx.client.session.message({
          path: { id: info.sessionID, messageID: info.id },
        });
        if (result?.error || !result?.data) {
          logTransportError(parseErrorDir, info, result?.error);
          return;
        }
        text = extractAssistantText(result);
      } catch (err) {
        logTransportError(parseErrorDir, info, err);
        return;
      }
      if (!text) return;

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

// Drop a parse-errors entry tagged transport_error. Lives next to the
// regular parse failures so dogfood inspection is still
// `ls .understanding-gate/parse-errors/`. The payload is JSON so the
// log type can be told apart from a real bad-Report dump.
function logTransportError(
  dir: string,
  info: { id?: string; sessionID?: string },
  err: unknown,
): void {
  try {
    const payload = JSON.stringify(
      {
        kind: "transport_error",
        sessionID: info.sessionID ?? null,
        messageID: info.id ?? null,
        at: new Date().toISOString(),
        error: stringifyError(err),
      },
      null,
      2,
    );
    writeStampedLog(dir, `${payload}\n`);
  } catch {
    // ignore: side-channel must not crash the plugin either.
  }
}

function stringifyError(err: unknown): unknown {
  if (err === undefined) return null;
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  if (err && typeof err === "object") return err;
  return String(err);
}

// Phase 2 enforcement on opencode's tool.execute.before hook. Throws an
// Error to abort tool dispatch when the gate decides to block; opencode
// surfaces the throw message back to the model. Audit-logs block /
// force-bypass; never logs allow-by-readonly to keep volume sane.
function enforceBeforeToolExecute(
  cwd: string,
  input: OpencodeToolExecuteBeforeInput,
): void {
  const tool = input.tool || "";
  const sessionId = input.sessionID ?? null;
  const taskId = process.env.UNDERSTANDING_GATE_TASK_ID || sessionId || "";

  let entries: ReturnType<typeof listReports> = [];
  try {
    entries = listReports({
      cwd,
      dir: process.env.UNDERSTANDING_GATE_REPORT_DIR || undefined,
    });
  } catch {
    entries = [];
  }
  const latest = taskId ? findLatestForTask(entries, taskId) : null;

  const decision = decideEnforcement({
    tool,
    writeToolNames: OPENCODE_WRITE_TOOLS,
    reportExists: latest !== null,
    reportApproved: isApproved(latest),
    env: {
      UNDERSTANDING_GATE_DISABLE: process.env.UNDERSTANDING_GATE_DISABLE,
      UNDERSTANDING_GATE_FORCE: process.env.UNDERSTANDING_GATE_FORCE,
      UNDERSTANDING_GATE_FORCE_REASON:
        process.env.UNDERSTANDING_GATE_FORCE_REASON,
    },
  });

  if (decision.mode === "force_bypass") {
    safeAppendAudit(cwd, {
      kind: "force_bypass",
      tool,
      reason: decision.reason,
      sessionId,
      taskId: taskId || null,
      adapter: "opencode",
    });
    return;
  }

  if (decision.decision === "block") {
    safeAppendAudit(cwd, {
      kind: "block",
      tool,
      reason: decision.reason,
      sessionId,
      taskId: taskId || null,
      adapter: "opencode",
    });
    throw new Error(decision.reason);
  }

  // allow path (approved / readonly_tool / disabled): silent.
}

function safeAppendAudit(cwd: string, event: AuditEvent): void {
  try {
    appendAuditLine(defaultAuditLogPath(cwd), event);
  } catch {
    // ignore: audit-write must not change enforcement outcome.
  }
}
