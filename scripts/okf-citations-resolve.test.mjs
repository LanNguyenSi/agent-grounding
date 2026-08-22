/**
 * Fixture-based tests for the pure `run(root)` scanner in
 * okf-citations-resolve.mjs. Uses Node's built-in test runner (`node
 * --test`), matching the convention of the sibling root-level checkers
 * (check-pins.test.js, check-deps.test.js, check-lockfile-integrity.test.js)
 * rather than adding vitest as a new root devDependency for one script.
 *
 * Fixture root: scripts/okf-citations-resolve-fixtures/, a small, disposable
 * docs/okf bundle (never touches the repo's real docs/okf) with one good
 * citation and several deliberately drifted ones covering each warn rule.
 * scripts/okf-citations-resolve-fixtures/continuations/ is a second,
 * self-contained fixture root (its own docs/okf + src/) covering the three
 * continuation-citation forms, kept separate from the main fixture so its
 * doc-count and finding-count don't couple to the tests above.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { run, parseArgs } from "./okf-citations-resolve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(here, "okf-citations-resolve-fixtures");
const CONT_FIXTURE_ROOT = join(FIXTURE_ROOT, "continuations");

function findingFor(findings, citation) {
  return findings.find((f) => f.citation === citation);
}

test("scans the fixture doc and returns all five expected findings, no false positives", () => {
  const { docFiles, findings, unresolved } = run(FIXTURE_ROOT);

  assert.deepEqual(docFiles, ["docs/okf/sample.md"]);
  assert.equal(unresolved.length, 0);
  assert.equal(findings.length, 5);
});

test("good citation on real, non-blank content produces no finding", () => {
  const { findings } = run(FIXTURE_ROOT);
  assert.equal(findingFor(findings, "src/target.ts:1"), undefined);
});

test("drifted citation landing on a blank line is flagged blank-start-line", () => {
  const { findings } = run(FIXTURE_ROOT);
  const f = findingFor(findings, "src/target.ts:4");
  assert.ok(f, "expected a finding for src/target.ts:4");
  assert.equal(f.rule, "blank-start-line");
  assert.equal(f.resolvedTo, "src/target.ts");
});

test("citation landing on a lone closing brace is flagged closing-brace-start-line", () => {
  const { findings } = run(FIXTURE_ROOT);
  const f = findingFor(findings, "src/target.ts:3");
  assert.ok(f, "expected a finding for src/target.ts:3");
  assert.equal(f.rule, "closing-brace-start-line");
});

test("citation past end of file is flagged range-exceeds-file", () => {
  const { findings } = run(FIXTURE_ROOT);
  const f = findingFor(findings, "src/target.ts:50");
  assert.ok(f, "expected a finding for src/target.ts:50");
  assert.equal(f.rule, "range-exceeds-file");
});

test("citation into a nonexistent file is flagged missing-file", () => {
  const { findings } = run(FIXTURE_ROOT);
  const f = findingFor(findings, "does-not-exist.ts:1");
  assert.ok(f, "expected a finding for does-not-exist.ts:1");
  assert.equal(f.rule, "missing-file");
  assert.equal(f.resolvedTo, undefined);
});

test("markdown target only gets the blank-start-line check, not closing-brace", () => {
  const { findings } = run(FIXTURE_ROOT);
  const f = findingFor(findings, "src/note.md:1");
  assert.ok(f, "expected a finding for src/note.md:1");
  assert.equal(f.rule, "blank-start-line");
});

test("negative control: a citation manually corrected to the real post-drift line resolves clean", () => {
  // `src/target.ts:4` (blank) is the drifted citation in the main fixture;
  // the content that actually moved there sits at line 5 (`export function
  // bar() {`). Building a disposable fixture that cites line 5 instead must
  // produce no finding for that citation, confirming the checker reacts to
  // the cited line's real content rather than to some fixed offset from the
  // drifted fixture.
  const tmpRoot = mkdtempSync(join(tmpdir(), "okf-citations-resolve-negctl-"));
  try {
    mkdirSync(join(tmpRoot, "docs/okf"), { recursive: true });
    mkdirSync(join(tmpRoot, "src"), { recursive: true });
    writeFileSync(
      join(tmpRoot, "src/target.ts"),
      [
        "export function foo() {",
        "  return 1;",
        "}",
        "",
        "export function bar() {",
        "  return 2;",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(tmpRoot, "docs/okf/sample.md"),
      [
        "---",
        "sources:",
        "  - src/target.ts",
        "---",
        "",
        "Corrected citation: `src/target.ts:5`.",
        "",
      ].join("\n"),
    );

    const { findings } = run(tmpRoot);
    assert.equal(findingFor(findings, "src/target.ts:5"), undefined);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// -- Continuation citations (`:N`, -`M`/–`M`, (`N`)) -----------------------

test("continuations: fresh single-line continuation on real content produces no finding", () => {
  const { findings } = run(CONT_FIXTURE_ROOT);
  assert.equal(findingFor(findings, "src/target.ts:2 (continuation)"), undefined);
});

test("continuations: fresh single-line continuation landing on a blank line is flagged", () => {
  const { findings } = run(CONT_FIXTURE_ROOT);
  const f = findingFor(findings, "src/target.ts:4 (continuation)");
  assert.ok(f, "expected a finding for src/target.ts:4 (continuation)");
  assert.equal(f.rule, "blank-start-line");
  assert.equal(f.resolvedTo, "src/target.ts");
});

test("continuations: dash-form range end landing on a closing brace is NOT flagged (legitimate range end)", () => {
  const { findings } = run(CONT_FIXTURE_ROOT);
  assert.equal(findingFor(findings, "src/target.ts:1-3 (continuation)"), undefined);
});

test("continuations: colon-form range end landing on a closing brace is NOT flagged (legitimate range end)", () => {
  const { findings } = run(CONT_FIXTURE_ROOT);
  assert.equal(findingFor(findings, "src/target.ts:5-7 (continuation)"), undefined);
});

test("continuations: dash-form range end past the end of file is flagged range-exceeds-file", () => {
  const { findings } = run(CONT_FIXTURE_ROOT);
  const f = findingFor(findings, "src/target.ts:1-50 (continuation)");
  assert.ok(f, "expected a finding for src/target.ts:1-50 (continuation)");
  assert.equal(f.rule, "range-exceeds-file");
});

test("continuations: paren-form fresh continuation on a closing brace IS flagged (not an extension)", () => {
  const { findings } = run(CONT_FIXTURE_ROOT);
  const f = findingFor(findings, "src/target.ts:3 (continuation)");
  assert.ok(f, "expected a finding for src/target.ts:3 (continuation)");
  assert.equal(f.rule, "closing-brace-start-line");
});

test("continuations: a citedPath with a '..' segment is rejected without being resolved", () => {
  const { findings } = run(CONT_FIXTURE_ROOT);
  const f = findingFor(findings, "../evil.ts:1");
  assert.ok(f, "expected a finding for ../evil.ts:1");
  assert.equal(f.rule, "path-traversal-rejected");
  assert.equal(f.resolvedTo, undefined);
});

test("continuations: a continuation right after a rejected citation is silently skipped, not misattributed", () => {
  const { findings } = run(CONT_FIXTURE_ROOT);
  // The doc's trailing `:4` immediately follows the rejected `../evil.ts:1`
  // citation, which resets `governing` to null. Deliberately the blank line
  // in src/target.ts, not a real-content line: if the reset didn't happen,
  // `:4` would wrongly inherit the still-set src/target.ts governing from
  // the earlier `src/target.ts:1` (`3`) citation and produce a SECOND
  // "blank-start-line" finding for "src/target.ts:4 (continuation)" -- a
  // real-content line here would let a missing reset pass silently, same
  // as the bug this test is meant to catch. An earlier, unrelated fixture
  // paragraph (the blank-line continuation right after `src/target.ts:1`)
  // legitimately produces one finding with this exact citation string, so
  // the count must stay at exactly one, not grow to two.
  const matches = findings.filter((f) => f.citation === "src/target.ts:4 (continuation)");
  assert.equal(matches.length, 1);
  assert.equal(findings.length, 7);
});

test("continuations: a full citation with an inverted embedded range (end before start) is flagged inverted-range", () => {
  const { findings } = run(CONT_FIXTURE_ROOT);
  const f = findingFor(findings, "src/target.ts:5-3");
  assert.ok(f, "expected a finding for src/target.ts:5-3");
  assert.equal(f.rule, "inverted-range");
});

test("continuations: a cont-ext atom extending a range to before its start is flagged inverted-range, not silently accepted", () => {
  const { findings } = run(CONT_FIXTURE_ROOT);
  // Before the range-bound-only fix, cont-ext re-ran the full checkTarget
  // against the (real-content) start line and never checked the range's
  // own shape at all, so an inverted split range like this one silently
  // passed with no finding.
  const f = findingFor(findings, "src/target.ts:5-3 (continuation)");
  assert.ok(f, "expected a finding for src/target.ts:5-3 (continuation)");
  assert.equal(f.rule, "inverted-range");
});

test("continuations: a cont-ext atom extending a blank-start range does not re-flag the already-reported start line", () => {
  const { findings } = run(CONT_FIXTURE_ROOT);
  // `src/target.ts:4`-`6`: the full citation "4" alone already reports
  // blank-start-line. Before the range-bound-only fix, the cont-ext "6"
  // extension re-ran the full start-line check against the same blank
  // line 4 and reported it a second time as "src/target.ts:4-6
  // (continuation)".
  assert.equal(findingFor(findings, "src/target.ts:4-6 (continuation)"), undefined);
  const startFindings = findings.filter((f) => f.citation === "src/target.ts:4");
  assert.equal(startFindings.length, 1);
  assert.equal(startFindings[0].rule, "blank-start-line");
});

test("continuations fixture: exactly the seven expected findings, no extras", () => {
  const { docFiles, findings, unresolved } = run(CONT_FIXTURE_ROOT);
  assert.deepEqual(docFiles, ["docs/okf/continuations.md"]);
  assert.equal(unresolved.length, 0);
  assert.equal(findings.length, 7);
});

// -- EXCLUDED_DIRS: this script's own fixtures never pollute basename search -

test("EXCLUDED_DIRS: a decoy file inside a directory named like the fixtures dir is never picked up by the repo-wide basename search", () => {
  // Without excluding a directory named `okf-citations-resolve-fixtures`,
  // the bare-basename citation below would resolve ambiguously (two
  // `shared.ts` files under tmpRoot): the real target under src/, and a
  // decoy under a directory that happens to share this script's own
  // fixtures directory name. With the exclusion, only the real target is
  // found, so resolution is clean (no finding, nothing unresolved).
  const tmpRoot = mkdtempSync(join(tmpdir(), "okf-citations-resolve-excldirs-"));
  try {
    mkdirSync(join(tmpRoot, "docs/okf"), { recursive: true });
    mkdirSync(join(tmpRoot, "src"), { recursive: true });
    mkdirSync(join(tmpRoot, "scripts/okf-citations-resolve-fixtures"), { recursive: true });
    writeFileSync(join(tmpRoot, "src/shared.ts"), "export const x = 1;\n");
    writeFileSync(
      join(tmpRoot, "scripts/okf-citations-resolve-fixtures/shared.ts"),
      "export const decoy = 1;\n",
    );
    writeFileSync(
      join(tmpRoot, "docs/okf/doc.md"),
      [
        "---",
        "type: reference",
        "title: Excluded-dir fixture",
        "---",
        "",
        "Bare-basename citation resolved via repo-wide search: `shared.ts:1`.",
        "",
      ].join("\n"),
    );

    const { findings, unresolved } = run(tmpRoot);
    assert.equal(findings.length, 0);
    assert.equal(unresolved.length, 0);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// -- parseArgs ---------------------------------------------------------------

test("parseArgs: --root without a following value throws", () => {
  assert.throws(() => parseArgs(["--root"]), /--root requires a value/);
});

test("parseArgs: --root with a value is accepted", () => {
  const opts = parseArgs(["--root", "/tmp/somewhere", "--json"]);
  assert.equal(opts.root, "/tmp/somewhere");
  assert.equal(opts.json, true);
  assert.equal(opts.failOnWarn, false);
});
