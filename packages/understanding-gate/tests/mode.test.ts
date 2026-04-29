import { describe, it, expect } from "vitest";
import { pickMode } from "../src/mode.js";

describe("pickMode", () => {
  describe("default", () => {
    it("returns fast_confirm with empty env and no marker", () => {
      expect(pickMode("add a button to App.tsx", {})).toBe("fast_confirm");
    });
  });

  describe("ENV override (highest precedence)", () => {
    it("respects UNDERSTANDING_GATE_MODE=grill_me", () => {
      expect(
        pickMode("trivial question", { UNDERSTANDING_GATE_MODE: "grill_me" }),
      ).toBe("grill_me");
    });

    it("respects UNDERSTANDING_GATE_MODE=fast_confirm even with marker", () => {
      expect(
        pickMode("grill me on auth", {
          UNDERSTANDING_GATE_MODE: "fast_confirm",
        }),
      ).toBe("fast_confirm");
    });

    it("ignores unknown ENV value, falls through to marker/default", () => {
      expect(
        pickMode("a normal prompt", { UNDERSTANDING_GATE_MODE: "garbage" }),
      ).toBe("fast_confirm");
      expect(
        pickMode("grill me please", { UNDERSTANDING_GATE_MODE: "garbage" }),
      ).toBe("grill_me");
    });

    it("trims and lowercases ENV value", () => {
      expect(
        pickMode("x", { UNDERSTANDING_GATE_MODE: "  GRILL_ME  " }),
      ).toBe("grill_me");
    });
  });

  describe("in-prompt marker", () => {
    it("returns grill_me when prompt starts with 'grill me'", () => {
      expect(pickMode("grill me on this auth flow")).toBe("grill_me");
    });

    it("returns grill_me for slash command /grill", () => {
      expect(pickMode("/grill the migration plan", {})).toBe("grill_me");
    });

    it("returns grill_me for slash command /grill-me", () => {
      expect(pickMode("/grill-me", {})).toBe("grill_me");
    });

    it("matches case-insensitively", () => {
      expect(pickMode("GRILL ME on the design", {})).toBe("grill_me");
      expect(pickMode("Please /Grill the doc", {})).toBe("grill_me");
    });

    it("does NOT match substring like 'angrill' or 'megrillen'", () => {
      expect(pickMode("angrill the metrics dashboard", {})).toBe(
        "fast_confirm",
      );
    });
  });

  describe("input hardening", () => {
    it("returns fast_confirm for non-string prompt with empty env", () => {
      // @ts-expect-error verifying runtime safety
      expect(pickMode(undefined, {})).toBe("fast_confirm");
    });
  });
});
