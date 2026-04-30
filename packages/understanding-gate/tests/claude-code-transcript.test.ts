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
