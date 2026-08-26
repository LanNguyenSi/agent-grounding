// opencode plugin entry point. Hooks the runtime `event` channel and
// auto-persists Understanding Reports emitted by assistant messages.
//
// All runtime types are imported with `import type` so the package's dist
// has no runtime dependency on @opencode-ai/* — only a structural type
// dependency at build time.
//
// Loading: the `init --target opencode` command writes a shim file at
// `.opencode/plugins/understanding-gate-persist-report.ts` that re-exports
// the function below as default. opencode auto-loads every file under
// `.opencode/plugins/` (plural), so no `opencode.json` edit is needed
// (confirmed against opencode 1.18.18 in
// docs/testing/opencode-npm-dogfood.md, Finding 5).

import { parseReport } from "../../core/parser.js";
import { listReports, saveReport } from "../../core/persistence.js";
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
  resolveErrorDir,
  writeStampedLog,
} from "../error-log.js";
import { runSyncAndLog } from "../sync-and-log.js";
import { isPaused } from "../claude-code/pause.js";
import {
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
  // opencode fires `message.updated` twice for the same finished assistant
  // message (a delta update then a final update, both with `info.finish`
  // set), confirmed in docs/testing/opencode-npm-dogfood.md, Finding 3:
  // two report writes ~105ms apart, byte-identical except `createdAt`, and
  // the identical double-fire on the transport_error breadcrumb path too.
  //
  // Dedupe decision: track `sessionID:id` here in the adapter rather than
  // dropping `createdAt` from saveReport's content hash (core/persistence.ts
  // canonicalJSON/contentHash). The hash-based fix would be adapter-agnostic
  // but changes shared saveReport semantics for every consumer, and at
  // least one is load-bearing on `createdAt` being part of the hash:
  // core/approval.ts's `withApprovalStatus` deliberately bumps `createdAt`
  // on every approve/revoke specifically "so saveReport produces a new
  // content-hash-keyed file" (see its doc comment). A revoke that restores
  // a report to a state byte-identical to an earlier pending snapshot
  // (same fields, no approvedAt/approvedBy) would, with `createdAt`
  // excluded from the hash, collide with that earlier file's hash and
  // silently no-op instead of writing the revoked snapshot, breaking the
  // audit-trail guarantee `cli-approve.test.ts` locks in ("approve ->
  // revoke -> findLatestForTask returns the revoked snapshot"). Deduping
  // in-memory per (sessionID, messageID) here is adapter-local, closer to
  // the actual symptom (opencode's own double event fire), and touches
  // nothing shared with the claude-code adapter or the CLI approve/revoke
  // flow.
  //
  // Lives in the plugin's closure so it resets per opencode process (per
  // plugin load), matching the event's own lifetime; unbounded for a
  // session's lifetime is fine at this volume (one entry per finished
  // assistant message).
  //
  // Claim timing (Fix-Runde 2, agent-grounding 973281e1, Finding 1): the
  // key is added to this set only after a fetch has actually returned
  // usable text (see below), never before the fetch is attempted.
  // Claiming eagerly, before the fetch, was tried first and found to lose
  // reports permanently: if the first of opencode's two same-message
  // fires hit a transient fetch failure, the key was already marked
  // processed, so the second fire -- often the one that would have
  // succeeded -- was skipped too, and the report was gone with nothing
  // but a single transport_error breadcrumb to show for it. Deferring the
  // claim means a failed fire leaves the key unclaimed, so the next fire
  // for the same message gets a genuine retry. Accepted trade-off: if
  // BOTH fires fail, both attempt the fetch and both log a
  // transport_error breadcrumb -- the transport_error path is no longer
  // deduped for free. A duplicate (loud) breadcrumb is preferable to a
  // silently missing report that stalls the harness at the Layer 2 gate.
  const processedMessages = new Set<string>();
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

      // Dedupe opencode's double `message.updated` fire for the same
      // finished message (see the closure comment above). Skips the fetch
      // + parse + save + sync work entirely on a repeat fire once a prior
      // fire's fetch already succeeded. The key itself is claimed further
      // below, only after that success -- not here.
      const dedupeKey = `${info.sessionID}:${info.id}`;
      if (processedMessages.has(dedupeKey)) return;

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

      // Only claim the dedupe key once the fetch produced usable text.
      // See the closure comment above for why this is deferred rather
      // than claimed eagerly before the fetch was attempted.
      processedMessages.add(dedupeKey);

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
      // on disk without raising in the plugin runtime. Routed through
      // the shared runSyncAndLog so the claude-code Stop binary and
      // this plugin stay byte-equivalent on the post-save path.
      if (outcome.kind === "saved") {
        runSyncAndLog(outcome.report, outcome.path, info.sessionID, {
          resolveSyncErrorDir: () => resolveSyncErrorDir(cwd, env),
          writeSyncErrorLog,
        });
      }
    },
  };
};

export default persistReportPlugin;

// --- helpers ------------------------------------------------------------
// Thin wrappers around the shared ../error-log.js primitives so each
// callsite reads as "this is the parse-error dir / this writes a sync
// log" rather than passing the subdir constant inline every time.

function resolveParseErrorDir(cwd: string, env: PersistReportEnv): string {
  return resolveErrorDir(cwd, env, PARSE_ERRORS_SUBDIR);
}

function resolveSyncErrorDir(cwd: string, env: PersistReportEnv): string {
  return resolveErrorDir(cwd, env, SYNC_ERRORS_SUBDIR);
}

function writeParseErrorLog(dir: string, payload: string): string {
  return writeStampedLog(dir, payload);
}

function writeSyncErrorLog(dir: string, payload: string): string {
  return writeStampedLog(dir, payload);
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

  // Pause check runs AFTER the enforcement decision (not before), mirroring
  // the Claude Code PreToolUse hook (see handle-pre-tool-use.ts): a paused
  // allow that overrides a would-be block still leaves exactly one audit
  // trace, never as silent as an ordinary allow -- but unlike PreToolUse,
  // that audit trace is the ONLY observable signal: opencode's
  // enforceBeforeToolExecute never writes to stderr the way
  // handle-pre-tool-use.ts does on a paused override, so there is no
  // in-session diagnostic here, only the audit.log entry. Same sentinel,
  // same reader as the Claude Code hooks (isPaused imported from
  // ../claude-code/pause.js, not reimplemented). This only takes effect
  // when UNDERSTANDING_GATE_PAUSE_FILE is actually exported into the
  // environment that launches opencode: opencode has no per-hook-line
  // settings.json equivalent, so the plugin re-reads the sentinel FILE
  // on every gated tool call, but the env var itself is whatever
  // opencode's process was launched with -- nothing in this package
  // projects it there today (see README's "Pause sentinel" opencode
  // subsection). A force-bypass decision is NOT treated as an override
  // here: it falls through to the force_bypass audit branch below (which
  // already returns a silent allow) so it keeps its own `force_bypass`
  // audit kind instead of being folded into `paused_allow`.
  if (isPaused(process.env.UNDERSTANDING_GATE_PAUSE_FILE)) {
    if (decision.decision === "block") {
      safeAppendAudit(cwd, {
        kind: "paused_allow",
        tool,
        reason: `understanding-gate is paused (pause sentinel active); overrides what would otherwise have been a block decision (${decision.mode}): ${decision.reason}`,
        sessionId,
        taskId: taskId || null,
        adapter: "opencode",
      });
      return;
    }
    if (decision.mode !== "force_bypass") {
      // The underlying decision was already an allow (e.g. a read-only
      // tool, an already-approved report, or UNDERSTANDING_GATE_DISABLE):
      // the pause changes nothing observable, so stay on the silent,
      // zero-audit path.
      return;
    }
    // Force-bypass: fall through to the force_bypass audit branch below.
  }

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
