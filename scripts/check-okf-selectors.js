#!/usr/bin/env node
/**
 * OKF citation-guard selector-coupling check.
 *
 * `.github/workflows/ci.yml`'s `okf-anchor-guard` job (step "Citation
 * guard") runs `okf-kit check --require-anchors --json` and then picks
 * blocking findings out of the resulting JSON with four named `jq`
 * filters -- `logFindings`, `citationFindings`, `ambiguousFindings`,
 * `otherNotices` -- plus a bare `errors=$(jq -e '.summary.errors |
 * numbers' ...)` selector, all keyed on `okf-kit`'s JSON shape
 * (`.findings[].ruleId`, `.severity`, `.file`, `.message` containing a
 * `[rule]`-tagged suffix). Nothing coupled those jq expressions to that
 * shape: if a future `okf-kit` release renames a field, a severity
 * string, or the `[rule]` suffix in `.message`, every selector above
 * would silently select 0 items from a genuinely broken bundle and the
 * guard job would go green -- the same silent-drift failure mode
 * `check-okf-kit-pin.js` closes for the version pin itself, just for the
 * jq selectors' assumed JSON shape instead of a version string.
 *
 * This script closes that gap the same way `check-okf-kit-pin.js` does:
 * it EXTRACTS the five jq filter expressions straight out of ci.yml's
 * Citation guard step (regex over the `name=$(jq '...' ...)` /
 * `name=$(jq -e '...' ...)` assignments -- not a YAML parser; see
 * `check-okf-test-citation-shape.js`'s docblock for why this repo avoids
 * the `js-yaml` dependency in a check that has to run before `npm ci`),
 * then runs the REAL `jq` binary (`child_process.spawnSync`, never a
 * reimplementation) with each extracted filter against two canonical
 * `okf-kit@0.8.0` JSON reports checked in under `scripts/fixtures/
 * okf-selectors/`:
 *
 *   - `clean-report.json`: a bundle with zero findings of any kind.
 *     Every selector must select nothing.
 *   - `drifted-report.json`: a bundle with exactly one finding per
 *     `citations-resolve` rule subtype `--require-anchors` can produce
 *     (the base rule plus all four anchor subtypes), one
 *     `unresolved-ambiguous` notice, one `citations-resolve` warning
 *     inside `log.md` (which the guard's own header comment says must
 *     stay non-blocking), and one non-citation notice (`sources-fresh`).
 *     Each blocking selector must select exactly the finding(s) it is
 *     supposed to and NONE of the log.md/other-notice findings; the
 *     job's own red/green verdict (`errors>0 || citationFindings.length>0
 *     || ambiguousFindings.length>0`) must come out true here.
 *
 * See `scripts/fixtures/okf-selectors/README.md` for exactly how both
 * reports were generated and how to regenerate them against a newer
 * `okf-kit` release.
 *
 * If any of the five selectors can no longer be extracted from ci.yml at
 * all (the step was rewritten, a variable renamed), this check fails
 * loud naming the missing selector rather than silently skipping it.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';
const FIXTURES_DIR = path.join('scripts', 'fixtures', 'okf-selectors');
const CLEAN_REPORT = 'clean-report.json';
const DRIFTED_REPORT = 'drifted-report.json';

// One regex per named `jq` assignment in ci.yml's "Citation guard" step.
// Captures the filter expression between the outer single quotes.
// `errors` alone uses `jq -e` (the other four never do), so it gets its
// own pattern with `-e` required in between.
const SELECTOR_PATTERNS = {
  logFindings: /logFindings=\$\(jq\s+'([\s\S]*?)'\s*okf-anchor-report\.json\)/,
  citationFindings: /citationFindings=\$\(jq\s+'([\s\S]*?)'\s*okf-anchor-report\.json\)/,
  ambiguousFindings: /ambiguousFindings=\$\(jq\s+'([\s\S]*?)'\s*okf-anchor-report\.json\)/,
  otherNotices: /otherNotices=\$\(jq\s+'([\s\S]*?)'\s*okf-anchor-report\.json\)/,
  errors: /errors=\$\(jq\s+-e\s+'([\s\S]*?)'\s*okf-anchor-report\.json\)/,
};

// Expected shape of each fixture, keyed by selector name. Array selectors
// list the `[rule-tag]` (or, for sources-fresh which carries no bracket
// tag, a distinctive message substring) each expected finding must
// contain; the array's LENGTH is also asserted (catches a selector that
// over-matches, not just one that under-matches). `errors` is a bare
// expected number.
const EXPECTED = {
  [CLEAN_REPORT]: {
    logFindings: [],
    citationFindings: [],
    ambiguousFindings: [],
    otherNotices: [],
    errors: 0,
  },
  [DRIFTED_REPORT]: {
    logFindings: ['[anchor-not-found-in-range]'],
    citationFindings: [
      '[missing-file]',
      '[anchor-required]',
      '[anchor-not-on-last-line]',
      '[anchor-not-unique-in-range]',
      '[test-range-straddles-block]',
    ],
    ambiguousFindings: ['[unresolved-ambiguous]'],
    otherNotices: ['untracked by git'],
    errors: 0,
  },
};

/** Reads `ciYamlPath` and returns `{ name: filterExpr }` for every
 * selector found, plus `missing`: an array of selector names whose
 * pattern did not match at all. Never throws on a missing file -- the
 * caller turns that into a named violation. */
function extractSelectors(content) {
  const found = {};
  const missing = [];
  for (const [name, re] of Object.entries(SELECTOR_PATTERNS)) {
    const m = content.match(re);
    if (m) {
      found[name] = m[1];
    } else {
      missing.push(name);
    }
  }
  return { found, missing };
}

/** Runs the real `jq` binary with `filterExpr` against `reportPath`.
 * Returns `{ ok: true, value }` (value is the parsed JSON stdout -- an
 * array for the four `[ ... ]` selectors, a number for `errors`) or
 * `{ ok: false, reason }` on any jq/parse failure. Throws only when `jq`
 * itself is not on PATH -- this check must fail loud, not silently skip,
 * exactly like the real Citation guard step it is coupled to. */
function runJqFilter(filterExpr, reportPath) {
  const result = spawnSync('jq', [filterExpr, reportPath], { encoding: 'utf8' });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      throw new Error(
        'okf-selectors check requires the real `jq` binary on PATH (same as ci.yml\'s ' +
          'Citation guard step) -- not found. Install jq and retry; this check never falls ' +
          'back to a reimplementation.',
      );
    }
    throw result.error;
  }
  if (result.status !== 0) {
    return { ok: false, reason: `jq exited ${result.status}: ${result.stderr.trim()}` };
  }
  const trimmed = result.stdout.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'jq produced no output' };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (err) {
    return { ok: false, reason: `jq output was not valid JSON: ${err.message}` };
  }
}

/** Pure core: given the extracted `selectors` map and a `reportPath` /
 * `expected` pair, returns a violations array. Empty means every
 * selector selected exactly the expected findings (by rule-tag /
 * message-substring identity, not just count) and no log.md or
 * other-notice finding leaked into a blocking selector. */
function checkFixture(selectors, reportPath, expected, reportLabel) {
  const violations = [];

  const results = {};
  for (const name of ['logFindings', 'citationFindings', 'ambiguousFindings', 'otherNotices']) {
    const run = runJqFilter(selectors[name], reportPath);
    if (!run.ok) {
      violations.push({
        reason: 'jq-failed',
        selector: name,
        report: reportLabel,
        detail: run.reason,
      });
      continue;
    }
    if (!Array.isArray(run.value)) {
      violations.push({
        reason: 'not-an-array',
        selector: name,
        report: reportLabel,
      });
      continue;
    }
    results[name] = run.value;

    const exp = expected[name];
    if (run.value.length !== exp.length) {
      violations.push({
        reason: 'count-mismatch',
        selector: name,
        report: reportLabel,
        expectedCount: exp.length,
        actualCount: run.value.length,
      });
    }
    for (const tag of exp) {
      const hit = run.value.some((f) => typeof f.message === 'string' && f.message.includes(tag));
      if (!hit) {
        violations.push({
          reason: 'tag-not-selected',
          selector: name,
          report: reportLabel,
          tag,
        });
      }
    }
  }

  // The two blocking selectors must never include a log.md finding --
  // that's the whole point of ci.yml excluding `file == "log.md"` from
  // both of them.
  for (const name of ['citationFindings', 'ambiguousFindings']) {
    const arr = results[name];
    if (!arr) continue;
    const leaked = arr.filter((f) => f.file === 'log.md');
    if (leaked.length > 0) {
      violations.push({
        reason: 'log-md-leaked-into-blocking-selector',
        selector: name,
        report: reportLabel,
        count: leaked.length,
      });
    }
  }

  const errRun = runJqFilter(selectors.errors, reportPath);
  if (!errRun.ok) {
    violations.push({
      reason: 'jq-failed',
      selector: 'errors',
      report: reportLabel,
      detail: errRun.reason,
    });
  } else if (typeof errRun.value !== 'number') {
    violations.push({ reason: 'not-a-number', selector: 'errors', report: reportLabel });
  } else if (errRun.value !== expected.errors) {
    violations.push({
      reason: 'count-mismatch',
      selector: 'errors',
      report: reportLabel,
      expectedCount: expected.errors,
      actualCount: errRun.value,
    });
  }

  // The job's own red/green verdict (ci.yml: `if [ "${errors}" -gt 0 ] ||
  // [ "${count}" -gt 0 ] || [ "${ambiguousCount}" -gt 0 ]`), replayed here
  // with the values this check itself observed, must match what the
  // fixture is supposed to represent.
  if (results.citationFindings && results.ambiguousFindings && errRun.ok) {
    const wouldBlock =
      errRun.value > 0 || results.citationFindings.length > 0 || results.ambiguousFindings.length > 0;
    const expectedBlock =
      expected.errors > 0 || expected.citationFindings.length > 0 || expected.ambiguousFindings.length > 0;
    if (wouldBlock !== expectedBlock) {
      violations.push({
        reason: 'verdict-mismatch',
        report: reportLabel,
        expectedBlock,
        actualBlock: wouldBlock,
      });
    }
  }

  return violations;
}

function formatViolation(v) {
  switch (v.reason) {
    case 'jq-failed':
      return `  - [${v.report}] selector "${v.selector}": ${v.detail}`;
    case 'not-an-array':
      return `  - [${v.report}] selector "${v.selector}" did not produce a JSON array.`;
    case 'not-a-number':
      return `  - [${v.report}] selector "errors" did not produce a JSON number.`;
    case 'count-mismatch':
      return (
        `  - [${v.report}] selector "${v.selector}" selected ${v.actualCount} finding(s), ` +
        `expected ${v.expectedCount}.`
      );
    case 'tag-not-selected':
      return (
        `  - [${v.report}] selector "${v.selector}" selected nothing matching "${v.tag}" ` +
        '(okf-kit may have renamed ruleId/severity/file, or ci.yml\'s selector drifted).'
      );
    case 'log-md-leaked-into-blocking-selector':
      return (
        `  - [${v.report}] selector "${v.selector}" selected ${v.count} log.md finding(s); ` +
        'log.md must stay excluded from every blocking selector.'
      );
    case 'verdict-mismatch':
      return (
        `  - [${v.report}] guard verdict mismatch: expected block=${v.expectedBlock}, ` +
        `got block=${v.actualBlock}.`
      );
    default:
      return `  - [${v.report ?? '?'}] ${JSON.stringify(v)}`;
  }
}

function run(rootDir = path.join(__dirname, '..'), ciYamlOverridePath = null) {
  const ciYamlPath = ciYamlOverridePath || path.join(rootDir, CI_WORKFLOW_PATH);

  let content;
  try {
    content = fs.readFileSync(ciYamlPath, 'utf8');
  } catch (err) {
    console.error(`okf-selectors check failed: could not read ${ciYamlPath} (${err.code ?? err}).`);
    return 1;
  }

  const { found, missing } = extractSelectors(content);
  if (missing.length > 0) {
    console.error(
      `okf-selectors check failed: could not extract ${missing.length} jq selector(s) from ` +
        `${ciYamlPath} -- ci.yml's Citation guard step was edited in a way this check no longer ` +
        `recognizes:\n`,
    );
    for (const name of missing) console.error(`  - missing selector: "${name}"`);
    return 1;
  }

  const allViolations = [];
  for (const reportName of [CLEAN_REPORT, DRIFTED_REPORT]) {
    const reportPath = path.join(rootDir, FIXTURES_DIR, reportName);
    if (!fs.existsSync(reportPath)) {
      allViolations.push({ reason: 'jq-failed', selector: '(fixture)', report: reportName, detail: `fixture not found at ${reportPath}` });
      continue;
    }
    const violations = checkFixture(found, reportPath, EXPECTED[reportName], reportName);
    allViolations.push(...violations);
  }

  if (allViolations.length > 0) {
    console.error(`okf-selectors check failed (${allViolations.length} violation(s)):\n`);
    for (const v of allViolations) console.error(formatViolation(v));
    return 1;
  }

  console.log(
    'okf-selectors check passed: all 5 jq selectors extracted from ci.yml select exactly the ' +
      'expected findings against both scripts/fixtures/okf-selectors/*-report.json fixtures.',
  );
  return 0;
}

function main() {
  const overridePath = process.argv[2] || process.env.OKF_SELECTORS_CI_YAML || null;
  process.exitCode = run(path.join(__dirname, '..'), overridePath);
}

module.exports = {
  CI_WORKFLOW_PATH,
  FIXTURES_DIR,
  CLEAN_REPORT,
  DRIFTED_REPORT,
  SELECTOR_PATTERNS,
  EXPECTED,
  extractSelectors,
  runJqFilter,
  checkFixture,
  run,
};

if (require.main === module) {
  main();
}
