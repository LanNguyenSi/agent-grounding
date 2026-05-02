import { describe, it, expect } from "vitest";
import {
  getPromptSnippet,
  FAST_CONFIRM_PROMPT,
  GRILL_ME_PROMPT,
  FULL_PROMPT,
} from "../src/prompts.js";
import { parseReport } from "../src/core/parser.js";

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

  it("templates instruct the agent to begin with the `# Understanding Report` marker", () => {
    // 0.2.1 dogfood revealed the agent followed the prescribed sections
    // but skipped the top-level `# Understanding Report` heading the
    // Stop hook's marker regex looks for. The instruction is now
    // explicit in both grill_me and full templates.
    expect(GRILL_ME_PROMPT).toMatch(/`# Understanding Report`/);
    expect(FULL_PROMPT).toMatch(/`# Understanding Report`/);
  });

  it("grill-me prompt enumerates all 9 report sections (0.2.1 alignment)", () => {
    // Regression: the original prose-only grill_me let the agent improvise
    // its own headings, which the Stop-hook parser then rejected. Phase 2
    // approve flow couldn't close because nothing landed in reports/.
    expect(GRILL_ME_PROMPT).toMatch(/My current understanding/);
    expect(GRILL_ME_PROMPT).toMatch(/Intended outcome/);
    expect(GRILL_ME_PROMPT).toMatch(/Derived todos/);
    expect(GRILL_ME_PROMPT).toMatch(/Acceptance criteria/);
    expect(GRILL_ME_PROMPT).toMatch(/Assumptions/);
    expect(GRILL_ME_PROMPT).toMatch(/Open questions/);
    expect(GRILL_ME_PROMPT).toMatch(/Out of scope/);
    expect(GRILL_ME_PROMPT).toMatch(/Risks/);
    expect(GRILL_ME_PROMPT).toMatch(/Verification plan/);
  });
});

// Roundtrip proof: an agent that follows the template (using its
// section headings verbatim) produces a report that parseReport
// accepts. This is the contract the Phase 2 approve flow depends on.
//
// The strategy: take each prompt's body as a starting scaffold, fill
// every section's body with one plausible bullet/sentence, prepend
// "# Understanding Report", and feed it to the parser. We don't try
// to re-run the prompt against an LLM; we model the agent's "fill in
// the template" behavior directly.
describe("prompt roundtrip: parseReport accepts what the template asks for", () => {
  function fillTemplate(snippet: string): string {
    // Simple replacement: each ### heading's body line gets a fixed
    // exemplar. Lists become a one-bullet list; paragraphs become one
    // sentence. The exemplar is enough to satisfy the parser's
    // non-empty-body requirement.
    const lines = snippet.split(/\r?\n/);
    const out: string[] = ["# Understanding Report", ""];
    let i = 0;
    let activeSection: string | null = null;
    while (i < lines.length) {
      const line = lines[i];
      const headingMatch = line.match(/^###\s+(?:\d+\.\s*)?(.+?)\s*$/);
      if (headingMatch) {
        activeSection = headingMatch[1].trim().toLowerCase();
        out.push(line);
        // skip the original explanatory body until the next heading or
        // blank-blank boundary; replace with a placeholder body.
        out.push(bodyFor(activeSection));
        // Advance past the original body lines (until next heading or
        // non-body marker like "End with:").
        i++;
        while (
          i < lines.length &&
          !/^###\s+/.test(lines[i]) &&
          !/^End with:/.test(lines[i])
        ) {
          i++;
        }
        continue;
      }
      i++;
    }
    return out.join("\n");
  }

  function bodyFor(headingLower: string): string {
    // List sections — emit a single bullet. Paragraph sections — emit
    // one sentence. Heading text matches the template's section names.
    if (headingLower.includes("understanding")) return "We need to add feature X.";
    if (headingLower.includes("intended outcome")) return "Feature X is shipped.";
    if (headingLower.includes("derived todos")) return "- implement X";
    if (headingLower.includes("acceptance criteria")) return "- X behaves as specified";
    if (headingLower === "assumptions" || headingLower.startsWith("assumptions"))
      return "- TypeScript project";
    if (headingLower.includes("open questions")) return "- exact wording?";
    if (headingLower.includes("out of scope")) return "- unrelated refactors";
    if (headingLower === "risks" || headingLower.startsWith("risks"))
      return "- regression in adjacent code";
    if (headingLower.includes("verification")) return "- run vitest after the change";
    return "(placeholder)";
  }

  it("FULL_PROMPT body fills cleanly into a parseable report", () => {
    const filled = fillTemplate(FULL_PROMPT);
    const result = parseReport(filled, {
      taskId: "t",
      mode: "fast_confirm",
      riskLevel: "low",
    });
    if (!result.ok) {
      throw new Error(
        `parseReport rejected FULL_PROMPT roundtrip: ${result.error.reason} / ${result.error.message}`,
      );
    }
    expect(result.ok).toBe(true);
  });

  it("GRILL_ME_PROMPT body fills cleanly into a parseable report (0.2.1 alignment)", () => {
    const filled = fillTemplate(GRILL_ME_PROMPT);
    const result = parseReport(filled, {
      taskId: "t",
      mode: "grill_me",
      riskLevel: "high",
    });
    if (!result.ok) {
      throw new Error(
        `parseReport rejected GRILL_ME_PROMPT roundtrip: ${result.error.reason} / ${result.error.message}`,
      );
    }
    expect(result.ok).toBe(true);
  });
});
