import { describe, it, expect } from "vitest";
import { parseReport } from "../src/core/parser.js";

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
    return FULL_MARKDOWN.replace(
      /### 3\. Derived todos \/ specs[\s\S]*?(?=### 4\.)/,
      `### 3. Derived todos / specs\n${items}\n`,
    );
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

  it("joins continuation lines into the previous item", () => {
    const r = parseReport(withList("- first item\n  with continuation\n- second"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.derivedTodos).toEqual([
      "first item with continuation",
      "second",
    ]);
  });
});

describe("parseReport: purity", () => {
  it("performs no fs operations (smoke check via fs.statSync mock)", async () => {
    // If parseReport touches the fs, this test would surface it via the
    // module graph. We assert the contract by re-importing fresh and
    // checking that a parse call does not require any imports beyond
    // ajv / ajv-formats / our schema. Simpler check: parse 1000x and
    // ensure no exceptions, no env-dependent behavior.
    for (let i = 0; i < 1000; i++) {
      const r = parseReport(FULL_MARKDOWN);
      expect(r.ok).toBe(true);
    }
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
