/**
 * Unit tests for the pure checker in check-okf-kit-pin.js.
 *
 * `collectPinCouplingViolations` tests run entirely against in-memory
 * fixture arrays (including negative controls: a cross-file mismatch, a
 * same-file mismatch, an unreadable file, and the zero-pins vacuous-pass
 * guard). `run()` tests use disposable temp roots with fixture
 * `.github/workflows/*.yml` files, never this repo's real workflows, so a
 * negative control can safely assert a failing exit code without touching
 * a real file. Uses Node's built-in test runner (`node --test`), matching
 * check-pins.test.js / check-deps.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  listWorkflowFiles,
  readWorkflowFile,
  extractPins,
  collectPinCouplingViolations,
  run,
} = require('./check-okf-kit-pin');

// ── collectPinCouplingViolations (pure) ─────────────────────────────────────

test('collectPinCouplingViolations: matching pins across two files is clean', () => {
  const violations = collectPinCouplingViolations([
    { file: '.github/workflows/okf-staleness.yml', version: '0.6.0' },
    { file: '.github/workflows/ci.yml', version: '0.6.0' },
  ]);
  assert.deepEqual(violations, []);
});

test('collectPinCouplingViolations: negative control -- a diverging version across files is flagged', () => {
  const occurrences = [
    { file: '.github/workflows/okf-staleness.yml', version: '0.6.0' },
    { file: '.github/workflows/ci.yml', version: '0.5.0' },
  ];
  const violations = collectPinCouplingViolations(occurrences);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].reason, 'version-mismatch');
  assert.deepEqual(violations[0].occurrences, occurrences);
});

test('collectPinCouplingViolations: negative control -- two differing pins inside the SAME file are flagged', () => {
  const occurrences = [
    { file: '.github/workflows/matrix.yml', version: '0.6.0' },
    { file: '.github/workflows/matrix.yml', version: '0.5.0' },
  ];
  const violations = collectPinCouplingViolations(occurrences);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].reason, 'version-mismatch');
});

test('collectPinCouplingViolations: three or more occurrences, one outlier, still caught', () => {
  const violations = collectPinCouplingViolations([
    { file: 'a.yml', version: '0.6.0' },
    { file: 'b.yml', version: '0.6.0' },
    { file: 'c.yml', version: '0.7.0' },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].reason, 'version-mismatch');
});

test('collectPinCouplingViolations: zero occurrences anywhere is the vacuous-pass guard, not a silent pass', () => {
  const violations = collectPinCouplingViolations([]);
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0], { reason: 'zero-pins-found' });
});

test('collectPinCouplingViolations: an unreadable file is its own named violation', () => {
  const violations = collectPinCouplingViolations(
    [{ file: 'a.yml', version: '0.6.0' }],
    [{ file: '.github/workflows/b.yml', code: 'EACCES' }],
  );
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0], { reason: 'unreadable-file', file: '.github/workflows/b.yml', code: 'EACCES' });
});

test('collectPinCouplingViolations: an unreadable file AND a version mismatch are both reported', () => {
  const violations = collectPinCouplingViolations(
    [
      { file: 'a.yml', version: '0.6.0' },
      { file: 'c.yml', version: '0.7.0' },
    ],
    [{ file: 'b.yml', code: 'ENOENT' }],
  );
  assert.equal(violations.length, 2);
  assert.deepEqual(
    violations.map((v) => v.reason).sort(),
    ['unreadable-file', 'version-mismatch'],
  );
});

// ── extractPins ──────────────────────────────────────────────────────────

test('extractPins: finds a single pinned version', () => {
  assert.deepEqual(extractPins('jobs:\n  x:\n    steps:\n      - run: npm install -g okf-kit@0.6.0\n'), [
    '0.6.0',
  ]);
});

test('extractPins: finds multiple pin lines in the same file, in order', () => {
  const content =
    'jobs:\n' +
    '  a:\n' +
    '    steps:\n' +
    '      - run: npm install -g okf-kit@0.6.0\n' +
    '  b:\n' +
    '    steps:\n' +
    '      - run: npm install -g okf-kit@0.5.0\n';
  assert.deepEqual(extractPins(content), ['0.6.0', '0.5.0']);
});

test('extractPins: returns [] when the file has no okf-kit install line', () => {
  assert.deepEqual(extractPins('jobs:\n  x:\n    steps:\n      - run: echo hi\n'), []);
});

test('extractPins: does NOT match a descriptive comment mentioning the literal string, not a real pin', () => {
  // Regression: an earlier version of PIN_RE (bare `\S+` after `okf-kit@`)
  // matched this repo's own ci.yml comment "npm install -g okf-kit@..."
  // (describing what check-okf-kit-pin.js does) as if it were a real pin,
  // capturing the literal string "..." as a "version". PIN_RE now requires
  // a semver-shaped version, so a comment like this is correctly ignored.
  const content = '      # Asserts this workflow\'s own "npm install -g okf-kit@..." pin\n';
  assert.deepEqual(extractPins(content), []);
});

// ── listWorkflowFiles / readWorkflowFile ────────────────────────────────────

test('listWorkflowFiles: lists every *.yml file under .github/workflows, sorted', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-kit-pin-list-'));
  try {
    const dir = path.join(tmpRoot, '.github', 'workflows');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'b.yml'), 'jobs: {}\n');
    fs.writeFileSync(path.join(dir, 'a.yml'), 'jobs: {}\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a workflow\n');
    assert.deepEqual(listWorkflowFiles(tmpRoot), [
      path.join('.github', 'workflows', 'a.yml'),
      path.join('.github', 'workflows', 'b.yml'),
    ]);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('readWorkflowFile: reads a real file', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-kit-pin-read-'));
  try {
    fs.mkdirSync(path.join(tmpRoot, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, '.github', 'workflows', 'wf.yml'), 'hello\n');
    const result = readWorkflowFile(tmpRoot, path.join('.github', 'workflows', 'wf.yml'));
    assert.deepEqual(result, { ok: true, content: 'hello\n' });
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('readWorkflowFile: a nonexistent file returns ok:false with the error code, not a thrown exception', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-kit-pin-read-missing-'));
  try {
    const result = readWorkflowFile(tmpRoot, path.join('.github', 'workflows', 'nope.yml'));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ENOENT');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── run(rootDir) (CLI core, exit code) ──────────────────────────────────────

function writeWorkflow(tmpRoot, name, content) {
  const dir = path.join(tmpRoot, '.github', 'workflows');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

test('run(): matching pins across two fixture workflow files exits 0', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-kit-pin-run-clean-'));
  try {
    writeWorkflow(tmpRoot, 'okf-staleness.yml', 'jobs:\n  x:\n    steps:\n      - run: npm install -g okf-kit@0.6.0\n');
    writeWorkflow(tmpRoot, 'ci.yml', 'jobs:\n  y:\n    steps:\n      - run: npm install -g okf-kit@0.6.0\n');
    assert.equal(run(tmpRoot), 0);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): negative control -- a diverging pin across two files exits 1', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-kit-pin-run-mismatch-'));
  try {
    writeWorkflow(tmpRoot, 'okf-staleness.yml', 'jobs:\n  x:\n    steps:\n      - run: npm install -g okf-kit@0.6.0\n');
    writeWorkflow(tmpRoot, 'ci.yml', 'jobs:\n  y:\n    steps:\n      - run: npm install -g okf-kit@0.5.0\n');
    assert.equal(run(tmpRoot), 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): negative control -- two install lines with DIFFERENT versions in ONE file exits 1', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-kit-pin-run-samefile-mismatch-'));
  try {
    writeWorkflow(
      tmpRoot,
      'matrix.yml',
      'jobs:\n' +
        '  a:\n' +
        '    steps:\n' +
        '      - run: npm install -g okf-kit@0.6.0\n' +
        '  b:\n' +
        '    steps:\n' +
        '      - run: npm install -g okf-kit@0.5.0\n',
    );
    const result = run(tmpRoot);
    assert.equal(result, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): a THIRD workflow file that also pins okf-kit is in scope automatically (glob, not a hardcoded 2-file list)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-kit-pin-run-third-file-'));
  try {
    writeWorkflow(tmpRoot, 'okf-staleness.yml', 'jobs:\n  x:\n    steps:\n      - run: npm install -g okf-kit@0.6.0\n');
    writeWorkflow(tmpRoot, 'ci.yml', 'jobs:\n  y:\n    steps:\n      - run: npm install -g okf-kit@0.6.0\n');
    // A THIRD workflow, unrelated name, also pins okf-kit but at a
    // DIFFERENT version -- must be caught even though it is neither of
    // the two files this check used to hardcode.
    writeWorkflow(tmpRoot, 'nightly-docs-check.yml', 'jobs:\n  z:\n    steps:\n      - run: npm install -g okf-kit@0.7.0\n');
    const result = run(tmpRoot);
    assert.equal(result, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): a third workflow file with the SAME pin is silently fine (glob picks it up, agrees)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-kit-pin-run-third-file-agrees-'));
  try {
    writeWorkflow(tmpRoot, 'okf-staleness.yml', 'jobs:\n  x:\n    steps:\n      - run: npm install -g okf-kit@0.6.0\n');
    writeWorkflow(tmpRoot, 'ci.yml', 'jobs:\n  y:\n    steps:\n      - run: npm install -g okf-kit@0.6.0\n');
    writeWorkflow(tmpRoot, 'nightly-docs-check.yml', 'jobs:\n  z:\n    steps:\n      - run: npm install -g okf-kit@0.6.0\n');
    assert.equal(run(tmpRoot), 0);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): zero workflow files pinning okf-kit anywhere exits 1 via the vacuous-pass guard', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-kit-pin-run-zero-'));
  try {
    writeWorkflow(tmpRoot, 'unrelated.yml', 'jobs:\n  x:\n    steps:\n      - run: echo hi\n');
    assert.equal(run(tmpRoot), 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): a missing .github/workflows directory exits 1 rather than throwing', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-kit-pin-run-nodir-'));
  try {
    assert.equal(run(tmpRoot), 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── Sanity check against the real repo ─────────────────────────────────────
// Not a substitute for `npm run check:okf-kit-pin` in CI (that's the real
// gate), but confirms the real .github/workflows/*.yml files parse and
// agree, so this test suite would fail loudly if this repo's own pin ever
// drifted apart across any workflow, including a future third one.

test('run() against the real repo workflow files passes', () => {
  const rootDir = path.join(__dirname, '..');
  assert.equal(run(rootDir), 0);
});
