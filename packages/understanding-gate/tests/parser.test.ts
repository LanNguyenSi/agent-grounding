import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parseReport } from "../src/core/parser.js";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { UNDERSTANDING_REPORT_SCHEMA } from "../src/schema/report-schema.js";

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

### 10. Prior art
- searched: npm + GitHub for "Understanding Gate"
- found nothing equivalent
- build new, no existing tool matches the scope

## Metadata
taskId: ug-test-1
mode: grill_me
riskLevel: high
requiresHumanApproval: true
approvalStatus: pending
`;

describe("parseReport: full round-trip", () => {
  it("recovers all 10 required sections + metadata", () => {
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
    expect(r.report.priorArt).toEqual([
      "searched: npm + GitHub for \"Understanding Gate\"",
      "found nothing equivalent",
      "build new, no existing tool matches the scope",
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

  it("consumer regression: markdown taskid wins over defaults.taskId gap-fill (agent-tasks 2078873e)", () => {
    // harness's stdin-report.ts passes `taskId: sessionId` purely as a
    // gap-filler per the documented contract ("metadata overrides defaults
    // if present"). 0.4.7-0.4.8 (PR #143) broke this: a caller-supplied
    // defaults.taskId always won over the markdown's `taskid` key, so the
    // sessionId gap-filler stamped over the real task binding from the
    // report. This must be RED before the fix (parseReport currently
    // returns "sess-1", not "t-x").
    const md = FULL_MARKDOWN.replace("taskId: ug-test-1", "taskid: t-x");
    const r = parseReport(md, { taskId: "sess-1" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.taskId).toBe("t-x");
  });

  it("metadata block overrides defaults, including taskId gap-fill (agent-tasks 2078873e)", () => {
    // mode/riskLevel/taskId: the markdown's Metadata block wins over
    // caller-supplied defaults uniformly. defaults.taskId is gap-fill
    // only (FULL_MARKDOWN's Metadata block says "taskId: ug-test-1", so
    // the markdown wins and the caller-supplied default is never used).
    // Use `defaults.boundTaskId` instead to bind regardless of the
    // markdown (see the dedicated boundTaskId describe block below).
    const r = parseReport(FULL_MARKDOWN, {
      taskId: "from-caller",
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

// agent-tasks be98cd96: a live report had `## Verification Plan` and
// `## Prior Art` present as German prose (no bullets); the parser rejected
// it with reason=missing_sections listing both keys, indistinguishable
// from "the agent never wrote these sections at all". `## Open Questions`
// in the same report WAS bullet-formatted and was accepted -- confirming
// the parser's per-section list detection, not some global report defect,
// was the cause. Fixture reconstructed per the incident write-up: an H1
// with an em dash, German prose under Verification Plan / Prior Art, and
// Prior Art as the last section before Metadata.
const KIND_MISMATCH_INCIDENT_MARKDOWN = `# Understanding Report — Live-Vorfall 2026-07-22

### 1. My current understanding
Der Nutzer möchte einen Parser für Understanding Reports.

### 2. Intended outcome
\`parseReport\` gibt ein typisiertes, schema-validiertes Objekt zurück.

### 3. Derived todos / specs
- Parser bauen
- ajv-Validierung ergänzen

### 4. Acceptance criteria
- Round-Trip funktioniert
- Fehlende Sektionen werden erkannt

### 5. Assumptions
- ajv ist als Runtime-Dependency verfügbar

### 6. Open questions
- woher kommt die taskId?

### 7. Out of scope
- LLM-gestützte Wiederherstellung

### 8. Risks
- falsche Negative bei Heading-Varianten

### 9. Verification plan
Wir haben die Änderung manuell im Terminal getestet und die Ausgabe
geprüft, aber nicht als Liste dokumentiert.

### 10. Prior art
Es gibt kein vergleichbares Werkzeug am Markt, wir haben das selbst gebaut
und dabei keine Bulletpoints benutzt.

## Metadata
taskId: incident-1
mode: grill_me
riskLevel: medium
`;

describe("parseReport: kind-mismatch diagnosis (agent-tasks be98cd96)", () => {
  it("RED-test baseline: reproduces the incident shape -- reason=missing_sections with exactly verificationPlan + priorArt", () => {
    // This assertion documents today's (pre-fix) observable behaviour
    // verbatim, per the task contract's red-test-first requirement. It
    // must stay true after the fix too: `missing` still names exactly
    // these two keys (schema/required-ness are unchanged by this task);
    // only the diagnosis alongside it gets more precise (see the next
    // test below).
    const r = parseReport(KIND_MISMATCH_INCIDENT_MARKDOWN);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("missing_sections");
    expect(r.error.missing).toEqual(["verificationPlan", "priorArt"]);
  });

  it("distinguishes 'present but not a bullet list' from 'absent' via malformedSections + a precise message", () => {
    const r = parseReport(KIND_MISMATCH_INCIDENT_MARKDOWN);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.malformedSections).toEqual([
      "verificationPlan",
      "priorArt",
    ]);
    // The message must name each malformed key and explain the fix well
    // enough that a schema-conformant report can be derived from it alone.
    expect(r.error.message).toContain("verificationPlan");
    expect(r.error.message).toContain("priorArt");
    expect(r.error.message.toLowerCase()).toContain("markdown list");
    // The hint covers both list forms LIST_ITEM_RE accepts, not just '- '.
    expect(r.error.message).toContain("'- '");
    expect(r.error.message).toContain("'1.'");
  });

  it("does not add a key to malformedSections when its heading is absent entirely", () => {
    const md = KIND_MISMATCH_INCIDENT_MARKDOWN.replace(
      /### 8\. Risks[\s\S]*?(?=### 9\.)/,
      "",
    );
    const r = parseReport(md);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.missing).toContain("risks");
    expect(r.error.malformedSections).not.toContain("risks");
  });

  it("does not add a key to malformedSections when its body is genuinely empty (companion to the pinned empty-body test)", () => {
    const md = KIND_MISMATCH_INCIDENT_MARKDOWN.replace(
      /### 8\. Risks[\s\S]*?(?=### 9\.)/,
      "### 8. Risks\n\n",
    );
    const r = parseReport(md);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.missing).toContain("risks");
    expect(r.error.malformedSections).not.toContain("risks");
  });

  it("does not add a key to malformedSections when its body is whitespace-only (spaces/tabs, not zero-length)", () => {
    // Distinct from the zero-length-body case above: this body has actual
    // characters, all of them whitespace. buildMissingSectionsMessage's
    // malformed/plain split relies on body.trim() collapsing this to "",
    // same as a truly empty body -- pin that the trim, not a length-0
    // check, is what drives the distinction.
    const md = KIND_MISMATCH_INCIDENT_MARKDOWN.replace(
      /### 8\. Risks[\s\S]*?(?=### 9\.)/,
      "### 8. Risks\n   \t  \n\t\n",
    );
    const r = parseReport(md);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.missing).toContain("risks");
    expect(r.error.malformedSections).not.toContain("risks");
  });

  it("pins buildMissingSectionsMessage's per-key rendering: a genuinely-missing key stays plain, a malformed key gets annotated, in the same message", () => {
    // risks: heading removed entirely (truly missing). verificationPlan +
    // priorArt: heading present, prose body (malformed) -- inherited from
    // KIND_MISMATCH_INCIDENT_MARKDOWN. All three end up in `missing`, but
    // only the malformed two should carry the annotation.
    const md = KIND_MISMATCH_INCIDENT_MARKDOWN.replace(
      /### 8\. Risks[\s\S]*?(?=### 9\.)/,
      "",
    );
    const r = parseReport(md);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.missing).toEqual(["risks", "verificationPlan", "priorArt"]);
    expect(r.error.malformedSections).toEqual([
      "verificationPlan",
      "priorArt",
    ]);
    // The truly-missing key renders plain, immediately followed by the
    // list separator, never annotated.
    expect(r.error.message).toMatch(/\brisks,/);
    expect(r.error.message).not.toMatch(/risks \(present/);
    // Both malformed keys carry the per-key annotation.
    expect(r.error.message).toMatch(
      /verificationPlan \(present but not a markdown list/,
    );
    expect(r.error.message).toMatch(
      /priorArt \(present but not a markdown list/,
    );
  });

  it("bold-label section header (discovery C1, commit 42637c8) with a prose body still lands in missing AND malformedSections", () => {
    // Alias-promotion (bold **Label:** lines promoted to section headers)
    // and the kind-mismatch diagnosis are independent mechanisms; this
    // pins that they compose correctly -- a bold-label-headed section with
    // a prose body is diagnosed the same as a `###`-headed one.
    const md = FULL_MARKDOWN.replace(
      /### 9\. Verification plan[\s\S]*?(?=### 10\.)/,
      "**Verification Plan:**\nDies ist Fließtext ohne Bullet-Punkte, in Bold-Label-Form geschrieben.\n",
    );
    const r = parseReport(md);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.missing).toContain("verificationPlan");
    expect(r.error.malformedSections).toContain("verificationPlan");
    expect(r.error.message).toMatch(
      /verificationPlan \(present but not a markdown list/,
    );
  });

  // All 8 kind:"list" sections, each paired with the regex used elsewhere
  // in this file to isolate that section's heading-through-next-heading
  // span in FULL_MARKDOWN, so the case list stays generic instead of
  // special-casing the two sections the live incident happened to hit.
  const LIST_SECTION_CASES: Array<{
    key: string;
    heading: string;
    regex: RegExp;
  }> = [
    {
      key: "derivedTodos",
      heading: "### 3. Derived todos / specs",
      regex: /### 3\. Derived todos \/ specs[\s\S]*?(?=### 4\.)/,
    },
    {
      key: "acceptanceCriteria",
      heading: "### 4. Acceptance criteria",
      regex: /### 4\. Acceptance criteria[\s\S]*?(?=### 5\.)/,
    },
    {
      key: "assumptions",
      heading: "### 5. Assumptions",
      regex: /### 5\. Assumptions[\s\S]*?(?=### 6\.)/,
    },
    {
      key: "openQuestions",
      heading: "### 6. Open questions",
      regex: /### 6\. Open questions[\s\S]*?(?=### 7\.)/,
    },
    {
      key: "outOfScope",
      heading: "### 7. Out of scope",
      regex: /### 7\. Out of scope[\s\S]*?(?=### 8\.)/,
    },
    {
      key: "risks",
      heading: "### 8. Risks",
      regex: /### 8\. Risks[\s\S]*?(?=### 9\.)/,
    },
    {
      key: "verificationPlan",
      heading: "### 9. Verification plan",
      regex: /### 9\. Verification plan[\s\S]*?(?=### 10\.)/,
    },
    {
      key: "priorArt",
      heading: "### 10. Prior art",
      regex: /### 10\. Prior art[\s\S]*?(?=## Metadata)/,
    },
  ];

  it.each(LIST_SECTION_CASES)(
    "flags $key as malformed, not silently 'missing', when its heading is present with a non-blank prose body",
    ({ key, heading, regex }) => {
      const proseBody = `${heading}\nDies ist Fließtext ohne Bullet-Punkte, der die Sektion ausfüllt.\n`;
      const md = FULL_MARKDOWN.replace(regex, proseBody);
      const r = parseReport(md);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.reason).toBe("missing_sections");
      expect(r.error.missing).toContain(key);
      expect(r.error.malformedSections).toContain(key);
      expect(r.error.message).toContain(key);
      expect(r.error.message.toLowerCase()).toContain("markdown list");
    },
  );

  it("correctly formatted bullet reports are unaffected (malformedSections stays out of the picture on success)", () => {
    // FULL_MARKDOWN's list sections are all proper bullet lists; the
    // ok:true round-trip test elsewhere already covers full acceptance.
    // This just pins that a successful parse carries no `error` at all.
    const r = parseReport(FULL_MARKDOWN);
    expect(r.ok).toBe(true);
  });
});

describe("parseReport: priorArt section (v0.4.0)", () => {
  it("rejects a report missing the Prior Art section", () => {
    const md = FULL_MARKDOWN.replace(
      /### 10\. Prior art[\s\S]*?(?=## Metadata)/,
      "",
    );
    const r = parseReport(md);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reason).toBe("missing_sections");
    expect(r.error.missing).toContain("priorArt");
  });

  it("rejects a report with an empty Prior Art section", () => {
    const md = FULL_MARKDOWN.replace(
      /### 10\. Prior art[\s\S]*?(?=## Metadata)/,
      "### 10. Prior art\n\n",
    );
    const r = parseReport(md);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.missing).toContain("priorArt");
  });

  it("accepts a literal `- None` Prior Art bullet (parser is structural, prompt is the deterrent)", () => {
    // Pin the intentional parser/prompt asymmetry: the prompt template
    // tells the agent NOT to write `- None`, but the parser does not
    // string-match the value. A literal "- None" passes the structural
    // check (one non-empty bullet) and validates. If a future change
    // adds parser-side `- None` rejection, this test will fail and
    // force a deliberate choice rather than a silent contract shift.
    const md = FULL_MARKDOWN.replace(
      /### 10\. Prior art[\s\S]*?(?=## Metadata)/,
      "### 10. Prior art\n- None\n\n",
    );
    const r = parseReport(md);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.priorArt).toEqual(["None"]);
  });

  it("accepts a fast_confirm report that omits Prior Art (relaxed schema)", () => {
    const fastConfirmBullets = [
      "- I understood the task as: add a logout button",
      "- I will do: wire it into the Header component",
      "- I will not touch: the auth state",
      "- I will verify by: clicking it once and watching the network tab",
      "- Assumptions: the existing /api/logout endpoint works",
    ].join("\n");
    const r = parseReport(fastConfirmBullets, {
      taskId: "t",
      mode: "fast_confirm",
      riskLevel: "low",
    });
    expect(r.ok).toBe(true);
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

// Discovery finding C1: an agent ended a turn with a complete report whose
// sections were bold labels (`**Derived Todos:**`) rather than `##` headings.
// The parser must accept those as section headers so the report is saved
// instead of dropped as "missing sections".
const BOLD_LABEL_MARKDOWN = `# Understanding Report

**My current understanding:**
The user wants a parser for the Understanding Report.
It should reject malformed input.

**Intended outcome:**
The parser returns a typed object validated against the schema.

**Derived todos:**
- write the parser
- add ajv validation
- ship under @lannguyensi/understanding-gate

**Acceptance criteria:**
- round-trip succeeds
- missing sections detected
- schema violations surfaced

**Assumptions:**
- ajv is available as a runtime dep
- agent emits sections in order

**Open questions:**
- where does taskId come from?

**Out of scope:**
- LLM-assisted recovery

**Risks:**
- false negatives on heading variants

**Verification plan:**
- unit tests

**Prior art:**
- searched npm and GitHub, found nothing equivalent, building new
`;

describe("parseReport: bold-label section headers (discovery C1)", () => {
  it("accepts a full report whose sections are bold labels", () => {
    const r = parseReport(BOLD_LABEL_MARKDOWN, {
      taskId: "bold-1",
      mode: "grill_me",
      riskLevel: "high",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.currentUnderstanding).toContain("wants a parser");
    expect(r.report.derivedTodos).toEqual([
      "write the parser",
      "add ajv validation",
      "ship under @lannguyensi/understanding-gate",
    ]);
    expect(r.report.risks).toEqual(["false negatives on heading variants"]);
  });

  it("accepts a report mixing ## headings and bold-label sections", () => {
    const mixed = FULL_MARKDOWN.replace(
      "### 2. Intended outcome",
      "**Intended outcome:**",
    ).replace("### 8. Risks", "**Risks:**");
    const r = parseReport(mixed);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.intendedOutcome).toContain("typed object");
    expect(r.report.risks).toEqual(["false negatives on heading variants"]);
  });

  it("does NOT promote an inline bold line with trailing content (no body split)", () => {
    const md = FULL_MARKDOWN.replace(
      "It should reject malformed input.",
      "It should reject malformed input.\n**Note:** this is inline emphasis, not a section.",
    );
    const r = parseReport(md);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The inline bold stays in the section body, not promoted to a section.
    expect(r.report.currentUnderstanding).toContain("inline emphasis");
  });

  it("does NOT promote a KNOWN alias appearing inline with trailing content", () => {
    // `**Risks:** ...trailing prose` is inline emphasis, not a header: the
    // trailing content fails the BOLD_LABEL_RE `\\s*$` guard. The inline label
    // sits BEFORE the real `### 8. Risks`, so if it were wrongly promoted,
    // pickSection (first-match-wins) would return the wrong Risks body.
    const md = FULL_MARKDOWN.replace(
      "It should reject malformed input.",
      "It should reject malformed input.\n**Risks:** this is inline emphasis, not a section.",
    );
    const r = parseReport(md);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The real Risks section is unchanged...
    expect(r.report.risks).toEqual(["false negatives on heading variants"]);
    // ...and the inline bold stayed in the current-understanding body.
    expect(r.report.currentUnderstanding).toContain("inline emphasis");
  });

  it("does NOT promote a bold label whose title is not a known section alias", () => {
    const md = FULL_MARKDOWN.replace(
      "It should reject malformed input.",
      "It should reject malformed input.\n**Random Heading:**\nstill part of the same section.",
    );
    const r = parseReport(md);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.currentUnderstanding).toContain("Random Heading");
  });

  it("does NOT promote a bold label inside a fenced code block", () => {
    // A fake `**Derived todos:**` inside a fence must not shadow the real
    // section (pickSection is first-match-wins, so a leaked fake would win).
    const md = FULL_MARKDOWN.replace(
      "It should reject malformed input.",
      "It should reject malformed input.\n\n```\n**Derived todos:**\n- fake todo from inside a fence\n```",
    );
    const r = parseReport(md);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.derivedTodos).toEqual([
      "write the parser",
      "add ajv validation",
      "ship under @lannguyensi/understanding-gate",
    ]);
  });
});


describe("parseReport: sessionId is not agent-settable (task 0a3227fe)", () => {
  it("ignores a `sessionId` key in the Metadata block", () => {
    // Session binding is written by the adapters from the runtime's own
    // session id. If markdown could set it, an agent could aim its
    // report at another session's pending approval.
    // A well-formed Metadata block (taskId/mode/riskLevel are mandatory)
    // that additionally tries to set the session binding, in both the
    // camelCase and the lowercased form the metadata reader normalises to.
    const withForgedSession = FULL_MARKDOWN.replace(
      "# Understanding Report",
      [
        "# Understanding Report",
        "",
        "## Metadata",
        "",
        "taskId: t-1",
        "mode: grill_me",
        "riskLevel: low",
        "sessionId: attacker-session",
        "sessionid: attacker-session",
      ].join("\n"),
    );
    const result = parseReport(withForgedSession, { taskId: "t-1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.sessionId).toBeUndefined();
  });

  it("accepts a report object that already carries a sessionId (ajv, additionalProperties:false)", () => {
    const result = parseReport(FULL_MARKDOWN, { taskId: "t-1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The adapters stamp the binding AFTER parsing, so the enriched
    // object must still satisfy the schema. Validate for real: the
    // schema sets additionalProperties:false, so this fails the moment
    // `sessionId` is not a declared property. Asserting only
    // `enriched.sessionId === "sess-1"` would be inert (it checks a
    // plain JS spread, not the schema).
    const ajv = new Ajv({ strict: true, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(UNDERSTANDING_REPORT_SCHEMA);

    expect(validate({ ...result.report, sessionId: "sess-1" })).toBe(true);

    // And the constraints on the field actually bite.
    expect(validate({ ...result.report, sessionId: "" })).toBe(false);
    expect(validate({ ...result.report, sessionId: 42 })).toBe(false);
    // A genuinely unknown property is still rejected, i.e. we widened
    // the schema by exactly one field and no more.
    expect(validate({ ...result.report, notAField: "x" })).toBe(false);
  });
});

describe("parseReport: taskId is not agent-settable when a caller boundTaskId is present (agent-grounding e2e065e6, agent-tasks 2078873e)", () => {
  // Block-direction integrity finding from the adversarial review of the
  // C1 self-approval fix (agent-tasks 3a994d92). An agent's Understanding
  // Report is always forced to approvalStatus: pending, so it can never
  // self-approve (security-self-approval.test.ts). But without this
  // binding, an agent could still forge `taskid: <other task>` in its
  // Metadata block and have parseReport honour it over the caller-supplied
  // (adapter/env-derived) binding, letting a forced-pending report be
  // filed under ANOTHER task's id. Since findLatestForTask picks the most
  // recently created/approved entry per taskId, a newer forged pending
  // entry would then outrank that other task's already-approved entry,
  // downgrading it back to pending. See security-taskid-binding.test.ts
  // for the end-to-end persistence + findLatestForTask regression.
  //
  // 0.4.7-0.4.8 (PR #143) implemented this security property by making
  // ANY caller-supplied defaults.taskId win, which broke the documented
  // gap-fill contract for legitimate callers (see the "consumer
  // regression" test above). agent-tasks 2078873e moved the winning
  // behaviour to the dedicated defaults.boundTaskId field instead;
  // defaults.taskId reverted to gap-fill.
  it("prefers boundTaskId over `taskid` in the Metadata block", () => {
    const forgedTaskId = FULL_MARKDOWN.replace(
      "taskId: ug-test-1",
      "taskId: victim-task",
    );
    const result = parseReport(forgedTaskId, {
      boundTaskId: "attacker-own-task",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.taskId).toBe("attacker-own-task");
    expect(result.report.taskId).not.toBe("victim-task");
  });

  it("prefers boundTaskId even when defaults.taskId is also supplied", () => {
    // A caller that (incorrectly) supplies both must still get the bound
    // value, not the gap-fill one -- boundTaskId is unconditional.
    const forgedTaskId = FULL_MARKDOWN.replace(
      "taskId: ug-test-1",
      "taskId: victim-task",
    );
    const result = parseReport(forgedTaskId, {
      taskId: "gap-fill-value",
      boundTaskId: "attacker-own-task",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.taskId).toBe("attacker-own-task");
  });

  it("does not leak boundTaskId itself onto the persisted report", () => {
    // boundTaskId is a parser-input-only field; the schema declares
    // additionalProperties:false, so parseReport must strip it before
    // returning, not just overwrite taskId.
    const result = parseReport(FULL_MARKDOWN, { boundTaskId: "b-1" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect("boundTaskId" in result.report).toBe(false);
  });

  it("still reads `taskid` from the Metadata block when the caller supplies no boundTaskId at all", () => {
    // This is the pre-existing, still-legitimate use: this package's own
    // parser tests call parseReport(markdown) directly with no adapter in
    // front of it. Real adapters (handle-stop.ts / persist-report.ts)
    // always pass a defaults.boundTaskId, so this fallback path is never
    // live in production.
    const r = parseReport(FULL_MARKDOWN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.report.taskId).toBe("ug-test-1");
  });
});
