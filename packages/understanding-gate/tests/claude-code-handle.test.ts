import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleUserPromptSubmit } from "../src/adapters/claude-code/handle.js";

const TASK_PROMPT = "add a logout button to src/Header.tsx";
const NON_TASK_PROMPT = "what does jq -r do?";
const TASK_NOTIFICATION_HULL_PROMPT =
  '<task-notification kind="subagent_completion">add a logout button to src/Header.tsx</task-notification>';

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: string;
    additionalContext: string;
  };
}

function parseOutput(out: string): HookOutput {
  return JSON.parse(out.trim()) as HookOutput;
}

describe("handleUserPromptSubmit", () => {
  describe("positive (task-like prompt)", () => {
    it("emits hookSpecificOutput JSON wrapping the fast_confirm snippet", () => {
      const out = handleUserPromptSubmit(
        JSON.stringify({ prompt: TASK_PROMPT }),
      );
      expect(out).not.toBe("");
      const parsed = parseOutput(out);
      expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
      expect(parsed.hookSpecificOutput.additionalContext).toMatch(
        /<understanding-gate mode="fast_confirm">/,
      );
      expect(parsed.hookSpecificOutput.additionalContext).toMatch(
        /<\/understanding-gate>/,
      );
      expect(parsed.hookSpecificOutput.additionalContext).toMatch(
        /Fast Confirm Mode/,
      );
    });

    it("emits trailing newline so the harness can split JSON streams cleanly", () => {
      const out = handleUserPromptSubmit(
        JSON.stringify({ prompt: TASK_PROMPT }),
      );
      expect(out.endsWith("\n")).toBe(true);
    });
  });

  describe("negative (not task-like)", () => {
    it("returns empty string for a non-task prompt", () => {
      expect(
        handleUserPromptSubmit(JSON.stringify({ prompt: NON_TASK_PROMPT })),
      ).toBe("");
    });

    it("returns empty string for empty prompt field", () => {
      expect(handleUserPromptSubmit(JSON.stringify({ prompt: "" }))).toBe("");
    });

    it("returns empty string when prompt field is missing", () => {
      expect(handleUserPromptSubmit(JSON.stringify({}))).toBe("");
    });
  });

  describe("ENV overrides", () => {
    it("UNDERSTANDING_GATE_MODE=grill_me upgrades to grill_me snippet", () => {
      const out = handleUserPromptSubmit(
        JSON.stringify({ prompt: TASK_PROMPT }),
        { UNDERSTANDING_GATE_MODE: "grill_me" },
      );
      expect(out).not.toBe("");
      const parsed = parseOutput(out);
      expect(parsed.hookSpecificOutput.additionalContext).toMatch(
        /<understanding-gate mode="grill_me">/,
      );
      expect(parsed.hookSpecificOutput.additionalContext).toMatch(
        /Grill-Me Mode/,
      );
    });

    it("UNDERSTANDING_GATE_DISABLE=1 returns empty regardless of input", () => {
      expect(
        handleUserPromptSubmit(JSON.stringify({ prompt: TASK_PROMPT }), {
          UNDERSTANDING_GATE_DISABLE: "1",
        }),
      ).toBe("");
    });

    it("UNDERSTANDING_GATE_DISABLE=true also disables", () => {
      expect(
        handleUserPromptSubmit(JSON.stringify({ prompt: TASK_PROMPT }), {
          UNDERSTANDING_GATE_DISABLE: "true",
        }),
      ).toBe("");
    });

    it("UNDERSTANDING_GATE_DISABLE=0 does NOT disable", () => {
      const out = handleUserPromptSubmit(
        JSON.stringify({ prompt: TASK_PROMPT }),
        { UNDERSTANDING_GATE_DISABLE: "0" },
      );
      expect(out).not.toBe("");
    });
  });

  describe("malformed input (must never crash)", () => {
    it("returns empty for empty stdin", () => {
      expect(handleUserPromptSubmit("")).toBe("");
    });

    it("returns empty for non-JSON garbage", () => {
      expect(handleUserPromptSubmit("not json at all {")).toBe("");
    });

    it("returns empty for JSON with non-string prompt field", () => {
      expect(handleUserPromptSubmit(JSON.stringify({ prompt: 42 }))).toBe("");
      expect(
        handleUserPromptSubmit(JSON.stringify({ prompt: { nested: "x" } })),
      ).toBe("");
    });

    it("returns empty for JSON array (not an object)", () => {
      expect(handleUserPromptSubmit("[1,2,3]")).toBe("");
    });

    it("returns empty for JSON literal null (must not throw on .prompt access)", () => {
      expect(handleUserPromptSubmit("null")).toBe("");
    });

    it("returns empty for JSON literal true/number/string (no .prompt)", () => {
      expect(handleUserPromptSubmit("true")).toBe("");
      expect(handleUserPromptSubmit("123")).toBe("");
      expect(handleUserPromptSubmit('"just a string"')).toBe("");
    });

    it("ignores extra fields like cwd/session_id without crashing", () => {
      const out = handleUserPromptSubmit(
        JSON.stringify({
          prompt: "add a logout button to src/Header.tsx",
          cwd: "/tmp/repo",
          session_id: "abc123",
          transcript_path: "/tmp/transcript.jsonl",
          permission_mode: "default",
        }),
      );
      expect(out).not.toBe("");
      const parsed = parseOutput(out);
      expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    });
  });

  describe("harness hull guard (AC4)", () => {
    it("does not inject when the prompt IS a task-notification hull", () => {
      expect(
        handleUserPromptSubmit(
          JSON.stringify({ prompt: TASK_NOTIFICATION_HULL_PROMPT }),
        ),
      ).toBe("");
    });

    it("does not inject when the hull is preceded only by whitespace", () => {
      expect(
        handleUserPromptSubmit(
          JSON.stringify({ prompt: `  \n${TASK_NOTIFICATION_HULL_PROMPT}` }),
        ),
      ).toBe("");
    });

    it("still injects for a genuine operator prompt (positive control)", () => {
      const out = handleUserPromptSubmit(
        JSON.stringify({ prompt: TASK_PROMPT }),
      );
      expect(out).not.toBe("");
    });

    it("still injects when the operator merely mentions the words task-notification mid-message", () => {
      const out = handleUserPromptSubmit(
        JSON.stringify({
          prompt:
            "fix src/Header.tsx: the task-notification handler in it is broken",
        }),
      );
      expect(out).not.toBe("");
    });
  });

  describe("pause sentinel (AC1-AC3)", () => {
    let dir: string;

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    function sentinelFile(content: unknown): string {
      dir = mkdtempSync(join(tmpdir(), "understanding-gate-pause-"));
      const file = join(dir, "sentinel.json");
      writeFileSync(
        file,
        typeof content === "string" ? content : JSON.stringify(content),
      );
      return file;
    }

    it("AC1: suppresses injection when the sentinel is active (future expiresAt)", () => {
      const file = sentinelFile({
        pausedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        reason: "test",
        pausedBy: "test",
      });
      const out = handleUserPromptSubmit(
        JSON.stringify({ prompt: TASK_PROMPT }),
        { UNDERSTANDING_GATE_PAUSE_FILE: file },
      );
      expect(out).toBe("");
    });

    it("AC3: expiresAt null (indefinite) suppresses injection", () => {
      const file = sentinelFile({
        pausedAt: new Date().toISOString(),
        expiresAt: null,
        reason: "test",
        pausedBy: "test",
      });
      const out = handleUserPromptSubmit(
        JSON.stringify({ prompt: TASK_PROMPT }),
        { UNDERSTANDING_GATE_PAUSE_FILE: file },
      );
      expect(out).toBe("");
    });

    it("AC2: an EXPIRED sentinel does not suppress injection (negative control)", () => {
      const file = sentinelFile({
        pausedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        expiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        reason: "test",
        pausedBy: "test",
      });
      const out = handleUserPromptSubmit(
        JSON.stringify({ prompt: TASK_PROMPT }),
        { UNDERSTANDING_GATE_PAUSE_FILE: file },
      );
      expect(out).not.toBe("");
    });

    it("AC2: UNDERSTANDING_GATE_PAUSE_FILE unset does not suppress injection", () => {
      const out = handleUserPromptSubmit(
        JSON.stringify({ prompt: TASK_PROMPT }),
      );
      expect(out).not.toBe("");
    });

    it("AC2: a missing sentinel file does not suppress injection", () => {
      const out = handleUserPromptSubmit(
        JSON.stringify({ prompt: TASK_PROMPT }),
        {
          UNDERSTANDING_GATE_PAUSE_FILE:
            "/nonexistent/path/does-not-exist.json",
        },
      );
      expect(out).not.toBe("");
    });

    it("AC2: broken JSON in the sentinel file does not suppress injection", () => {
      const file = sentinelFile("not json at all {");
      const out = handleUserPromptSubmit(
        JSON.stringify({ prompt: TASK_PROMPT }),
        { UNDERSTANDING_GATE_PAUSE_FILE: file },
      );
      expect(out).not.toBe("");
    });

    it("a sentinel missing the expiresAt field entirely does not suppress injection", () => {
      const file = sentinelFile({
        pausedAt: new Date().toISOString(),
        reason: "test",
        pausedBy: "test",
      });
      const out = handleUserPromptSubmit(
        JSON.stringify({ prompt: TASK_PROMPT }),
        { UNDERSTANDING_GATE_PAUSE_FILE: file },
      );
      expect(out).not.toBe("");
    });

    it("a sentinel with an unparsable expiresAt string does not suppress injection", () => {
      const file = sentinelFile({
        pausedAt: new Date().toISOString(),
        expiresAt: "not-a-date",
        reason: "test",
        pausedBy: "test",
      });
      const out = handleUserPromptSubmit(
        JSON.stringify({ prompt: TASK_PROMPT }),
        { UNDERSTANDING_GATE_PAUSE_FILE: file },
      );
      expect(out).not.toBe("");
    });
  });
});
