/**
 * Unit tests for scripts/check-okf-selectors.js.
 *
 * `extractSelectors` tests run against in-memory fixture strings
 * (including a negative control: a workflow missing one named
 * selector). `checkFixture`/`run` tests run the real `jq` binary against
 * the two committed reports under scripts/fixtures/okf-selectors/, plus
 * disposable temp copies for negative controls -- never mutating the
 * committed fixtures or ci.yml in place. Uses Node's built-in test
 * runner (`node --test`), matching check-okf-kit-pin.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  FIXTURES_DIR,
  CLEAN_REPORT,
  DRIFTED_REPORT,
  extractSelectors,
  checkFixture,
  run,
} = require('./check-okf-selectors');

const ROOT_DIR = path.join(__dirname, '..');
const REAL_CI_YAML = path.join(ROOT_DIR, '.github', 'workflows', 'ci.yml');
const REAL_CI_YAML_CONTENT = fs.readFileSync(REAL_CI_YAML, 'utf8');
const { found: REAL_SELECTORS, missing: REAL_MISSING } = extractSelectors(REAL_CI_YAML_CONTENT);
const CLEAN_REPORT_PATH = path.join(ROOT_DIR, FIXTURES_DIR, CLEAN_REPORT);
const DRIFTED_REPORT_PATH = path.join(ROOT_DIR, FIXTURES_DIR, DRIFTED_REPORT);

// ── extractSelectors (pure) ──────────────────────────────────────────────

test('extractSelectors: finds all five selectors in the real ci.yml', () => {
  assert.deepEqual(REAL_MISSING, []);
  assert.equal(typeof REAL_SELECTORS.logFindings, 'string');
  assert.equal(typeof REAL_SELECTORS.citationFindings, 'string');
  assert.equal(typeof REAL_SELECTORS.ambiguousFindings, 'string');
  assert.equal(typeof REAL_SELECTORS.otherNotices, 'string');
  assert.equal(typeof REAL_SELECTORS.errors, 'string');
});

test('extractSelectors: negative control -- a workflow missing a selector reports it by name', () => {
  const partial = [
    'logFindings=$(jq \'[\\n  .findings[]\\n]\' okf-anchor-report.json)',
    'citationFindings=$(jq \'[\\n  .findings[]\\n]\' okf-anchor-report.json)',
    // ambiguousFindings deliberately omitted
    'otherNotices=$(jq \'[\\n  .findings[]\\n]\' okf-anchor-report.json)',
    'errors=$(jq -e \'.summary.errors | numbers\' okf-anchor-report.json)',
  ].join('\n');
  const { found, missing } = extractSelectors(partial);
  assert.deepEqual(missing, ['ambiguousFindings']);
  assert.equal(typeof found.logFindings, 'string');
});

test('extractSelectors: negative control -- content with none of the selectors reports all five missing', () => {
  const { missing } = extractSelectors('jobs:\n  x:\n    steps:\n      - run: echo hi\n');
  assert.deepEqual(missing.sort(), [
    'ambiguousFindings',
    'citationFindings',
    'errors',
    'logFindings',
    'otherNotices',
  ]);
});

// ── checkFixture against the real committed fixtures ────────────────────

test('checkFixture: real ci.yml selectors against clean-report.json produce zero violations', () => {
  const { EXPECTED } = require('./check-okf-selectors');
  const violations = checkFixture(REAL_SELECTORS, CLEAN_REPORT_PATH, EXPECTED[CLEAN_REPORT], CLEAN_REPORT);
  assert.deepEqual(violations, []);
});

test('checkFixture: real ci.yml selectors against drifted-report.json produce zero violations (each selector selects exactly the expected finding(s))', () => {
  const { EXPECTED } = require('./check-okf-selectors');
  const violations = checkFixture(REAL_SELECTORS, DRIFTED_REPORT_PATH, EXPECTED[DRIFTED_REPORT], DRIFTED_REPORT);
  assert.deepEqual(violations, []);
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

test('run(): a drifted-report.json with the anchor-required finding\'s ruleId renamed exits 1, naming citationFindings', () => {
  const drifted = JSON.parse(fs.readFileSync(DRIFTED_REPORT_PATH, 'utf8'));
  const target = drifted.findings.find((f) => f.message.includes('[anchor-required]'));
  assert.ok(target, 'fixture must still contain an [anchor-required] finding to mutate');
  target.ruleId = 'rule_id_renamed_by_okf_kit';

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-selectors-fixture-mutant-'));
  try {
    const tmpFixturesDir = path.join(tmpRoot, FIXTURES_DIR);
    fs.mkdirSync(tmpFixturesDir, { recursive: true });
    fs.copyFileSync(CLEAN_REPORT_PATH, path.join(tmpFixturesDir, CLEAN_REPORT));
    fs.writeFileSync(path.join(tmpFixturesDir, DRIFTED_REPORT), JSON.stringify(drifted, null, 2));

    assert.equal(run(tmpRoot, REAL_CI_YAML), 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
