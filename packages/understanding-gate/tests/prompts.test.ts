import { describe, it, expect } from "vitest";
import {
  getPromptSnippet,
  FAST_CONFIRM_PROMPT,
  GRILL_ME_PROMPT,
  FULL_PROMPT,
} from "../src/prompts.js";

describe("getPromptSnippet", () => {
  it("returns FAST_CONFIRM_PROMPT for fast_confirm", () => {
    expect(getPromptSnippet("fast_confirm")).toBe(FAST_CONFIRM_PROMPT);
  });

  it("returns GRILL_ME_PROMPT for grill_me", () => {
    expect(getPromptSnippet("grill_me")).toBe(GRILL_ME_PROMPT);
  });
});

describe("prompt snippets", () => {
  it("fast-confirm prompt is non-empty and mentions 'confirmed'", () => {
    expect(FAST_CONFIRM_PROMPT.length).toBeGreaterThan(50);
    expect(FAST_CONFIRM_PROMPT).toMatch(/confirmed/i);
  });

  it("grill-me prompt is non-empty and mentions 'grill me'", () => {
    expect(GRILL_ME_PROMPT.length).toBeGreaterThan(50);
    expect(GRILL_ME_PROMPT).toMatch(/grill me/i);
  });

  it("full prompt enumerates all 9 report sections", () => {
    expect(FULL_PROMPT).toMatch(/My current understanding/);
    expect(FULL_PROMPT).toMatch(/Intended outcome/);
    expect(FULL_PROMPT).toMatch(/Derived todos/);
    expect(FULL_PROMPT).toMatch(/Acceptance criteria/);
    expect(FULL_PROMPT).toMatch(/Assumptions/);
    expect(FULL_PROMPT).toMatch(/Open questions/);
    expect(FULL_PROMPT).toMatch(/Out of scope/);
    expect(FULL_PROMPT).toMatch(/Risks/);
    expect(FULL_PROMPT).toMatch(/Verification plan/);
  });
});
