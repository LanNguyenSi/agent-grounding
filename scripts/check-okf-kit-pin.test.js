/**
 * Unit tests for the pure checker in check-okf-kit-pin.js.
 *
 * `collectPinCouplingViolations` tests run entirely against in-memory
 * fixture arrays (including a negative control: a deliberate version
 * mismatch, and a missing-pin fixture). `run()` tests use disposable temp
 * roots with fixture workflow files, never this repo's real
 * .github/workflows/, so a negative control can safely assert a failing
 * exit code without touching a real file. Uses Node's built-in test runner
 * (`node --test`), matching check-pins.test.js / check-deps.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extractPin, collectPinCouplingViolations, run, WORKFLOW_FILES } = require('./check-okf-kit-pin');

// ── collectPinCouplingViolations (pure) ─────────────────────────────────────

test('collectPinCouplingViolations: matching pins across both files is clean', () => {
  const violations = collectPinCouplingViolations([
    { file: '.github/workflows/okf-staleness.yml', version: '0.6.0' },
    { file: '.github/workflows/ci.yml', version: '0.6.0' },
  ]);
  assert.deepEqual(violations, []);
});

test('collectPinCouplingViolations: negative control -- a diverging version is flagged', () => {
  const pins = [
    { file: '.github/workflows/okf-staleness.yml', version: '0.6.0' },
    { file: '.github/workflows/ci.yml', version: '0.5.0' },
  ];
  const violations = collectPinCouplingViolations(pins);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].reason, 'version-mismatch');
  assert.deepEqual(violations[0].versions, pins);
});

test('collectPinCouplingViolations: a file with no pin line at all is flagged missing-pin', () => {
  const violations = collectPinCouplingViolations([
    { file: '.github/workflows/okf-staleness.yml', version: '0.6.0' },
    { file: '.github/workflows/ci.yml', version: null },
  ]);
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0], { reason: 'missing-pin', file: '.github/workflows/ci.yml' });
});

test('collectPinCouplingViolations: three or more files, one outlier, still caught', () => {
  const violations = collectPinCouplingViolations([
    { file: 'a.yml', version: '0.6.0' },
    { file: 'b.yml', version: '0.6.0' },
    { file: 'c.yml', version: '0.7.0' },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].reason, 'version-mismatch');
});

// ── extractPin ───────────────────────────────────────────────────────────

test('extractPin: finds the pinned version in a fixture workflow file', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-kit-pin-extract-'));
  try {
    fs.writeFileSync(
      path.join(tmpRoot, 'wf.yml'),
      'jobs:\n  x:\n    steps:\n      - run: npm install -g okf-kit@0.6.0\n',
    );
    assert.equal(extractPin(tmpRoot, 'wf.yml'), '0.6.0');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('extractPin: returns null when the file has no okf-kit install line', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-kit-pin-noline-'));
  try {
    fs.writeFileSync(path.join(tmpRoot, 'wf.yml'), 'jobs:\n  x:\n    steps:\n      - run: echo hi\n');
    assert.equal(extractPin(tmpRoot, 'wf.yml'), null);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── run(rootDir) (CLI core, exit code) ──────────────────────────────────────

function writeFixtureWorkflows(tmpRoot, okfStalenessVersion, ciVersion) {
  for (const relPath of WORKFLOW_FILES) {
    fs.mkdirSync(path.dirname(path.join(tmpRoot, relPath)), { recursive: true });
  }
  fs.writeFileSync(
    path.join(tmpRoot, WORKFLOW_FILES[0]),
    `jobs:\n  x:\n    steps:\n      - run: npm install -g okf-kit@${okfStalenessVersion}\n`,
  );
  fs.writeFileSync(
    path.join(tmpRoot, WORKFLOW_FILES[1]),
    `jobs:\n  y:\n    steps:\n      - run: npm install -g okf-kit@${ciVersion}\n`,
  );
}

test('run(): matching pins in both real-shaped workflow files exits 0', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-kit-pin-run-clean-'));
  try {
    writeFixtureWorkflows(tmpRoot, '0.6.0', '0.6.0');
    assert.equal(run(tmpRoot), 0);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): negative control -- a diverging pin exits 1', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-kit-pin-run-mismatch-'));
  try {
    writeFixtureWorkflows(tmpRoot, '0.6.0', '0.5.0');
    assert.equal(run(tmpRoot), 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── Sanity check against the real repo ─────────────────────────────────────
// Not a substitute for `npm run check:okf-kit-pin` in CI (that's the real
// gate), but confirms the real .github/workflows/*.yml files parse and
// agree, so this test suite would fail loudly if this repo's own pin ever
// drifted apart across the two workflows.

test('run() against the real repo workflow files passes', () => {
  const rootDir = path.join(__dirname, '..');
  assert.equal(run(rootDir), 0);
});
