import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// End-to-end check for the Stop hook: spawn the compiled binary as
// Claude Code would, pipe a stop payload on stdin pointing at a real
// transcript JSONL file, and assert what landed on disk under the
// per-test report dir. Phase 1.3's pure-handler tests cover the logic
// via dep mocks; this test closes the gap at the binary boundary.

const PKG_ROOT = resolve(__dirname, "..");
const BINARY = resolve(PKG_ROOT, "dist/adapters/claude-code/stop.js");

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

const PARTIAL_REPORT_TEXT = [
  "# Understanding Report",
  "",
  "### 1. My current understanding",
  "only one section",
].join("\n");

let tmp: string;
let transcriptPath: string;

beforeAll(() => {
  if (!existsSync(BINARY)) {
    execFileSync("npm", ["run", "build"], { cwd: PKG_ROOT, stdio: "ignore" });
  }
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ug-stop-bin-"));
  transcriptPath = join(tmp, "transcript.jsonl");
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeTranscript(assistantText: string): void {
  // Two lines: a user turn followed by an assistant turn that contains
  // the report text. The trailing-assistant walk picks up the latter.
  const lines = [
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "go" }] },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: assistantText }],
      },
    }),
  ];
  writeFileSync(transcriptPath, `${lines.join("\n")}\n`, "utf8");
}

function runStopHook(
  payload: Record<string, unknown>,
  envOverride: NodeJS.ProcessEnv = {},
): { code: number | null; stderr: string } {
  const reportDir = join(tmp, "reports");
  mkdirSync(reportDir, { recursive: true });
  const result = spawnSync("node", [BINARY], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: {
      ...process.env,
      UNDERSTANDING_GATE_REPORT_DIR: reportDir,
      ...envOverride,
    },
  });
  return { code: result.status, stderr: result.stderr ?? "" };
}

describe("claude-code Stop binary (end-to-end)", () => {
  it("writes a report file when a fully-formed Report sits in the trailing assistant text", () => {
    writeTranscript(FULL_REPORT_TEXT);
    const { code, stderr } = runStopHook({
      session_id: "session-full",
      transcript_path: transcriptPath,
      cwd: tmp,
      hook_event_name: "Stop",
    });
    expect(code, stderr).toBe(0);
    const reports = readdirSync(join(tmp, "reports")).filter((n) =>
      n.endsWith(".json"),
    );
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatch(/-session-full\.json$/);
  });

  it("exits silently with no files when the transcript lacks a report marker", () => {
    writeTranscript("just a normal reply, nothing to see here");
    const { code, stderr } = runStopHook({
      session_id: "session-bare",
      transcript_path: transcriptPath,
      cwd: tmp,
      hook_event_name: "Stop",
    });
    expect(code, stderr).toBe(0);
    expect(
      readdirSync(join(tmp, "reports")).filter((n) => n.endsWith(".json")),
    ).toEqual([]);
    expect(existsSync(join(tmp, ".understanding-gate", "parse-errors"))).toBe(
      false,
    );
  });

  it("writes a parse-error log when the marker is present but the report is malformed", () => {
    writeTranscript(PARTIAL_REPORT_TEXT);
    const { code, stderr } = runStopHook({
      session_id: "session-bad",
      transcript_path: transcriptPath,
      cwd: tmp,
      hook_event_name: "Stop",
    });
    expect(code, stderr).toBe(0);
    const reports = readdirSync(join(tmp, "reports")).filter((n) =>
      n.endsWith(".json"),
    );
    expect(reports).toEqual([]);
    // parseErrorDir resolves relative to the report dir's parent when
    // UNDERSTANDING_GATE_REPORT_DIR is set, so logs land in <tmp>/parse-errors/.
    const errsDir = join(tmp, "parse-errors");
    expect(existsSync(errsDir)).toBe(true);
    const logs = readdirSync(errsDir).filter((n) => n.endsWith(".log"));
    expect(logs).toHaveLength(1);
  });

  it("does not crash on malformed stdin JSON", () => {
    const reportDir = join(tmp, "reports");
    mkdirSync(reportDir, { recursive: true });
    const result = spawnSync("node", [BINARY], {
      input: "garbage {{{",
      encoding: "utf8",
      env: { ...process.env, UNDERSTANDING_GATE_REPORT_DIR: reportDir },
    });
    expect(result.status, result.stderr ?? "").toBe(0);
    expect(
      readdirSync(reportDir).filter((n) => n.endsWith(".json")),
    ).toEqual([]);
  });
});
