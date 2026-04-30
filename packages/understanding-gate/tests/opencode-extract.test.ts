import { describe, expect, it } from "vitest";
import { extractAssistantText } from "../src/adapters/opencode/extract.js";

describe("extractAssistantText", () => {
  it("returns text concatenated from text-typed parts in the response data", () => {
    const r = {
      data: {
        info: { id: "m1", role: "assistant" },
        parts: [
          { type: "text", text: "first" },
          { type: "tool_use", input: {} },
          { type: "text", text: "second" },
        ],
      },
    };
    expect(extractAssistantText(r)).toBe("first\nsecond");
  });

  it("returns empty string for unknown response shapes", () => {
    expect(extractAssistantText(null)).toBe("");
    expect(extractAssistantText(undefined)).toBe("");
    expect(extractAssistantText("string")).toBe("");
    expect(extractAssistantText(42)).toBe("");
    expect(extractAssistantText({})).toBe("");
    expect(extractAssistantText({ data: null })).toBe("");
    expect(extractAssistantText({ data: { parts: "not array" } })).toBe("");
  });

  it("ignores parts without a string text field", () => {
    const r = {
      data: {
        parts: [
          { type: "text", text: null },
          { type: "text" },
          { type: "text", text: 42 },
          { type: "text", text: "ok" },
        ],
      },
    };
    expect(extractAssistantText(r)).toBe("ok");
  });

  it("trims trailing whitespace from the joined output", () => {
    const r = {
      data: {
        parts: [
          { type: "text", text: "  hello  " },
          { type: "text", text: "  world  \n\n" },
        ],
      },
    };
    // Each text is joined verbatim with `\n`, then String.trim() strips
    // only the outer whitespace/newlines. Inner whitespace is preserved.
    expect(extractAssistantText(r)).toBe("hello  \n  world");
  });
});
