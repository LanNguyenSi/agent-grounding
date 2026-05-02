// End-to-end-ish test for the opencode plugin's `tool.execute.before`
// hook (Phase 2 enforcement). Each test instantiates the plugin against
// a temp cwd, then invokes the hook with simulated tool calls. The
// fixture mirrors `opencode-plugin-integration.test.ts` for the event
// hook: real persistence + real audit log, no mocks below the plugin.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistReportPlugin } from "../src/adapters/opencode/persist-report-plugin.js";
import type { OpencodeClient } from "../src/adapters/opencode/opencode-types.js";
import { saveReport } from "../src/core/persistence.js";
import { defaultAuditLogPath } from "../src/core/audit.js";
import type { UnderstandingReport } from "../src/schema/types.js";

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
