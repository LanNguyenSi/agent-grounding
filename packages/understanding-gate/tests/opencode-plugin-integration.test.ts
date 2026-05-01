// End-to-end-ish test for the opencode plugin: feed a fake
// message.updated event with a mock client returning a Report-bearing
// part list, assert that a real file lands under .understanding-gate/
// reports/. Exercises persist-report-plugin → handlePersistReport →
// real saveReport (no mocks below the plugin layer).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistReportPlugin } from "../src/adapters/opencode/persist-report-plugin.js";
import type { OpencodeClient } from "../src/adapters/opencode/opencode-types.js";

let tmp: string;

const FULL_REPORT_TEXT = [
  "# Understanding Report",
  "",
  "### 1. My current understanding",
  "Add a logout button.",
  "",
  "### 2. Intended outcome",
  "Logout button rendered.",
  "",
  "### 3. Derived todos / specs",
  "- add component",
  "",
  "### 4. Acceptance criteria",
  "- visible",
  "",
  "### 5. Assumptions",
  "- session in cookie",
  "",
  "### 6. Open questions",
  "- placement?",
  "",
  "### 7. Out of scope",
  "- styling",
  "",
  "### 8. Risks",
  "- redirect collision",
  "",
  "### 9. Verification plan",
  "- click test",
].join("\n");

function makeClient(parts: Array<{ type: string; text?: string }>): OpencodeClient {
  return {
    session: {
      message: async (_input: { path: { id: string; messageID: string } }) => {
        return {
          data: {
            info: { id: "m1", sessionID: "session-int", role: "assistant" },
            parts,
          },
        };
      },
    },
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ug-oc-plugin-int-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("persistReportPlugin: end-to-end", () => {
  it("writes a real report file when a complete Report arrives", async () => {
    const client = makeClient([{ type: "text", text: FULL_REPORT_TEXT }]);
    const hooks = await persistReportPlugin({ client, directory: tmp });
    expect(hooks.event).toBeDefined();
    if (!hooks.event) return;
    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "m1",
            sessionID: "session-int",
            role: "assistant",
            finish: "ok",
          },
        },
      },
    });
    const reportsDir = join(tmp, ".understanding-gate", "reports");
    expect(existsSync(reportsDir)).toBe(true);
    const files = readdirSync(reportsDir).filter((n) => n.endsWith(".json"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/-session-int-[0-9a-f]{8}\.json$/);
  });

  it("does nothing when info.finish is not set (still streaming)", async () => {
    const client = makeClient([{ type: "text", text: FULL_REPORT_TEXT }]);
    const hooks = await persistReportPlugin({ client, directory: tmp });
    if (!hooks.event) return;
    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: { id: "m1", sessionID: "s", role: "assistant" /* no finish */ },
        },
      },
    });
    expect(existsSync(join(tmp, ".understanding-gate"))).toBe(false);
  });

  it("ignores non-message.updated events", async () => {
    const client = makeClient([{ type: "text", text: FULL_REPORT_TEXT }]);
    const hooks = await persistReportPlugin({ client, directory: tmp });
    if (!hooks.event) return;
    await hooks.event({ event: { type: "session.idle", properties: {} } });
    expect(existsSync(join(tmp, ".understanding-gate"))).toBe(false);
  });

  it("ignores user-role messages", async () => {
    const client = makeClient([{ type: "text", text: FULL_REPORT_TEXT }]);
    const hooks = await persistReportPlugin({ client, directory: tmp });
    if (!hooks.event) return;
    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: { id: "u1", sessionID: "s", role: "user", finish: "ok" },
        },
      },
    });
    expect(existsSync(join(tmp, ".understanding-gate"))).toBe(false);
  });

  it("writes a parse-error log when the assistant text is a partial report", async () => {
    const client = makeClient([
      {
        type: "text",
        text: "# Understanding Report\n\n### 1. My current understanding\nonly one section",
      },
    ]);
    const hooks = await persistReportPlugin({ client, directory: tmp });
    if (!hooks.event) return;
    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "m2",
            sessionID: "session-bad",
            role: "assistant",
            finish: "ok",
          },
        },
      },
    });
    const errsDir = join(tmp, ".understanding-gate", "parse-errors");
    expect(existsSync(errsDir)).toBe(true);
    const logs = readdirSync(errsDir).filter((n) => n.endsWith(".log"));
    expect(logs).toHaveLength(1);
    // No real report file should appear.
    expect(existsSync(join(tmp, ".understanding-gate", "reports"))).toBe(false);
  });

  it("writes a sync-error log when hypothesis-sync fails post-save", async () => {
    // Stage a directory exactly where hypotheses.json would be written so
    // saveStore's renameSync trips EISDIR. Result: report file lands fine,
    // sync-errors/ gets a stamped log breadcrumb.
    mkdirSync(join(tmp, ".understanding-gate"), { recursive: true });
    mkdirSync(join(tmp, ".understanding-gate", "hypotheses.json"), {
      recursive: true,
    });

    const client = makeClient([{ type: "text", text: FULL_REPORT_TEXT }]);
    const hooks = await persistReportPlugin({ client, directory: tmp });
    if (!hooks.event) return;
    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "m-sync",
            sessionID: "session-sync-fail",
            role: "assistant",
            finish: "ok",
          },
        },
      },
    });

    const reportsDir = join(tmp, ".understanding-gate", "reports");
    const reportFiles = existsSync(reportsDir)
      ? readdirSync(reportsDir).filter((n) => n.endsWith(".json"))
      : [];
    expect(reportFiles).toHaveLength(1);

    const syncErrDir = join(tmp, ".understanding-gate", "sync-errors");
    expect(existsSync(syncErrDir)).toBe(true);
    const logs = readdirSync(syncErrDir).filter((n) => n.endsWith(".log"));
    expect(logs).toHaveLength(1);
  });

  it("logs a transport_error and does not throw when client.session.message rejects", async () => {
    const throwingClient: OpencodeClient = {
      session: {
        message: async () => {
          throw new Error("network down");
        },
      },
    };
    const hooks = await persistReportPlugin({
      client: throwingClient,
      directory: tmp,
    });
    if (!hooks.event) return;
    await expect(
      hooks.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "m3",
              sessionID: "s",
              role: "assistant",
              finish: "ok",
            },
          },
        },
      }),
    ).resolves.toBeUndefined();
    // No real report file should appear.
    expect(existsSync(join(tmp, ".understanding-gate", "reports"))).toBe(false);
    // But a transport-error breadcrumb should land in parse-errors/.
    const errsDir = join(tmp, ".understanding-gate", "parse-errors");
    expect(existsSync(errsDir)).toBe(true);
    const logs = readdirSync(errsDir).filter((n) => n.endsWith(".log"));
    expect(logs).toHaveLength(1);
    const body = readFileSync(join(errsDir, logs[0]!), "utf8");
    const parsed = JSON.parse(body) as {
      kind: string;
      sessionID: string | null;
      messageID: string | null;
      error: { message?: string };
    };
    expect(parsed.kind).toBe("transport_error");
    expect(parsed.sessionID).toBe("s");
    expect(parsed.messageID).toBe("m3");
    expect(parsed.error.message).toBe("network down");
  });

  it("logs a transport_error when client.session.message resolves with { error } and no data", async () => {
    const errorReturningClient: OpencodeClient = {
      session: {
        message: async () => ({
          error: { code: 502, message: "bad gateway" },
        }),
      },
    };
    const hooks = await persistReportPlugin({
      client: errorReturningClient,
      directory: tmp,
    });
    if (!hooks.event) return;
    await hooks.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "m4",
            sessionID: "s2",
            role: "assistant",
            finish: "ok",
          },
        },
      },
    });
    const errsDir = join(tmp, ".understanding-gate", "parse-errors");
    expect(existsSync(errsDir)).toBe(true);
    const logs = readdirSync(errsDir).filter((n) => n.endsWith(".log"));
    expect(logs).toHaveLength(1);
    const parsed = JSON.parse(readFileSync(join(errsDir, logs[0]!), "utf8")) as {
      kind: string;
      error: { code?: number; message?: string };
    };
    expect(parsed.kind).toBe("transport_error");
    expect(parsed.error.code).toBe(502);
    expect(parsed.error.message).toBe("bad gateway");
  });
});
