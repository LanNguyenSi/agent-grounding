import { describe, it, expect } from "vitest";
import { handleUserPromptSubmit } from "../src/adapters/claude-code/handle.js";

const TASK_PROMPT = "add a logout button to src/Header.tsx";
const NON_TASK_PROMPT = "what does jq -r do?";

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
});
