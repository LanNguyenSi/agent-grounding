// End-to-end-ish test for the opencode plugin: feed a fake
// message.updated event with a mock client returning a Report-bearing
// part list, assert that a real file lands under .understanding-gate/
// reports/. Exercises persist-report-plugin → handlePersistReport →
// real saveReport (no mocks below the plugin layer).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
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
    expect(files[0]).toMatch(/-session-int\.json$/);
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

  it("survives a client.session.message that throws (silent no-op, no file written)", async () => {
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
    expect(existsSync(join(tmp, ".understanding-gate"))).toBe(false);
  });
});
