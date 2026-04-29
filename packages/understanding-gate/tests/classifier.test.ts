import { describe, it, expect } from "vitest";
import { isTaskLike } from "../src/classifier.js";

const EN_VERBS = [
  "add",
  "fix",
  "implement",
  "build",
  "create",
  "refactor",
  "remove",
  "change",
  "update",
  "migrate",
] as const;

const DE_VERBS = [
  "ändern",
  "hinzufügen",
  "bauen",
  "umbauen",
  "löschen",
  "ersetzen",
] as const;

describe("isTaskLike", () => {
  describe("positive: every EN verb with a file hint matches", () => {
    it.each(EN_VERBS)("verb '%s' + .ts file → true", (verb) => {
      expect(isTaskLike(`please ${verb} the helper in src/foo.ts`)).toBe(true);
    });
  });

  describe("positive: every DE verb with a file hint matches", () => {
    it.each(DE_VERBS)("verb '%s' + DE keyword 'klasse' → true", (verb) => {
      expect(isTaskLike(`die Klasse User ${verb}`)).toBe(true);
    });
  });

  describe("positive: long-prompt fallthrough without file hint", () => {
    it("verb + length>200 → true even without file hint", () => {
      const prompt =
        "implement the new flow that handles every conceivable case the support team has reported across the last quarter so we can stop manually triaging tickets and start letting the system route them to the correct queue";
      expect(prompt.length).toBeGreaterThan(200);
      expect(isTaskLike(prompt)).toBe(true);
    });
  });

  describe("boundary: 200-char threshold", () => {
    it("length === 200 with verb but no file hint → false (strict >, not >=)", () => {
      const prefix = "fix this thing ";
      const padding = "x".repeat(200 - prefix.length);
      const prompt = `${prefix}${padding}`;
      expect(prompt.length).toBe(200);
      expect(isTaskLike(prompt)).toBe(false);
    });

    it("length === 201 with verb but no file hint → true", () => {
      const prefix = "fix this thing ";
      const padding = "x".repeat(201 - prefix.length);
      const prompt = `${prefix}${padding}`;
      expect(prompt.length).toBe(201);
      expect(isTaskLike(prompt)).toBe(true);
    });
  });

  describe("substring guard: DE lookaround must not over-fire", () => {
    it("rejects 'verändern' (substring of 'ändern')", () => {
      expect(
        isTaskLike("die App soll sich nicht verändern in Klasse X"),
      ).toBe(false);
    });
  });

  describe("negative (not task-like)", () => {
    it.each([
      ["question word, no verb", "what does jq -r do?"],
      ["status check", "how is the deploy going"],
      ["concept question", "explain how vitest fixtures work"],
      ["empty string", ""],
      ["verb without file or length", "fix"],
      ["verb without file, short", "please fix it"],
    ])("returns false for %s", (_label, prompt) => {
      expect(isTaskLike(prompt)).toBe(false);
    });
  });

  describe("input hardening", () => {
    it("returns false for non-string input", () => {
      // @ts-expect-error verifying runtime safety
      expect(isTaskLike(undefined)).toBe(false);
      // @ts-expect-error
      expect(isTaskLike(null)).toBe(false);
      // @ts-expect-error
      expect(isTaskLike(123)).toBe(false);
    });

    it("is case-insensitive on verbs and file hints", () => {
      expect(isTaskLike("ADD a button to App.tsx")).toBe(true);
      expect(isTaskLike("REFACTOR auth.ts")).toBe(true);
    });
  });
});
