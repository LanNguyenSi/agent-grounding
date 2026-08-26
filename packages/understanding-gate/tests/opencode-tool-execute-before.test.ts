// End-to-end-ish test for the opencode plugin's `tool.execute.before`
// hook (Phase 2 enforcement). Each test instantiates the plugin against
// a temp cwd, then invokes the hook with simulated tool calls. The
// fixture mirrors `opencode-plugin-integration.test.ts` for the event
// hook: real persistence + real audit log, no mocks below the plugin.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { persistReportPlugin } from "../src/adapters/opencode/persist-report-plugin.js";
import type { OpencodeClient } from "../src/adapters/opencode/opencode-types.js";
import { saveReport } from "../src/core/persistence.js";
import { defaultAuditLogPath } from "../src/core/audit.js";
import { handleUserPromptSubmit } from "../src/adapters/claude-code/handle.js";
import type { UnderstandingReport } from "../src/schema/types.js";

// Repo root (packages/understanding-gate/.. /..): where npm hoists devDeps
// like tsx in this npm-workspace repo. Used only by the FIFO regression
// test below, which must run the handler in a REAL child process (see
// tests/fixtures/run-opencode-tool-before-child.ts and the FIFO probe in
// claude-code-handle.test.ts, which this mirrors).
const REPO_ROOT = resolve(__dirname, "../../..");
const TSX_BIN = resolve(REPO_ROOT, "node_modules/.bin/tsx");
const RUN_TOOL_BEFORE_CHILD = resolve(
  __dirname,
  "fixtures/run-opencode-tool-before-child.ts",
);

const baseReport: UnderstandingReport = {
  taskId: "session-oc",
  mode: "fast_confirm",
  riskLevel: "medium",
  currentUnderstanding: "x",
  intendedOutcome: "x",
  derivedTodos: ["t"],
  acceptanceCriteria: ["a"],
  assumptions: ["a"],
  openQuestions: ["q"],
  outOfScope: ["o"],
  risks: ["r"],
  verificationPlan: ["v"],
  requiresHumanApproval: true,
  approvalStatus: "pending",
  createdAt: "2026-05-01T10:00:00.000Z",
};

const STUB_CLIENT: OpencodeClient = {
  session: { message: async () => ({ data: { info: undefined, parts: [] } }) },
};

let tmp: string;
const ENV_KEYS = [
  "UNDERSTANDING_GATE_DISABLE",
  "UNDERSTANDING_GATE_FORCE",
  "UNDERSTANDING_GATE_FORCE_REASON",
  "UNDERSTANDING_GATE_TASK_ID",
  "UNDERSTANDING_GATE_REPORT_DIR",
  "UNDERSTANDING_GATE_PAUSE_FILE",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ug-oc-tool-before-"));
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

async function call(
  hooks: Awaited<ReturnType<typeof persistReportPlugin>>,
  tool: string,
  sessionID = "session-oc",
): Promise<Error | null> {
  const fn = hooks["tool.execute.before"];
  if (!fn) throw new Error("tool.execute.before hook not registered");
  try {
    await fn({ tool, sessionID }, {});
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

describe("opencode tool.execute.before: enforcement", () => {
  it("registers a tool.execute.before hook on the returned object", async () => {
    const hooks = await persistReportPlugin({
      client: STUB_CLIENT,
      directory: tmp,
    });
    expect(hooks["tool.execute.before"]).toBeTypeOf("function");
  });

  it("blocks `write` with no report (throws + audits)", async () => {
    const hooks = await persistReportPlugin({
      client: STUB_CLIENT,
      directory: tmp,
    });
    const err = await call(hooks, "write");
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("write");
    const audit = readFileSync(defaultAuditLogPath(tmp), "utf8")
      .trim()
      .split("\n");
    const event = JSON.parse(audit[0]) as { kind: string; adapter: string };
    expect(event.kind).toBe("block");
    expect(event.adapter).toBe("opencode");
  });

  it("blocks `bash` with a pending report (throws + audits)", async () => {
    saveReport(baseReport, { cwd: tmp });
    const hooks = await persistReportPlugin({
      client: STUB_CLIENT,
      directory: tmp,
    });
    const err = await call(hooks, "bash");
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("bash");
  });

  it("allows `edit` with an approved report (no throw, no audit)", async () => {
    saveReport(
      {
        ...baseReport,
        approvalStatus: "approved",
        approvedAt: "2026-05-02T08:00:00.000Z",
        approvedBy: "cli",
      },
      { cwd: tmp },
    );
    const hooks = await persistReportPlugin({
      client: STUB_CLIENT,
      directory: tmp,
    });
    const err = await call(hooks, "edit");
    expect(err).toBeNull();
    expect(existsSync(defaultAuditLogPath(tmp))).toBe(false);
  });

  it("allows non-write tools (`read`, `grep`) silently", async () => {
    const hooks = await persistReportPlugin({
      client: STUB_CLIENT,
      directory: tmp,
    });
    expect(await call(hooks, "read")).toBeNull();
    expect(await call(hooks, "grep")).toBeNull();
    expect(existsSync(defaultAuditLogPath(tmp))).toBe(false);
  });

  it("audits + allows on valid force-bypass", async () => {
    process.env.UNDERSTANDING_GATE_FORCE = "1";
    process.env.UNDERSTANDING_GATE_FORCE_REASON = "incident-recovery now";
    const hooks = await persistReportPlugin({
      client: STUB_CLIENT,
      directory: tmp,
    });
    const err = await call(hooks, "bash");
    expect(err).toBeNull();
    const audit = readFileSync(defaultAuditLogPath(tmp), "utf8")
      .trim()
      .split("\n");
    const event = JSON.parse(audit[0]) as { kind: string; reason: string };
    expect(event.kind).toBe("force_bypass");
    expect(event.reason).toContain("incident-recovery");
  });

  it("blocks force_invalid (FORCE without reason)", async () => {
    process.env.UNDERSTANDING_GATE_FORCE = "1";
    const hooks = await persistReportPlugin({
      client: STUB_CLIENT,
      directory: tmp,
    });
    const err = await call(hooks, "bash");
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("FORCE");
  });

  it("respects UNDERSTANDING_GATE_DISABLE (no-op)", async () => {
    process.env.UNDERSTANDING_GATE_DISABLE = "1";
    const hooks = await persistReportPlugin({
      client: STUB_CLIENT,
      directory: tmp,
    });
    expect(await call(hooks, "bash")).toBeNull();
    expect(existsSync(defaultAuditLogPath(tmp))).toBe(false);
  });

  it("uses UNDERSTANDING_GATE_TASK_ID over sessionID for report lookup", async () => {
    saveReport(
      {
        ...baseReport,
        taskId: "explicit-task",
        approvalStatus: "approved",
        approvedAt: "z",
        approvedBy: "cli",
      },
      { cwd: tmp },
    );
    process.env.UNDERSTANDING_GATE_TASK_ID = "explicit-task";
    const hooks = await persistReportPlugin({
      client: STUB_CLIENT,
      directory: tmp,
    });
    // sessionID is irrelevant; the env override drives the lookup.
    const err = await call(hooks, "edit", "ignored-session");
    expect(err).toBeNull();
  });
});

describe("opencode tool.execute.before: pause sentinel (shared with Claude Code, no second parser)", () => {
  let sentinelDir: string;

  afterEach(() => {
    if (sentinelDir) rmSync(sentinelDir, { recursive: true, force: true });
  });

  function sentinelFile(content: unknown): string {
    sentinelDir = mkdtempSync(
      join(tmpdir(), "understanding-gate-oc-pause-"),
    );
    const file = join(sentinelDir, "sentinel.json");
    writeFileSync(
      file,
      typeof content === "string" ? content : JSON.stringify(content),
    );
    return file;
  }

  // AC1: an active, unexpired sentinel yields no throw. Would otherwise
  // block (no report exists for `write`) -- pause must override that. A
  // paused override of a would-be block must still leave exactly one
  // audit trace (a governance override is never as silent as an ordinary
  // allow).
  it("AC1: an active (future expiresAt) sentinel suppresses the block and leaves ONE paused_allow audit entry", async () => {
    process.env.UNDERSTANDING_GATE_PAUSE_FILE = sentinelFile({
      pausedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      reason: "test",
      pausedBy: "test",
    });
    const hooks = await persistReportPlugin({
      client: STUB_CLIENT,
      directory: tmp,
    });
    const err = await call(hooks, "write");
    expect(err).toBeNull();
    const audit = readFileSync(defaultAuditLogPath(tmp), "utf8")
      .trim()
      .split("\n");
    expect(audit).toHaveLength(1);
    const event = JSON.parse(audit[0]) as {
      kind: string;
      tool: string;
      adapter: string;
    };
    expect(event.kind).toBe("paused_allow");
    expect(event.tool).toBe("write");
    expect(event.adapter).toBe("opencode");
  });

  // Companion to AC1: when the underlying decision would already have
  // been an allow (a read-only tool, nothing to override), the pause
  // changes nothing observable -- stay on the zero-overhead, zero-audit
  // silent path instead of manufacturing a trace for a no-op override.
  it("a read-only tool under an active pause writes no audit entry and stays silent", async () => {
    process.env.UNDERSTANDING_GATE_PAUSE_FILE = sentinelFile({
      pausedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      reason: "test",
      pausedBy: "test",
    });
    const hooks = await persistReportPlugin({
      client: STUB_CLIENT,
      directory: tmp,
    });
    const err = await call(hooks, "read");
    expect(err).toBeNull();
    expect(existsSync(defaultAuditLogPath(tmp))).toBe(false);
  });

  // A force-bypass decision under an active pause must keep its own
  // force_bypass audit trace, not be folded into paused_allow: the pause
  // did not change anything observable about a force-bypass, so it must
  // not swallow the override-of-legitimate-authority signal that
  // force_bypass exists to record.
  it("an active pause + valid UNDERSTANDING_GATE_FORCE does not change the audit kind: exactly one force_bypass entry, no paused_allow", async () => {
    process.env.UNDERSTANDING_GATE_PAUSE_FILE = sentinelFile({
      pausedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      reason: "test",
      pausedBy: "test",
    });
    process.env.UNDERSTANDING_GATE_FORCE = "1";
    process.env.UNDERSTANDING_GATE_FORCE_REASON = "incident-recovery now";
    const hooks = await persistReportPlugin({
      client: STUB_CLIENT,
      directory: tmp,
    });
    const err = await call(hooks, "bash");
    expect(err).toBeNull();
    const audit = readFileSync(defaultAuditLogPath(tmp), "utf8")
      .trim()
      .split("\n");
    expect(audit).toHaveLength(1);
    const events = audit.map((line) => JSON.parse(line) as { kind: string });
    expect(events.some((e) => e.kind === "force_bypass")).toBe(true);
    expect(events.some((e) => e.kind === "paused_allow")).toBe(false);
  });

  // AC2 negative controls: fail-open direction is "NOT paused" -- each of
  // these must still block (throw), same as with no pause file at all.
  it("AC2: an EXPIRED sentinel does not suppress the block", async () => {
    process.env.UNDERSTANDING_GATE_PAUSE_FILE = sentinelFile({
      pausedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      reason: "test",
      pausedBy: "test",
    });
    const hooks = await persistReportPlugin({
      client: STUB_CLIENT,
      directory: tmp,
    });
    const err = await call(hooks, "write");
    expect(err).toBeInstanceOf(Error);
  });

  it("AC2: a missing sentinel file does not suppress the block", async () => {
    process.env.UNDERSTANDING_GATE_PAUSE_FILE =
      "/nonexistent/path/does-not-exist.json";
    const hooks = await persistReportPlugin({
      client: STUB_CLIENT,
      directory: tmp,
    });
    const err = await call(hooks, "write");
    expect(err).toBeInstanceOf(Error);
  });

  it("AC2: an empty sentinel file does not suppress the block", async () => {
    process.env.UNDERSTANDING_GATE_PAUSE_FILE = sentinelFile("");
    const hooks = await persistReportPlugin({
      client: STUB_CLIENT,
      directory: tmp,
    });
    const err = await call(hooks, "write");
    expect(err).toBeInstanceOf(Error);
  });

  it("AC2: unparsable JSON in the sentinel file does not suppress the block", async () => {
    process.env.UNDERSTANDING_GATE_PAUSE_FILE = sentinelFile("not json at all {");
    const hooks = await persistReportPlugin({
      client: STUB_CLIENT,
      directory: tmp,
    });
    const err = await call(hooks, "write");
    expect(err).toBeInstanceOf(Error);
  });

  it("AC2: a directory at the sentinel path does not suppress the block", async () => {
    sentinelDir = mkdtempSync(join(tmpdir(), "understanding-gate-oc-pause-"));
    process.env.UNDERSTANDING_GATE_PAUSE_FILE = sentinelDir;
    const hooks = await persistReportPlugin({
      client: STUB_CLIENT,
      directory: tmp,
    });
    const err = await call(hooks, "write");
    expect(err).toBeInstanceOf(Error);
  });

  // AC: same function, no second parser -- both the opencode path and the
  // Claude Code UserPromptSubmit path must agree on the same sentinel
  // file. Pins parity directly rather than trusting that the import alone
  // proves it. Load-bearing: covers every shape isPaused branches on (see
  // pause.ts's isPaused doc comment), not just the two happy-path shapes,
  // so a divergence introduced on only one of the indefinite-pause
  // branches (missing/null/unparsable expiresAt, non-string expiresAt,
  // missing/empty pausedAt) actually turns this red. Mirrors the parity
  // test in claude-code-pre-tool-use.test.ts (AC4) over the same 13
  // sentinel shapes.
  it("opencode and Claude Code's UserPromptSubmit agree on every sentinel shape isPaused branches on (shared isPaused, no second parser)", async () => {
    const tmpDirs: string[] = [];
    function tmpFile(): { dir: string; file: string } {
      const d = mkdtempSync(join(tmpdir(), "understanding-gate-oc-parity-"));
      tmpDirs.push(d);
      return { dir: d, file: join(d, "sentinel.json") };
    }
    function objectFile(content: unknown): string {
      const { file } = tmpFile();
      writeFileSync(file, JSON.stringify(content));
      return file;
    }
    function rawFile(raw: string): string {
      const { file } = tmpFile();
      writeFileSync(file, raw);
      return file;
    }
    function directoryPath(): string {
      const { dir } = tmpFile();
      return dir;
    }
    function missingPath(): string {
      const { dir } = tmpFile();
      return join(dir, "does-not-exist.json");
    }

    const activePausedAt = new Date().toISOString();
    const futureExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const pastPausedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const pastExpiresAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const cases: Array<{ label: string; file: () => string }> = [
      {
        label: "active",
        file: () => objectFile({ pausedAt: activePausedAt, expiresAt: futureExpiresAt }),
      },
      {
        label: "expired",
        file: () => objectFile({ pausedAt: pastPausedAt, expiresAt: pastExpiresAt }),
      },
      {
        label: "expiresAt missing",
        file: () => objectFile({ pausedAt: activePausedAt }),
      },
      {
        label: "expiresAt null",
        file: () => objectFile({ pausedAt: activePausedAt, expiresAt: null }),
      },
      {
        label: "expiresAt non-parsable non-empty string",
        file: () => objectFile({ pausedAt: activePausedAt, expiresAt: "not-a-date" }),
      },
      {
        label: "expiresAt a number",
        file: () => objectFile({ pausedAt: activePausedAt, expiresAt: 12345 }),
      },
      {
        label: "expiresAt a boolean",
        file: () => objectFile({ pausedAt: activePausedAt, expiresAt: true }),
      },
      {
        label: "pausedAt missing",
        file: () => objectFile({ expiresAt: futureExpiresAt }),
      },
      {
        label: "pausedAt empty string",
        file: () => objectFile({ pausedAt: "", expiresAt: futureExpiresAt }),
      },
      {
        label: "directory at the sentinel path",
        file: directoryPath,
      },
      {
        label: "missing file",
        file: missingPath,
      },
      {
        label: "empty file",
        file: () => rawFile(""),
      },
      {
        label: "unparsable JSON",
        file: () => rawFile("not json at all {"),
      },
    ];

    try {
      for (const { label, file: makeFile } of cases) {
        const file = makeFile();
        process.env.UNDERSTANDING_GATE_PAUSE_FILE = file;
        const hooks = await persistReportPlugin({
          client: STUB_CLIENT,
          directory: tmp,
        });
        const err = await call(hooks, "write", `parity-${label}`);
        const openCodePaused = err === null;

        const promptOut = handleUserPromptSubmit(
          JSON.stringify({ prompt: "add a logout button to src/Header.tsx" }),
          { UNDERSTANDING_GATE_PAUSE_FILE: file },
        );
        const claudePaused = promptOut === "";

        expect(openCodePaused, `case "${label}"`).toBe(claudePaused);
      }
    } finally {
      for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    }
  });

  // FIFO regression: a statSync guard that regressed to lstatSync (or was
  // removed) would make readFileSync block forever on a writer-less named
  // pipe, hanging the harness. Must run in a REAL child process, not
  // in-process: a blocking readFileSync inside isPaused would block the
  // vitest worker thread itself and never yield to the event loop that
  // runs vitest's own it(..., timeout) timer -- see the identical
  // reasoning in claude-code-handle.test.ts / run-handle-child.ts, which
  // this mirrors for the opencode enforcement path.
  it.skipIf(process.platform === "win32")(
    "a named pipe at the pause-file path fails FAST if the statSync guard regresses, instead of hanging the suite",
    () => {
      sentinelDir = mkdtempSync(
        join(tmpdir(), "understanding-gate-oc-pause-fifo-"),
      );
      const fifo = join(sentinelDir, "sentinel.fifo");
      execFileSync("mkfifo", [fifo]);

      const start = Date.now();
      const out = execFileSync(
        TSX_BIN,
        [RUN_TOOL_BEFORE_CHILD, tmp, "write", fifo],
        { encoding: "utf8", timeout: 2000 },
      );
      // eslint-disable-next-line no-console -- reported runtime for the
      // opencode FIFO probe, not left-over debugging.
      console.log(
        `[AC-M1-opencode] FIFO probe (guard intact) took ${Date.now() - start}ms`,
      );
      expect(out.trim()).toBe("blocked");
    },
    5000,
  );
});
