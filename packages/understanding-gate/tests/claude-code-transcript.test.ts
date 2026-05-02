import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractLastAssistantText,
  parseTrailingAssistantText,
} from "../src/adapters/claude-code/transcript.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ug-transcript-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeJSONL(entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

describe("parseTrailingAssistantText", () => {
  it("returns the text of the most recent assistant turn (across multiple entries)", () => {
    const jsonl = makeJSONL([
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "old" }] },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "old reply" }] },
      },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "new prompt" }] } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "..." },
            { type: "text", text: "first assistant chunk" },
            { type: "tool_use", name: "Read", input: {} },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "second assistant chunk" },
          ],
        },
      },
    ]);
    expect(parseTrailingAssistantText(jsonl)).toBe(
      "first assistant chunk\nsecond assistant chunk",
    );
  });

  it("returns empty string when there is no trailing assistant entry", () => {
    const jsonl = makeJSONL([
      { type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    ]);
    expect(parseTrailingAssistantText(jsonl)).toBe("");
  });

  it("returns empty string for empty input", () => {
    expect(parseTrailingAssistantText("")).toBe("");
  });

  it("ignores tool_use and thinking blocks", () => {
    const jsonl = makeJSONL([
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal" },
            { type: "tool_use", name: "Read", input: {} },
          ],
        },
      },
    ]);
    expect(parseTrailingAssistantText(jsonl)).toBe("");
  });

  it("skips unparseable lines without crashing", () => {
    const jsonl = [
      "not json",
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      }),
    ].join("\n");
    expect(parseTrailingAssistantText(jsonl)).toBe("ok");
  });

  it("walks past tool-result user entries within the same turn", () => {
    // Real Claude Code shape: type:"user" + toolUseResult means a tool
    // roundtrip, NOT a human turn boundary. The walk must continue.
    const jsonl = makeJSONL([
      { type: "user", message: { role: "user", content: [{ type: "text", text: "real prompt" }] } },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "first half of report" }] },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: {} }] },
      },
      {
        type: "user",
        toolUseResult: { stdout: "..." },
        sourceToolAssistantUUID: "abc",
        message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "second half of report" }] },
      },
    ]);
    expect(parseTrailingAssistantText(jsonl)).toBe(
      "first half of report\nsecond half of report",
    );
  });

  it("recognises a human turn that immediately follows tool-result without text content", () => {
    const jsonl = makeJSONL([
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "old reply" }] },
      },
      // tool-result with no toolUseResult field, but content is exclusively tool_result
      // blocks: still treated as non-human boundary.
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", content: "x" }] },
      },
      // real human prompt with text content
      {
        type: "user",
        message: { role: "user", content: [{ type: "text", text: "new prompt" }] },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "current reply" }] },
      },
    ]);
    expect(parseTrailingAssistantText(jsonl)).toBe("current reply");
  });

  // 0.2.1 dogfood regression: under `claude -p`, the agent's flow is
  // typically [text(report)] → [tool_use(Read)] → [user(tool_result)]
  // → [tool_use(Edit blocked)] → [user(tool_result)] → [text(final)].
  // Each tool_use lives in its own assistant entry (no embedded text).
  // The walk must collect text from BOTH the preamble entry and the
  // post-block entry so the marker is visible to the parser.
  it("collects assistant text across tool_use boundaries (claude -p preamble pattern)", () => {
    const jsonl = makeJSONL([
      // human prompt with a STRING content (claude -p shape, not array)
      {
        type: "user",
        message: { role: "user", content: "add a farewell function" },
      },
      // turn-1: text preamble (the report) — a separate assistant entry
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "# Understanding Report\n\n### 1. My current understanding\nadd farewell" },
          ],
        },
      },
      // turn-1 cont'd: pure tool_use entry, no text
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Read", input: { path: "x" } }],
        },
      },
      // tool_result lands as user entry — must NOT terminate the walk
      {
        type: "user",
        toolUseResult: { ok: true },
        message: { role: "user", content: [{ type: "tool_result", content: "ok" }] },
      },
      // another tool_use entry, no text
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Edit", input: {} }],
        },
      },
      // deny tool_result
      {
        type: "user",
        toolUseResult: { ok: false },
        message: { role: "user", content: [{ type: "tool_result", content: "blocked" }] },
      },
      // final assistant text after the block
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "I won't bypass the hook." }],
        },
      },
    ]);
    const out = parseTrailingAssistantText(jsonl);
    expect(out).toContain("# Understanding Report");
    expect(out).toContain("### 1. My current understanding");
    expect(out).toContain("I won't bypass the hook.");
  });

  it("handles CRLF line endings", () => {
    const jsonl = makeJSONL([
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "crlf works" }] },
      },
    ]).replace(/\n/g, "\r\n");
    expect(parseTrailingAssistantText(jsonl)).toBe("crlf works");
  });
});

describe("extractLastAssistantText (with fs)", () => {
  it("returns text read from a real transcript file", () => {
    const path = join(tmp, "transcript.jsonl");
    writeFileSync(
      path,
      makeJSONL([
        {
          type: "assistant",
          message: { role: "assistant", content: [{ type: "text", text: "from disk" }] },
        },
      ]),
      "utf8",
    );
    expect(extractLastAssistantText(path)).toBe("from disk");
  });

  it("returns empty string when the file is missing (does not throw)", () => {
    expect(extractLastAssistantText(join(tmp, "nope.jsonl"))).toBe("");
  });
});
