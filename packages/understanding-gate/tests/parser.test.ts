import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseReport } from "../src/core/parser.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PARSER_SOURCE = readFileSync(
  resolve(__dirname, "../src/core/parser.ts"),
  "utf8",
);

const FULL_MARKDOWN = `# Understanding Report

### 1. My current understanding
The user wants a parser for the Understanding Report.
It should reject malformed input.

### 2. Intended outcome
\`parseReport\` returns a typed object validated against the schema.

### 3. Derived todos / specs
- write the parser
- add ajv validation
- ship under @lannguyensi/understanding-gate

### 4. Acceptance criteria
- round-trip succeeds
- missing sections detected
- schema violations surfaced

### 5. Assumptions
- ajv is available as a runtime dep
- agent emits sections in order

### 6. Open questions
- where does taskId come from?
- should we accept yaml frontmatter?

### 7. Out of scope
- LLM-assisted recovery
- persistence

### 8. Risks
- false negatives on heading variants

### 9. Verification plan
- unit tests
- dogfood once 1.3 lands

## Metadata
taskId: ug-test-1
mode: grill_me
riskLevel: high
requiresHumanApproval: true
approvalStatus: pending
`;

describe("parseReport: full round-trip", () => {
  it("recovers all 9 required sections + metadata", () => {
    const r = parseReport(FULL_MARKDOWN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.taskId).toBe("ug-test-1");
    expect(r.report.mode).toBe("grill_me");
    expect(r.report.riskLevel).toBe("high");
    expect(r.report.requiresHumanApproval).toBe(true);
    expect(r.report.approvalStatus).toBe("pending");
    expect(r.report.currentUnderstanding).toContain(
      "wants a parser for the Understanding Report",
    );
    expect(r.report.intendedOutcome).toContain("typed object");
    expect(r.report.derivedTodos).toEqual([
      "write the parser",
      "add ajv validation",
      "ship under @lannguyensi/understanding-gate",
    ]);
    expect(r.report.acceptanceCriteria).toHaveLength(3);
    expect(r.report.assumptions).toHaveLength(2);
    expect(r.report.openQuestions).toHaveLength(2);
    expect(r.report.outOfScope).toEqual(["LLM-assisted recovery", "persistence"]);
    expect(r.report.risks).toEqual(["false negatives on heading variants"]);
    expect(r.report.verificationPlan).toEqual([
      "unit tests",
      "dogfood once 1.3 lands",
    ]);
  });

  it("uses caller-supplied defaults when no metadata block is present", () => {
    const noMeta = FULL_MARKDOWN.split("## Metadata")[0];
    const r = parseReport(noMeta, {
      taskId: "from-defaults",
      mode: "fast_confirm",
      riskLevel: "medium",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.taskId).toBe("from-defaults");
    expect(r.report.mode).toBe("fast_confirm");
    expect(r.report.riskLevel).toBe("medium");
    expect(r.report.requiresHumanApproval).toBe(true); // baseline default
    expect(r.report.approvalStatus).toBe("pending");
  });

  it("metadata block overrides defaults", () => {
    const r = parseReport(FULL_MARKDOWN, {
      taskId: "should-be-overridden",
      mode: "fast_confirm",
      riskLevel: "low",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.taskId).toBe("ug-test-1");
    expect(r.report.mode).toBe("grill_me");
    expect(r.report.riskLevel).toBe("high");
  });
});

describe("parseReport: missing sections", () => {
  it("returns ok:false with the missing key listed when assumptions section is dropped", () => {
    const md = FULL_MARKDOWN.replace(
      /### 5\. Assumptions[\s\S]*?(?=### 6\.)/,
      "",
    );
    const r = parseReport(md);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("missing_sections");
    expect(r.error.missing).toContain("assumptions");
  });

  it("returns ok:false on empty input", () => {
    const r = parseReport("");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("no_report_found");
  });

  it("treats an empty list section as missing", () => {
    const md = FULL_MARKDOWN.replace(
      /### 8\. Risks[\s\S]*?(?=### 9\.)/,
      "### 8. Risks\n\n",
    );
    const r = parseReport(md);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.missing).toContain("risks");
  });
});

describe("parseReport: schema violations", () => {
  it("rejects an out-of-enum mode value from metadata", () => {
    const md = FULL_MARKDOWN.replace("mode: grill_me", "mode: weird");
    const r = parseReport(md);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("schema_violation");
    expect(r.error.schemaErrors.length).toBeGreaterThan(0);
    expect(
      r.error.schemaErrors.some(
        (e) => e.path === "/mode" && /must be equal to/.test(e.message),
      ),
    ).toBe(true);
  });

  it("rejects a missing taskId when neither defaults nor metadata supply it", () => {
    const noMeta = FULL_MARKDOWN.split("## Metadata")[0];
    const r = parseReport(noMeta, { mode: "fast_confirm", riskLevel: "low" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("schema_violation");
    expect(r.error.missing).toContain("taskId");
  });

  it("rejects an invalid createdAt format", () => {
    const md = FULL_MARKDOWN + "createdAt: not-a-date\n";
    const r = parseReport(md);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("schema_violation");
  });
});

describe("parseReport: heading-level tolerance", () => {
  function rewriteHeadings(md: string, level: "#" | "##" | "###"): string {
    return md.replace(/^#{1,6}\s+/gm, `${level} `);
  }

  it("parses identical content under #, ##, and ###", () => {
    const a = parseReport(rewriteHeadings(FULL_MARKDOWN, "#"));
    const b = parseReport(rewriteHeadings(FULL_MARKDOWN, "##"));
    const c = parseReport(rewriteHeadings(FULL_MARKDOWN, "###"));
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!a.ok || !b.ok || !c.ok) return;
    expect(a.report).toEqual(b.report);
    expect(b.report).toEqual(c.report);
  });

  it("strips numeric prefixes and is case-insensitive", () => {
    const md = FULL_MARKDOWN
      .replace("My current understanding", "MY CURRENT UNDERSTANDING")
      .replace("### 1.", "###");
    const r = parseReport(md);
    expect(r.ok).toBe(true);
  });

  it("ignores trailing closing # markers in headings", () => {
    const md = FULL_MARKDOWN.replace(
      "### 5. Assumptions",
      "### 5. Assumptions ###",
    );
    const r = parseReport(md);
    expect(r.ok).toBe(true);
  });
});

describe("parseReport: list parsing", () => {
  function withList(items: string): string {
    const SENTINEL = "__LIST_PLACEHOLDER__";
    const replaced = FULL_MARKDOWN.replace(
      /### 3\. Derived todos \/ specs[\s\S]*?(?=### 4\.)/,
      `### 3. Derived todos / specs\n${SENTINEL}\n`,
    );
    if (!replaced.includes(SENTINEL)) {
      throw new Error(
        "withList: section heading text drifted; update the regex above",
      );
    }
    return replaced.replace(SENTINEL, items);
  }

  it("accepts unordered lists with - and * markers", () => {
    const r = parseReport(withList("- a\n* b\n- c"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.derivedTodos).toEqual(["a", "b", "c"]);
  });

  it("accepts ordered lists", () => {
    const r = parseReport(withList("1. a\n2. b\n3. c"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.derivedTodos).toEqual(["a", "b", "c"]);
  });

  it("joins indented continuation lines into the previous item", () => {
    const r = parseReport(withList("- first item\n  with continuation\n- second"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.derivedTodos).toEqual([
      "first item with continuation",
      "second",
    ]);
  });

  it("does NOT silently absorb non-indented prose between bullets", () => {
    const r = parseReport(
      withList("- alpha\nthis is stray prose, not indented\n- beta"),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.derivedTodos).toEqual(["alpha", "beta"]);
  });

  it("attaches an indented continuation that follows a blank line", () => {
    const r = parseReport(withList("- alpha\n\n  with continuation\n- beta"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.derivedTodos).toEqual([
      "alpha with continuation",
      "beta",
    ]);
  });
});

describe("parseReport: purity (no fs / network)", () => {
  // Static check: parser.ts must not import any I/O module. Spying on
  // node:fs under ESM is unreliable (TypeError: Cannot redefine property),
  // so we lock the contract at the source level instead.
  it("does not import any node I/O modules", () => {
    const forbidden = [
      /from\s+["']node:fs["']/,
      /from\s+["']fs["']/,
      /from\s+["']node:net["']/,
      /from\s+["']node:http["']/,
      /from\s+["']node:https["']/,
      /from\s+["']node:dns["']/,
      /from\s+["']node:child_process["']/,
      /\bfetch\s*\(/,
      /require\(["']fs["']\)/,
    ];
    for (const re of forbidden) {
      expect(re.test(PARSER_SOURCE), `parser.ts must not match ${re}`).toBe(false);
    }
  });
});

describe("parseReport: fenced code blocks", () => {
  it("ignores section headings that appear inside ``` fences", () => {
    const md = [
      "Here is the template I will follow:",
      "",
      "```",
      "### 1. My current understanding",
      "PLACEHOLDER from the prompt",
      "### 8. Risks",
      "- placeholder risk",
      "```",
      "",
      FULL_MARKDOWN,
    ].join("\n");
    const r = parseReport(md);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.currentUnderstanding).toContain(
      "wants a parser",
    );
    expect(r.report.risks).toEqual([
      "false negatives on heading variants",
    ]);
  });

  it("ignores section headings inside ~~~ fences too", () => {
    const md = [
      "~~~",
      "### 9. Verification plan",
      "- placeholder",
      "~~~",
      FULL_MARKDOWN,
    ].join("\n");
    const r = parseReport(md);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.verificationPlan).toEqual([
      "unit tests",
      "dogfood once 1.3 lands",
    ]);
  });
});

describe("parseReport: input encoding", () => {
  it("strips a leading UTF-8 BOM", () => {
    const r = parseReport("﻿" + FULL_MARKDOWN);
    expect(r.ok).toBe(true);
  });

  it("accepts CRLF line endings", () => {
    const r = parseReport(FULL_MARKDOWN.replace(/\n/g, "\r\n"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.derivedTodos).toEqual([
      "write the parser",
      "add ajv validation",
      "ship under @lannguyensi/understanding-gate",
    ]);
  });
});

describe("parseReport: structural edge cases", () => {
  it("handles a metadata block placed BEFORE the section headings", () => {
    const sectionsOnly = FULL_MARKDOWN.split("## Metadata")[0];
    const metaBlock = "## Metadata\ntaskId: ug-meta-first\nmode: fast_confirm\nriskLevel: low\n";
    const md = `# Understanding Report\n\n${metaBlock}\n${sectionsOnly}`;
    const r = parseReport(md);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.taskId).toBe("ug-meta-first");
    expect(r.report.mode).toBe("fast_confirm");
    expect(r.report.riskLevel).toBe("low");
  });

  it("on duplicate section headings, takes the first occurrence", () => {
    const dup = FULL_MARKDOWN.replace(
      "### 8. Risks",
      "### 8. Risks\n- first occurrence wins\n\n### 8. Risks",
    );
    const r = parseReport(dup);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.risks).toEqual(["first occurrence wins"]);
  });
});

describe("parseReport: malformed metadata", () => {
  it("rejects a non-boolean requiresHumanApproval", () => {
    const md = FULL_MARKDOWN.replace(
      "requiresHumanApproval: true",
      "requiresHumanApproval: maybe",
    );
    const r = parseReport(md);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("invalid_metadata");
  });
});

// agent-tasks/eaac8fe5: fast_confirm-mode reports come from a 5-bullet
// prompt with no `# Understanding Report` heading. The parser maps the
// bullet prefixes to the canonical sections and validates against the
// fast_confirm-relaxed schema (derivedTodos + acceptanceCriteria not
// required). Without this work, fast_confirm reports were silently
// un-harvestable end-to-end (only grill_me produced saved files).

const FAST_CONFIRM_BULLETS = `- I understood the task as: add producer hints to deny envelopes
- I will do: wire ProducerSchema into PolicySchema and render in reason
- I will not touch: the schema validators outside the new producers field
- I will verify by: tsc + vitest + live smoke against full-manifest
- Assumptions: at-least-one-mcp is enforceable at parse time
`;

describe("parseReport: fast_confirm bullet parsing", () => {
  it("maps the 5 bullet prefixes to canonical sections", () => {
    const r = parseReport(FAST_CONFIRM_BULLETS, {
      taskId: "fc-test-1",
      mode: "fast_confirm",
      riskLevel: "low",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.currentUnderstanding).toBe(
      "add producer hints to deny envelopes",
    );
    expect(r.report.intendedOutcome).toBe(
      "wire ProducerSchema into PolicySchema and render in reason",
    );
    expect(r.report.outOfScope).toEqual([
      "the schema validators outside the new producers field",
    ]);
    expect(r.report.verificationPlan).toEqual([
      "tsc + vitest + live smoke against full-manifest",
    ]);
    expect(r.report.assumptions).toEqual([
      "at-least-one-mcp is enforceable at parse time",
    ]);
    expect(r.report.mode).toBe("fast_confirm");
    expect(r.report.requiresHumanApproval).toBe(true);
    expect(r.report.approvalStatus).toBe("pending");
  });

  it("fast_confirm-relaxed schema omits derivedTodos + acceptanceCriteria from required", () => {
    const r = parseReport(FAST_CONFIRM_BULLETS, {
      taskId: "fc-test-2",
      mode: "fast_confirm",
      riskLevel: "low",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Both fields absent on the parsed report (the prompt does not
    // emit them; the relaxed schema accepts absence). Compare via
    // `in` so we distinguish "present and undefined" from "absent".
    expect("derivedTodos" in r.report).toBe(false);
    expect("acceptanceCriteria" in r.report).toBe(false);
  });

  it("strict-mode parse of the same fast_confirm bullets fails (back-compat guard)", () => {
    // Without `mode: fast_confirm` in defaults, the parser runs the
    // strict schema. The 5 bullets do not satisfy the strict required
    // set (no 9 sections, no derivedTodos / acceptanceCriteria), so
    // the parse must fail. This pins backwards compatibility: existing
    // callers that do not opt in to fast_confirm see no behaviour change.
    const r = parseReport(FAST_CONFIRM_BULLETS, {
      taskId: "fc-test-3",
      mode: "grill_me",
      riskLevel: "low",
    });
    expect(r.ok).toBe(false);
  });

  it("ignores a fast_confirm fallback when canonical sections are present", () => {
    // If the agent emits a full 9-section report under fast_confirm mode,
    // the section walk wins; bullet preprocessing only kicks in when the
    // section split returned zero matches. Verify by parsing FULL_MARKDOWN
    // with mode: fast_confirm should succeed and preserve all 9 sections.
    const r = parseReport(FULL_MARKDOWN, {
      taskId: "fc-test-4",
      mode: "fast_confirm",
      riskLevel: "low",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.derivedTodos).toEqual([
      "write the parser",
      "add ajv validation",
      "ship under @lannguyensi/understanding-gate",
    ]);
    expect(r.report.acceptanceCriteria).toEqual([
      "round-trip succeeds",
      "missing sections detected",
      "schema violations surfaced",
    ]);
  });

  it("partial bullet match still fails with missing_sections", () => {
    // If only some bullets are present, the parse must still fail so
    // the breadcrumb-write path in handle-stop.ts can log it. Drop the
    // two paragraph bullets that map to required-in-fast_confirm fields
    // (currentUnderstanding + intendedOutcome).
    const partial = FAST_CONFIRM_BULLETS.split("\n")
      .filter(
        (l) => !l.startsWith("- I understood") && !l.startsWith("- I will do"),
      )
      .join("\n");
    const r = parseReport(partial, {
      taskId: "fc-test-5",
      mode: "fast_confirm",
      riskLevel: "low",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.missing).toContain("currentUnderstanding");
    expect(r.error.missing).toContain("intendedOutcome");
  });
});
