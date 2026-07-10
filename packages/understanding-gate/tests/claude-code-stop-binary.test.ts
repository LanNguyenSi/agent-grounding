import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
    expect(reports[0]).toMatch(/-session-full-[0-9a-f]{8}\.json$/);
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

  // 0.2.1: prefer payload.last_assistant_message over the transcript
  // file. Newer Claude Code releases ship the final assistant text in
  // the Stop payload directly; reading it dodges a race where Stop
  // fires before the transcript JSONL has been flushed (observed live
  // under `claude -p`).
  it("persists the report from payload.last_assistant_message even when the transcript is empty", () => {
    // Empty transcript file: simulates the race where the JSONL hasn't
    // been written yet when Stop fires.
    writeFileSync(transcriptPath, "", "utf8");
    const reportDir = join(tmp, "reports");
    mkdirSync(reportDir, { recursive: true });
    const result = spawnSync("node", [BINARY], {
      input: JSON.stringify({
        session_id: "session-payload",
        transcript_path: transcriptPath,
        cwd: tmp,
        hook_event_name: "Stop",
        last_assistant_message: FULL_REPORT_TEXT,
      }),
      encoding: "utf8",
      env: { ...process.env, UNDERSTANDING_GATE_REPORT_DIR: reportDir },
    });
    expect(result.status, result.stderr ?? "").toBe(0);
    const reports = readdirSync(reportDir).filter((n) => n.endsWith(".json"));
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatch(/-session-payload-[0-9a-f]{8}\.json$/);
  });

  it("falls back to the transcript file when last_assistant_message is missing", () => {
    writeTranscript(FULL_REPORT_TEXT);
    const { code, stderr } = runStopHook({
      session_id: "session-fallback",
      transcript_path: transcriptPath,
      cwd: tmp,
      hook_event_name: "Stop",
      // last_assistant_message intentionally omitted
    });
    expect(code, stderr).toBe(0);
    const reports = readdirSync(join(tmp, "reports")).filter((n) =>
      n.endsWith(".json"),
    );
    expect(reports).toHaveLength(1);
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


// Wiring coverage for stop.ts itself (task 0a3227fe). selectReportText is
// unit-tested in isolation; these assert the binary actually feeds it the
// payload field and a lazy transcript closure, which a unit test cannot see.
describe("claude-code Stop binary: source selection + session binding (task 0a3227fe)", () => {
  /** A transcript where the report is mid-turn and the LAST assistant text is a closing sentence. */
  function writeMidTurnTranscript(reportText: string): void {
    const lines = [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "go" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: reportText }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] } },
      { type: "user", toolUseResult: { ok: true }, message: { role: "user", content: [{ type: "tool_result" }] } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done. Tests pass." }] } },
    ].map((l) => JSON.stringify(l));
    writeFileSync(transcriptPath, `${lines.join("\n")}\n`, "utf8");
  }

  function onlyReport(): Record<string, unknown> {
    const files = readdirSync(join(tmp, "reports")).filter((n) => n.endsWith(".json"));
    expect(files).toHaveLength(1);
    return JSON.parse(readFileSync(join(tmp, "reports", files[0]!), "utf8")) as Record<string, unknown>;
  }

  // The regression: the agent wrote the report, then kept working. The
  // payload's last_assistant_message is the closing sentence, so the old
  // code fed the parser that sentence and persisted nothing.
  it("persists a MID-TURN report even though last_assistant_message is a closing sentence", () => {
    writeMidTurnTranscript(FULL_REPORT_TEXT);
    const { code, stderr } = runStopHook({
      session_id: "session-midturn",
      transcript_path: transcriptPath,
      cwd: tmp,
      hook_event_name: "Stop",
      last_assistant_message: "Done. Tests pass.",
    });
    expect(code, stderr).toBe(0);
    const report = onlyReport();
    expect(report.sessionId).toBe("session-midturn");
    expect(report.approvalStatus).toBe("pending");
  });

  // The 0.2.1 race fix: a report delivered as the final message must be
  // taken from the payload WITHOUT touching the transcript, which under
  // `claude -p` may not be flushed. An unreadable path proves the read
  // never happened.
  it("takes the report from the payload without reading the transcript (race fix preserved)", () => {
    const { code, stderr } = runStopHook({
      session_id: "session-race",
      transcript_path: join(tmp, "does-not-exist.jsonl"),
      cwd: tmp,
      hook_event_name: "Stop",
      last_assistant_message: FULL_REPORT_TEXT,
    });
    expect(code, stderr).toBe(0);
    expect(onlyReport().sessionId).toBe("session-race");
  });

  it("stamps the session from the payload, not from a sessionId the agent wrote in Metadata", () => {
    const forged = FULL_REPORT_TEXT.replace(
      "# Understanding Report",
      // fast_confirm: FULL_REPORT_TEXT has no Prior Art section, which
      // grill_me would require. The point of the test is the forged
      // `sessionId` line, not the mode.
      ["# Understanding Report", "", "## Metadata", "", "taskId: t-1", "mode: fast_confirm", "riskLevel: low", "sessionId: attacker-session"].join("\n"),
    );
    const { code, stderr } = runStopHook({
      session_id: "real-session",
      transcript_path: transcriptPath,
      cwd: tmp,
      hook_event_name: "Stop",
      last_assistant_message: forged,
    });
    expect(code, stderr).toBe(0);
    expect(onlyReport().sessionId).toBe("real-session");
  });

  it("still exits 0 and writes nothing when neither source carries a report", () => {
    writeTranscript("nothing here");
    const { code } = runStopHook({
      session_id: "session-none",
      transcript_path: transcriptPath,
      cwd: tmp,
      hook_event_name: "Stop",
      last_assistant_message: "also nothing here",
    });
    expect(code).toBe(0);
    expect(readdirSync(join(tmp, "reports")).filter((n) => n.endsWith(".json"))).toHaveLength(0);
  });
});
