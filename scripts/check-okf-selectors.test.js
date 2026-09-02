/**
 * Unit tests for scripts/check-okf-selectors.js.
 *
 * `extractSelectors` tests run against in-memory fixture strings
 * (including negative controls: a workflow missing a named selector, and
 * one missing the blocking-verdict pattern). `checkFixture`/`run` tests
 * run the real `jq` binary against the three committed reports under
 * scripts/fixtures/okf-selectors/, plus disposable temp copies for
 * negative controls -- never mutating the committed fixtures or ci.yml in
 * place. Uses Node's built-in test runner (`node --test`), matching
 * check-okf-kit-pin.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  FIXTURES_DIR,
  CLEAN_REPORT,
  DRIFTED_REPORT,
  ERROR_REPORT,
  FIXTURE_VERSION_FILE,
  EXPECTED,
  extractSelectors,
  readFixtureVersion,
  extractCiPin,
  evaluateBlockingCondition,
  checkFixture,
  run,
} = require('./check-okf-selectors');

const ROOT_DIR = path.join(__dirname, '..');
const REAL_CI_YAML = path.join(ROOT_DIR, '.github', 'workflows', 'ci.yml');
const REAL_CI_YAML_CONTENT = fs.readFileSync(REAL_CI_YAML, 'utf8');
const { found: REAL_SELECTORS, missing: REAL_MISSING } = extractSelectors(REAL_CI_YAML_CONTENT);
const CLEAN_REPORT_PATH = path.join(ROOT_DIR, FIXTURES_DIR, CLEAN_REPORT);
const DRIFTED_REPORT_PATH = path.join(ROOT_DIR, FIXTURES_DIR, DRIFTED_REPORT);
const ERROR_REPORT_PATH = path.join(ROOT_DIR, FIXTURES_DIR, ERROR_REPORT);
const FIXTURE_VERSION_PATH = path.join(ROOT_DIR, FIXTURES_DIR, FIXTURE_VERSION_FILE);

/** Makes a fresh temp dir with a full, untouched copy of
 * scripts/fixtures/okf-selectors/*.json (all three reports plus
 * fixture-version.json) under it, mirroring FIXTURES_DIR's layout so
 * `run(tmpRoot, ciYamlPath)` finds everything it expects. Returns
 * `{ tmpRoot, fixturesDir, cleanup }`. Callers that want to mutate one
 * fixture do so on the copy, never on the committed original. */
function setupFullFixturesDir(prefix) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const fixturesDir = path.join(tmpRoot, FIXTURES_DIR);
  fs.mkdirSync(fixturesDir, { recursive: true });
  fs.copyFileSync(CLEAN_REPORT_PATH, path.join(fixturesDir, CLEAN_REPORT));
  fs.copyFileSync(DRIFTED_REPORT_PATH, path.join(fixturesDir, DRIFTED_REPORT));
  fs.copyFileSync(ERROR_REPORT_PATH, path.join(fixturesDir, ERROR_REPORT));
  fs.copyFileSync(FIXTURE_VERSION_PATH, path.join(fixturesDir, FIXTURE_VERSION_FILE));
  return {
    tmpRoot,
    fixturesDir,
    cleanup: () => fs.rmSync(tmpRoot, { recursive: true, force: true }),
  };
}

// ── extractSelectors (pure) ──────────────────────────────────────────────

test('extractSelectors: finds all six patterns (five jq selectors plus blockingCondition) in the real ci.yml', () => {
  assert.deepEqual(REAL_MISSING, []);
  assert.equal(typeof REAL_SELECTORS.logFindings, 'string');
  assert.equal(typeof REAL_SELECTORS.citationFindings, 'string');
  assert.equal(typeof REAL_SELECTORS.ambiguousFindings, 'string');
  assert.equal(typeof REAL_SELECTORS.otherNotices, 'string');
  assert.equal(typeof REAL_SELECTORS.errors, 'string');
  assert.equal(typeof REAL_SELECTORS.blockingCondition, 'string');
  assert.match(REAL_SELECTORS.blockingCondition, /\$\{errors\}/);
  assert.match(REAL_SELECTORS.blockingCondition, /\$\{count\}/);
  assert.match(REAL_SELECTORS.blockingCondition, /\$\{ambiguousCount\}/);
});

test('extractSelectors: negative control -- a workflow missing a selector reports it by name', () => {
  const partial = [
    'logFindings=$(jq \'[\\n  .findings[]\\n]\' okf-anchor-report.json)',
    'citationFindings=$(jq \'[\\n  .findings[]\\n]\' okf-anchor-report.json)',
    // ambiguousFindings deliberately omitted
    'otherNotices=$(jq \'[\\n  .findings[]\\n]\' okf-anchor-report.json)',
    'errors=$(jq -e \'.summary.errors | numbers\' okf-anchor-report.json)',
    'if [ "${errors}" -gt 0 ] || [ "${count}" -gt 0 ] || [ "${ambiguousCount}" -gt 0 ]; then',
  ].join('\n');
  const { found, missing } = extractSelectors(partial);
  assert.deepEqual(missing, ['ambiguousFindings']);
  assert.equal(typeof found.logFindings, 'string');
  assert.equal(typeof found.blockingCondition, 'string');
});

test('extractSelectors: negative control -- content with none of the patterns reports all six missing', () => {
  const { missing } = extractSelectors('jobs:\n  x:\n    steps:\n      - run: echo hi\n');
  assert.deepEqual(missing.sort(), [
    'ambiguousFindings',
    'blockingCondition',
    'citationFindings',
    'errors',
    'logFindings',
    'otherNotices',
  ]);
});

test('extractSelectors: F3 negative control -- the ambiguousCount leg dropped from the blocking line is reported missing', () => {
  const withoutAmbiguousLeg = REAL_CI_YAML_CONTENT.replace(
    'if [ "${errors}" -gt 0 ] || [ "${count}" -gt 0 ] || [ "${ambiguousCount}" -gt 0 ]; then',
    'if [ "${errors}" -gt 0 ] || [ "${count}" -gt 0 ]; then',
  );
  assert.notEqual(withoutAmbiguousLeg, REAL_CI_YAML_CONTENT, 'the blocking line must actually be present to mutate');
  const { missing } = extractSelectors(withoutAmbiguousLeg);
  assert.deepEqual(missing, ['blockingCondition']);
});

// ── evaluateBlockingCondition (pure) ─────────────────────────────────────

test('evaluateBlockingCondition: true iff any of the three legs is > 0', () => {
  assert.equal(evaluateBlockingCondition({ errors: 0, count: 0, ambiguousCount: 0 }), false);
  assert.equal(evaluateBlockingCondition({ errors: 1, count: 0, ambiguousCount: 0 }), true);
  assert.equal(evaluateBlockingCondition({ errors: 0, count: 1, ambiguousCount: 0 }), true);
  assert.equal(evaluateBlockingCondition({ errors: 0, count: 0, ambiguousCount: 1 }), true);
});

// ── readFixtureVersion / extractCiPin (pure) ─────────────────────────────

test('readFixtureVersion: the real fixture-version.json has a non-empty okfKitVersion', () => {
  const result = readFixtureVersion(ROOT_DIR);
  assert.equal(result.ok, true);
  assert.equal(typeof result.version, 'string');
  assert.notEqual(result.version, '');
});

test('extractCiPin: the real ci.yml has exactly one okf-kit pin, matching the fixture version', () => {
  const pin = extractCiPin(REAL_CI_YAML_CONTENT);
  assert.equal(pin.ok, true);
  const fixtureVersion = readFixtureVersion(ROOT_DIR);
  assert.equal(pin.version, fixtureVersion.version);
});

// ── checkFixture against the real committed fixtures ────────────────────

test('checkFixture: real ci.yml selectors against clean-report.json produce zero violations', () => {
  const violations = checkFixture(REAL_SELECTORS, CLEAN_REPORT_PATH, EXPECTED[CLEAN_REPORT], CLEAN_REPORT);
  assert.deepEqual(violations, []);
});

test('checkFixture: real ci.yml selectors against drifted-report.json produce zero violations (each selector selects exactly the expected finding(s))', () => {
  const violations = checkFixture(REAL_SELECTORS, DRIFTED_REPORT_PATH, EXPECTED[DRIFTED_REPORT], DRIFTED_REPORT);
  assert.deepEqual(violations, []);
});

test('checkFixture: real ci.yml selectors against error-report.json produce zero violations and the errors leg alone blocks', () => {
  const violations = checkFixture(REAL_SELECTORS, ERROR_REPORT_PATH, EXPECTED[ERROR_REPORT], ERROR_REPORT);
  assert.deepEqual(violations, []);
  assert.ok(EXPECTED[ERROR_REPORT].errors > 0, 'this fixture must exercise the errors-leg at a real positive value');
  const wouldBlock = evaluateBlockingCondition({
    errors: EXPECTED[ERROR_REPORT].errors,
    count: EXPECTED[ERROR_REPORT].citationFindings.length,
    ambiguousCount: EXPECTED[ERROR_REPORT].ambiguousFindings.length,
  });
  assert.equal(wouldBlock, true, 'error-report.json must make the guard block on the errors leg alone');
});

// ── run() (CLI core, exit code) ──────────────────────────────────────────

test('run(): the real repo (rootDir=ROOT_DIR, real ci.yml) exits 0', () => {
  assert.equal(run(ROOT_DIR), 0);
});

test('run(): a nonexistent ci.yml path exits 1 without throwing', () => {
  const bogus = path.join(os.tmpdir(), 'check-okf-selectors-does-not-exist-ci.yml');
  assert.equal(run(ROOT_DIR, bogus), 1);
});

test('run(): AC3 negative control -- a one-character typo in citationFindings\' severity selector against a TEMP copy of ci.yml exits 1, and the committed ci.yml is untouched', () => {
  const before = fs.readFileSync(REAL_CI_YAML, 'utf8');
  const mutated = before.replace(
    '.ruleId == "citations-resolve" and .severity == "warning" and .file != "log.md"',
    '.ruleId == "citations-resolve" and .severity == "warnin" and .file != "log.md"',
  );
  assert.notEqual(mutated, before, 'the citationFindings selector text must actually be present to mutate');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-selectors-mutant-'));
  try {
    const tmpCiYaml = path.join(tmpRoot, 'ci.yml');
    fs.writeFileSync(tmpCiYaml, mutated);

    assert.equal(run(ROOT_DIR, tmpCiYaml), 1);

    // The mutation probe must never touch the real, committed ci.yml.
    assert.equal(fs.readFileSync(REAL_CI_YAML, 'utf8'), before);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): a citationFindings selector that has been widened to match log.md too is caught (the log-md-leaked check)', () => {
  const before = fs.readFileSync(REAL_CI_YAML, 'utf8');
  const mutated = before.replace(
    '.ruleId == "citations-resolve" and .severity == "warning" and .file != "log.md"',
    '.ruleId == "citations-resolve" and .severity == "warning"',
  );
  assert.notEqual(mutated, before);

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-selectors-widen-'));
  try {
    const tmpCiYaml = path.join(tmpRoot, 'ci.yml');
    fs.writeFileSync(tmpCiYaml, mutated);
    assert.equal(run(ROOT_DIR, tmpCiYaml), 1);
    assert.equal(fs.readFileSync(REAL_CI_YAML, 'utf8'), before);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): F3 negative control -- the ambiguousCount leg dropped from the blocking line, run against a TEMP copy of ci.yml, exits 1 naming the missing blockingCondition pattern', () => {
  const before = fs.readFileSync(REAL_CI_YAML, 'utf8');
  const mutated = before.replace(
    'if [ "${errors}" -gt 0 ] || [ "${count}" -gt 0 ] || [ "${ambiguousCount}" -gt 0 ]; then',
    'if [ "${errors}" -gt 0 ] || [ "${count}" -gt 0 ]; then',
  );
  assert.notEqual(mutated, before, 'the blocking line must actually be present to mutate');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-selectors-blocking-leg-'));
  try {
    const tmpCiYaml = path.join(tmpRoot, 'ci.yml');
    fs.writeFileSync(tmpCiYaml, mutated);
    assert.equal(run(ROOT_DIR, tmpCiYaml), 1);
    assert.equal(fs.readFileSync(REAL_CI_YAML, 'utf8'), before);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): M1 negative control -- a ci.yml copy pinning okf-kit@0.9.1 (fixtures unchanged, still 0.9.0) exits 1 on the version mismatch', () => {
  const before = fs.readFileSync(REAL_CI_YAML, 'utf8');
  const mutated = before.replace('npm install -g okf-kit@0.9.0', 'npm install -g okf-kit@0.9.1');
  assert.notEqual(mutated, before, 'the okf-kit pin must actually be present to mutate');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-selectors-pin-bump-'));
  try {
    const tmpCiYaml = path.join(tmpRoot, 'ci.yml');
    fs.writeFileSync(tmpCiYaml, mutated);
    assert.equal(run(ROOT_DIR, tmpCiYaml), 1);
    assert.equal(fs.readFileSync(REAL_CI_YAML, 'utf8'), before);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): a drifted-report.json with the anchor-required finding\'s ruleId renamed exits 1 (citationFindings under-selects)', () => {
  const drifted = JSON.parse(fs.readFileSync(DRIFTED_REPORT_PATH, 'utf8'));
  const target = drifted.findings.find((f) => f.message.includes('[anchor-required]'));
  assert.ok(target, 'fixture must still contain an [anchor-required] finding to mutate');
  target.ruleId = 'rule_id_renamed_by_okf_kit';

  const { tmpRoot, fixturesDir, cleanup } = setupFullFixturesDir('check-okf-selectors-fixture-mutant-');
  try {
    fs.writeFileSync(path.join(fixturesDir, DRIFTED_REPORT), JSON.stringify(drifted, null, 2));
    assert.equal(run(tmpRoot, REAL_CI_YAML), 1);
  } finally {
    cleanup();
  }
});

test('run(): field-rename probe -- "severity" renamed to "level" in drifted-report.json exits 1', () => {
  const before = fs.readFileSync(DRIFTED_REPORT_PATH, 'utf8');
  const renamed = before.replace(/"severity":/g, '"level":');
  assert.notEqual(renamed, before);

  const { tmpRoot, fixturesDir, cleanup } = setupFullFixturesDir('check-okf-selectors-severity-rename-');
  try {
    fs.writeFileSync(path.join(fixturesDir, DRIFTED_REPORT), renamed);
    assert.equal(run(tmpRoot, REAL_CI_YAML), 1);
  } finally {
    cleanup();
  }
});

test('run(): field-rename probe -- "file" renamed to "path" in drifted-report.json exits 1', () => {
  const before = fs.readFileSync(DRIFTED_REPORT_PATH, 'utf8');
  const renamed = before.replace(/"file":/g, '"path":');
  assert.notEqual(renamed, before);

  const { tmpRoot, fixturesDir, cleanup } = setupFullFixturesDir('check-okf-selectors-file-rename-');
  try {
    fs.writeFileSync(path.join(fixturesDir, DRIFTED_REPORT), renamed);
    assert.equal(run(tmpRoot, REAL_CI_YAML), 1);
  } finally {
    cleanup();
  }
});

test('run(): message-suffix probe -- "[anchor-required]" changed to "(anchor-required)" in drifted-report.json exits 1', () => {
  const before = fs.readFileSync(DRIFTED_REPORT_PATH, 'utf8');
  const changed = before.replace('[anchor-required]', '(anchor-required)');
  assert.notEqual(changed, before);

  const { tmpRoot, fixturesDir, cleanup } = setupFullFixturesDir('check-okf-selectors-suffix-change-');
  try {
    fs.writeFileSync(path.join(fixturesDir, DRIFTED_REPORT), changed);
    assert.equal(run(tmpRoot, REAL_CI_YAML), 1);
  } finally {
    cleanup();
  }
});

// ── fail-closed paths ─────────────────────────────────────────────────────

test('run(): fail-closed -- malformed (non-JSON) fixture file exits 1', () => {
  const { tmpRoot, fixturesDir, cleanup } = setupFullFixturesDir('check-okf-selectors-malformed-json-');
  try {
    fs.writeFileSync(path.join(fixturesDir, CLEAN_REPORT), '{ this is not valid json');
    assert.equal(run(tmpRoot, REAL_CI_YAML), 1);
  } finally {
    cleanup();
  }
});

test('run(): fail-closed -- non-numeric .summary.errors exits 1', () => {
  const clean = JSON.parse(fs.readFileSync(CLEAN_REPORT_PATH, 'utf8'));
  clean.summary.errors = 'zero';

  const { tmpRoot, fixturesDir, cleanup } = setupFullFixturesDir('check-okf-selectors-nonnumeric-errors-');
  try {
    fs.writeFileSync(path.join(fixturesDir, CLEAN_REPORT), JSON.stringify(clean, null, 2));
    assert.equal(run(tmpRoot, REAL_CI_YAML), 1);
  } finally {
    cleanup();
  }
});

test('run(): fail-closed -- jq missing from PATH throws (never falls back to a reimplementation)', () => {
  const scriptPath = path.join(__dirname, 'check-okf-selectors.js');
  const nodeDir = path.dirname(process.execPath);
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: ROOT_DIR,
    env: { PATH: nodeDir },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires the real `jq` binary on PATH/);
});

// ── FIXTURE_OKF_KIT_VERSION coupling (F2) fail-closed paths ──────────────

test('run(): fail-closed -- missing fixture-version.json exits 1', () => {
  const { tmpRoot, fixturesDir, cleanup } = setupFullFixturesDir('check-okf-selectors-missing-version-');
  try {
    fs.rmSync(path.join(fixturesDir, FIXTURE_VERSION_FILE));
    assert.equal(run(tmpRoot, REAL_CI_YAML), 1);
  } finally {
    cleanup();
  }
});

test('run(): fail-closed -- fixture-version.json with a blank okfKitVersion exits 1', () => {
  const { tmpRoot, fixturesDir, cleanup } = setupFullFixturesDir('check-okf-selectors-blank-version-');
  try {
    fs.writeFileSync(path.join(fixturesDir, FIXTURE_VERSION_FILE), JSON.stringify({ okfKitVersion: '' }));
    assert.equal(run(tmpRoot, REAL_CI_YAML), 1);
  } finally {
    cleanup();
  }
});
