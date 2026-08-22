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
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { run } from "./okf-citations-resolve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(here, "okf-citations-resolve-fixtures");

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
