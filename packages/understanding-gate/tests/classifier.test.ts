import { describe, it, expect } from "vitest";
import { isTaskLike } from "../src/classifier.js";

describe("isTaskLike", () => {
  describe("positive (task-like)", () => {
    it.each([
      ["EN verb + file path", "add a logout button to src/Header.tsx"],
      ["EN verb + file ext", "fix the bug in auth.ts"],
      ["EN verb + module hint", "refactor the auth module"],
      ["DE verb + file path", "Logout-Button in src/Header.tsx hinzufügen"],
      ["DE verb + class hint", "die Klasse User ändern"],
      [
        "EN verb + long prompt no file hint",
        "implement the new flow that handles every conceivable case the support team has reported across the last quarter so we can stop manually triaging tickets and start letting the system route them to the correct queue based on signals it already collects",
      ],
    ])("returns true for %s", (_label, prompt) => {
      expect(isTaskLike(prompt)).toBe(true);
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

    it("is case-insensitive on verbs", () => {
      expect(isTaskLike("ADD a button to App.tsx")).toBe(true);
      expect(isTaskLike("REFACTOR auth.ts")).toBe(true);
    });
  });
});
