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
 * A SIXTH pattern, `blockingCondition`, extracts the step's own red/green
 * verdict line (`if [ "${errors}" -gt 0 ] || [ "${count}" -gt 0 ] ||
 * [ "${ambiguousCount}" -gt 0 ]; then`) and asserts it still references
 * all three counters. This check no longer re-implements that boolean
 * expression from memory (a previous revision hardcoded `errors>0 ||
 * citationFindings.length>0 || ambiguousFindings.length>0` in JS, which
 * could silently drift from ci.yml's own line, e.g. a dropped
 * `ambiguousCount` leg): if the extracted line no longer matches this
 * pattern at all -- a leg dropped, an operator changed -- extraction
 * fails loud the same way a dropped jq selector does, instead of this
 * check quietly grading against a verdict ci.yml no longer computes.
 * `evaluateBlockingCondition()` below is the one small, explicit
 * evaluator over the three `-gt 0` legs this check uses, shared by both
 * the "would this fixture block" computation and the "should this
 * fixture block" expectation.
 *
 * This script also couples the two committed fixture reports (see below)
 * to the exact `okf-kit` version they were generated with:
 * `scripts/fixtures/okf-selectors/fixture-version.json`'s
 * `"okfKitVersion"` field is compared against the `okf-kit@X.Y.Z` pin
 * extracted from ci.yml's own "Install okf-kit (exact pin)" step (reusing
 * `check-okf-kit-pin.js`'s exported `extractPins()`, not a second regex).
 * A mismatch means the pin was bumped without regenerating these fixtures
 * -- exactly the drift `check-okf-kit-pin.js` cannot itself catch, since
 * it only checks that every workflow's pin agrees with every OTHER
 * workflow's pin, not that a fixture generated from an OLDER pin still
 * matches. This check fails loud naming both versions and pointing at
 * `scripts/fixtures/okf-selectors/README.md`'s "Regenerating" section.
 *
 * This script closes the selector-shape gap the same way
 * `check-okf-kit-pin.js` closes the pin-divergence gap: it EXTRACTS the
 * six patterns above straight out of ci.yml's Citation guard step (regex
 * over the `name=$(jq '...' ...)` / `name=$(jq -e '...' ...)` assignments
 * and the `if [ ... ] || [ ... ] || [ ... ]; then` verdict line -- not a
 * YAML parser; see `check-okf-test-citation-shape.js`'s docblock for why
 * this repo avoids the `js-yaml` dependency in a check that has to run
 * before `npm ci`), then runs the REAL `jq` binary (`child_process.
 * spawnSync`, never a reimplementation) with each extracted jq filter
 * against three canonical `okf-kit` JSON reports checked in under
 * `scripts/fixtures/okf-selectors/`:
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
 *     supposed to and NONE of the log.md/other-notice findings.
 *   - `error-report.json`: a bundle with one real `severity: "error"`
 *     finding (`frontmatter-required`, a doc missing its frontmatter
 *     block entirely) and nothing else, counted in `.summary.errors`.
 *     Exercises the `errors`-leg of the blocking verdict on its own --
 *     `clean-report.json` and `drifted-report.json` both leave `errors`
 *     at 0, so without this fixture the `errors` selector's own
 *     blocking behavior was only ever asserted at zero, never at a real
 *     positive value.
 *
 * For every fixture, the job's own red/green verdict, replayed via
 * `evaluateBlockingCondition()` with the values this check itself
 * observed, must match what the fixture is supposed to represent.
 *
 * See `scripts/fixtures/okf-selectors/README.md` for exactly how all
 * three reports were generated and how to regenerate them (and bump
 * `fixture-version.json`) against a newer `okf-kit` release.
 *
 * If any of the six patterns can no longer be extracted from ci.yml at
 * all (the step was rewritten, a variable renamed, a blocking leg
 * dropped), this check fails loud naming the missing pattern rather than
 * silently skipping it.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { extractPins } = require('./check-okf-kit-pin');

const CI_WORKFLOW_PATH = '.github/workflows/ci.yml';
const FIXTURES_DIR = path.join('scripts', 'fixtures', 'okf-selectors');
const CLEAN_REPORT = 'clean-report.json';
const DRIFTED_REPORT = 'drifted-report.json';
const ERROR_REPORT = 'error-report.json';
const FIXTURE_VERSION_FILE = 'fixture-version.json';

// One regex per named `jq` assignment in ci.yml's "Citation guard" step,
// plus one for the step's own blocking verdict line. Captures the filter
// expression (or, for `blockingCondition`, the whole verdict line)
// between the outer single quotes / bracket. `errors` alone uses
// `jq -e` (the other four never do), so it gets its own pattern with
// `-e` required in between. `blockingCondition` is matched against the
// EXACT literal shape of ci.yml's verdict line today (mirrors the other
// five patterns' own exact-structure style): if any of the three `-gt 0`
// legs is dropped, reordered past a rewrite, or the variable names
// change, this pattern stops matching and the missing-selector path
// below fires -- the same fail-loud behavior a dropped jq selector gets.
const SELECTOR_PATTERNS = {
  logFindings: /logFindings=\$\(jq\s+'([\s\S]*?)'\s*okf-anchor-report\.json\)/,
  citationFindings: /citationFindings=\$\(jq\s+'([\s\S]*?)'\s*okf-anchor-report\.json\)/,
  ambiguousFindings: /ambiguousFindings=\$\(jq\s+'([\s\S]*?)'\s*okf-anchor-report\.json\)/,
  otherNotices: /otherNotices=\$\(jq\s+'([\s\S]*?)'\s*okf-anchor-report\.json\)/,
  errors: /errors=\$\(jq\s+-e\s+'([\s\S]*?)'\s*okf-anchor-report\.json\)/,
  blockingCondition:
    /(if \[ "\$\{errors\}" -gt 0 \] \|\| \[ "\$\{count\}" -gt 0 \] \|\| \[ "\$\{ambiguousCount\}" -gt 0 \])/,
};

// The four jq selectors actually run against a report (blockingCondition
// is not a jq filter -- it is only extracted to be verified as present
// and to name the three counters `evaluateBlockingCondition` combines).
const ARRAY_SELECTOR_NAMES = ['logFindings', 'citationFindings', 'ambiguousFindings', 'otherNotices'];

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
    // 'untracked by git' comes from okf-kit's sources-fresh rule against
    // scripts/fixtures/okf-selectors/src/untracked.ts, which is
    // deliberately left untracked at fixture-generation time then
    // committed afterwards -- see
    // scripts/fixtures/okf-selectors/README.md's "Regenerating" section
    // before touching this fixture; a naive `git add -A` + regenerate
    // will not reproduce this notice.
    otherNotices: ['untracked by git'],
    errors: 0,
  },
  [ERROR_REPORT]: {
    logFindings: [],
    citationFindings: [],
    ambiguousFindings: [],
    otherNotices: [],
    errors: 1,
  },
};

/** Reads `content` (ci.yml's text) and returns `{ name: filterExpr }` for
 * every pattern found (the five jq selectors plus `blockingCondition`),
 * plus `missing`: an array of pattern names whose pattern did not match
 * at all. Never throws on a missing file -- the caller turns that into a
 * named violation. */
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

/** Reads `scripts/fixtures/okf-selectors/fixture-version.json` under
 * `rootDir` and returns `{ ok: true, version }` or `{ ok: false, reason
 * }` -- missing file, invalid JSON, and a missing/empty `okfKitVersion`
 * field are each a named, non-throwing failure so `run()` can report
 * them the same way it reports every other violation. */
function readFixtureVersion(rootDir) {
  const versionPath = path.join(rootDir, FIXTURES_DIR, FIXTURE_VERSION_FILE);
  let raw;
  try {
    raw = fs.readFileSync(versionPath, 'utf8');
  } catch (err) {
    return { ok: false, reason: `could not read ${versionPath} (${err.code ?? err})` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `${versionPath} is not valid JSON: ${err.message}` };
  }
  if (typeof parsed.okfKitVersion !== 'string' || parsed.okfKitVersion.trim() === '') {
    return { ok: false, reason: `${versionPath} is missing a non-empty string "okfKitVersion" field` };
  }
  return { ok: true, version: parsed.okfKitVersion };
}

/** The one `okf-kit@X.Y.Z` pin ci.yml's Citation guard step installs,
 * extracted from `content` via `check-okf-kit-pin.js`'s own exported
 * `extractPins()` (the same regex the pin-coupling check runs, not a
 * second, possibly-diverging one). Returns `{ ok: true, version }` when
 * exactly one pin is found, or `{ ok: false, reason }` when zero or more
 * than one is found -- either would make "the" pin ambiguous. */
function extractCiPin(content) {
  const pins = extractPins(content);
  if (pins.length === 0) {
    return { ok: false, reason: 'found 0 "npm install -g okf-kit@X.Y.Z" pins' };
  }
  if (pins.length > 1) {
    return { ok: false, reason: `found ${pins.length} "npm install -g okf-kit@X.Y.Z" pins, expected exactly 1` };
  }
  return { ok: true, version: pins[0] };
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

/** The one small, explicit evaluator over the three `-gt 0` legs ci.yml's
 * own blocking verdict line combines (`errors`, `citationFindings.length`
 * as `count`, `ambiguousFindings.length` as `ambiguousCount`). Used both
 * for "would this fixture's OBSERVED values block" and "SHOULD this
 * fixture's EXPECTED values block" -- one evaluator, two call sites,
 * instead of the boolean expression being written out twice and able to
 * drift apart. */
function evaluateBlockingCondition({ errors, count, ambiguousCount }) {
  return errors > 0 || count > 0 || ambiguousCount > 0;
}

/** Pure core: given the extracted `selectors` map and a `reportPath` /
 * `expected` pair, returns a violations array. Empty means every
 * selector selected exactly the expected findings (by rule-tag /
 * message-substring identity, not just count) and no log.md or
 * other-notice finding leaked into a blocking selector. */
function checkFixture(selectors, reportPath, expected, reportLabel) {
  const violations = [];

  const results = {};
  for (const name of ARRAY_SELECTOR_NAMES) {
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
  // via evaluateBlockingCondition() with the values this check itself
  // observed, must match what the fixture is supposed to represent.
  if (results.citationFindings && results.ambiguousFindings && errRun.ok) {
    const wouldBlock = evaluateBlockingCondition({
      errors: errRun.value,
      count: results.citationFindings.length,
      ambiguousCount: results.ambiguousFindings.length,
    });
    const expectedBlock = evaluateBlockingCondition({
      errors: expected.errors,
      count: expected.citationFindings.length,
      ambiguousCount: expected.ambiguousFindings.length,
    });
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
    case 'tag-not-selected': {
      const hint =
        v.selector === 'otherNotices'
          ? ' See scripts/fixtures/okf-selectors/README.md before regenerating -- the ' +
            '"untracked by git" notice depends on a deliberate not-yet-`git add`ed step at ' +
            'generation time, and a naive regeneration will not reproduce it.'
          : ' (okf-kit may have renamed ruleId/severity/file, or ci.yml\'s selector drifted.)';
      return `  - [${v.report}] selector "${v.selector}" selected nothing matching "${v.tag}".${hint}`;
    }
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
      `okf-selectors check failed: could not extract ${missing.length} pattern(s) from ` +
        `${ciYamlPath} -- ci.yml's Citation guard step was edited in a way this check no longer ` +
        `recognizes:\n`,
    );
    for (const name of missing) console.error(`  - missing pattern: "${name}"`);
    return 1;
  }

  const pin = extractCiPin(content);
  if (!pin.ok) {
    console.error(`okf-selectors check failed: could not determine ci.yml's okf-kit pin: ${pin.reason}.`);
    return 1;
  }

  const fixtureVersion = readFixtureVersion(rootDir);
  if (!fixtureVersion.ok) {
    console.error(`okf-selectors check failed: ${fixtureVersion.reason}.`);
    return 1;
  }

  if (fixtureVersion.version !== pin.version) {
    console.error(
      `okf-selectors check failed: ${FIXTURES_DIR}/${FIXTURE_VERSION_FILE} says the committed ` +
        `fixtures were generated with okf-kit@${fixtureVersion.version}, but ${ciYamlPath} pins ` +
        `okf-kit@${pin.version}. Regenerate ${FIXTURES_DIR}/*-report.json against ` +
        `okf-kit@${pin.version} (see ${FIXTURES_DIR}/README.md "Regenerating") and bump ` +
        `${FIXTURE_VERSION_FILE}'s "okfKitVersion" to match before this check can pass again.`,
    );
    return 1;
  }

  const allViolations = [];
  for (const reportName of [CLEAN_REPORT, DRIFTED_REPORT, ERROR_REPORT]) {
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
    'okf-selectors check passed: all 5 jq selectors and the blocking-verdict line extracted ' +
      `from ci.yml select/evaluate exactly as expected against all 3 ${FIXTURES_DIR}/*-report.json ` +
      `fixtures (generated with okf-kit@${fixtureVersion.version}, matching ci.yml's pin).`,
  );
  return 0;
}

function main() {
  process.exitCode = run();
}

module.exports = {
  CI_WORKFLOW_PATH,
  FIXTURES_DIR,
  CLEAN_REPORT,
  DRIFTED_REPORT,
  ERROR_REPORT,
  FIXTURE_VERSION_FILE,
  SELECTOR_PATTERNS,
  EXPECTED,
  extractSelectors,
  readFixtureVersion,
  extractCiPin,
  runJqFilter,
  evaluateBlockingCondition,
  checkFixture,
  run,
};

if (require.main === module) {
  main();
}
