/**
 * Unit tests for check-okf-test-citation-shape.js: the one repo-local rule
 * left after okf-kit@0.8.0's `--require-anchors` absorbed the rest of the
 * former check-okf-anchors.js (see that script's own history in
 * docs/okf/log.md). Fixture-based, disposable temp directories only, plus
 * a sanity check against this repo's real docs/okf/ bundle. Uses Node's
 * built-in test runner (`node --test`), matching the sibling check-*.test.js
 * files.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  collectTestCitations,
  parseSourcesFrontmatter,
  hasParentSegment,
  resolveTestCitedPath,
  run,
  TEST_HEAD_RE,
  TEST_CLOSE_RE,
} = require('./check-okf-test-citation-shape');

// ── collectTestCitations ─────────────────────────────────────────────────

test('collectTestCitations: only *.test.ts targets are collected', () => {
  const content = 'see `lib.ts:1-3` and `tests/foo.test.ts:5-9#"x"` for detail';
  const citations = collectTestCitations(content);
  assert.equal(citations.length, 1);
  assert.equal(citations[0].citedPath, 'tests/foo.test.ts');
  assert.equal(citations[0].startLine, 5);
  assert.equal(citations[0].endLine, 9);
});

// ── parseSourcesFrontmatter / hasParentSegment (shared with the resolver)

test('parseSourcesFrontmatter: reads a top-level sources: list', () => {
  const content = '---\ntype: invariant\nsources:\n  - a/b.ts\n---\n\nbody';
  assert.deepEqual(parseSourcesFrontmatter(content), ['a/b.ts']);
});

test('hasParentSegment: a ".." path segment is detected', () => {
  assert.equal(hasParentSegment('../../etc/passwd'), true);
  assert.equal(hasParentSegment('tests/foo.test.ts'), false);
});

// ── resolveTestCitedPath ─────────────────────────────────────────────────

test('resolveTestCitedPath: a citedPath with a ".." segment is rejected', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-tcs-resolve-traversal-'));
  try {
    const docAbsPath = path.join(tmpRoot, 'docs', 'okf', 'doc.md');
    const result = resolveTestCitedPath(tmpRoot, docAbsPath, [], '../../etc/passwd');
    assert.deepEqual(result, { skipped: 'path-traversal-rejected' });
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('resolveTestCitedPath: a nonexistent path is unresolved', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-tcs-resolve-missing-'));
  try {
    const docAbsPath = path.join(tmpRoot, 'docs', 'okf', 'doc.md');
    const result = resolveTestCitedPath(tmpRoot, docAbsPath, [], 'nope.test.ts');
    assert.deepEqual(result, { skipped: 'unresolved' });
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── TEST_HEAD_RE / TEST_CLOSE_RE ─────────────────────────────────────────

test('TEST_HEAD_RE matches describe/it/test heads, not arbitrary lines', () => {
  assert.ok(TEST_HEAD_RE.test("  it('does a thing', async () => {"));
  assert.ok(TEST_HEAD_RE.test('describe("group", () => {'));
  assert.ok(!TEST_HEAD_RE.test('  const x = 1;'));
});

test('TEST_CLOSE_RE matches a bare closing });, not a nested one with trailing content', () => {
  assert.ok(TEST_CLOSE_RE.test('  });'));
  assert.ok(TEST_CLOSE_RE.test('});'));
  assert.ok(!TEST_CLOSE_RE.test('  }); // trailing comment'));
});

// ── run(rootDir) ──────────────────────────────────────────────────────────

function buildFixtureRepo() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-tcs-run-'));
  fs.mkdirSync(path.join(tmpRoot, 'docs', 'okf'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'tests'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, 'tests', 'foo.test.ts'),
    "it('does a thing', () => {\n  expect(1).toBe(1);\n});\n",
  );
  return tmpRoot;
}

function writeFixtureDoc(tmpRoot, citationLine) {
  fs.writeFileSync(
    path.join(tmpRoot, 'docs', 'okf', 'fixture.md'),
    `---\ntype: invariant\nsources:\n  - tests/foo.test.ts\n---\n\nSee ${citationLine} for detail.\n`,
  );
}

test('run(): a *.test.ts citation shaped head-to-close passes', () => {
  const tmpRoot = buildFixtureRepo();
  try {
    writeFixtureDoc(tmpRoot, '`tests/foo.test.ts:1-3#"expect(1).toBe(1);"`');
    const result = run(tmpRoot);
    assert.equal(result.exitCode, 0);
    assert.equal(result.summary.testCitationsChecked, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): negative control -- a range that does not start on a describe/it/test head fails', () => {
  const tmpRoot = buildFixtureRepo();
  try {
    // Range starts on line 2 (the body), not the it( head on line 1.
    writeFixtureDoc(tmpRoot, '`tests/foo.test.ts:2-3#"expect(1).toBe(1);"`');
    const result = run(tmpRoot);
    assert.equal(result.exitCode, 1);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].rule, 'test-citation-shape');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): negative control -- a range that does not end on the test\'s own closing }); fails', () => {
  const tmpRoot = buildFixtureRepo();
  try {
    // Range ends on line 2 (the body), never reaching the closing });.
    writeFixtureDoc(tmpRoot, '`tests/foo.test.ts:1-2#"expect(1).toBe(1);"`');
    const result = run(tmpRoot);
    assert.equal(result.exitCode, 1);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].rule, 'test-citation-shape');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): log.md is excluded entirely, even with a badly-shaped test citation in it', () => {
  const tmpRoot = buildFixtureRepo();
  try {
    writeFixtureDoc(tmpRoot, '`tests/foo.test.ts:1-3#"expect(1).toBe(1);"`');
    fs.writeFileSync(
      path.join(tmpRoot, 'docs', 'okf', 'log.md'),
      '---\ntype: invariant\nsources:\n  - tests/foo.test.ts\n---\n\n- bad shape: tests/foo.test.ts:2-2\n',
    );
    const result = run(tmpRoot);
    assert.equal(result.exitCode, 0);
    assert.equal(result.summary.filesChecked, 1); // fixture.md only, log.md excluded
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): a *.test.ts citation whose target cannot be resolved is skipped, not a violation', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-tcs-run-unresolved-'));
  try {
    fs.mkdirSync(path.join(tmpRoot, 'docs', 'okf'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'docs', 'okf', 'fixture.md'),
      '---\ntype: invariant\nsources:\n  - tests/foo.test.ts\n---\n\n' +
        'See `tests/foo.test.ts:1-3#"x"` for detail.\n',
    );
    const result = run(tmpRoot);
    assert.equal(result.exitCode, 0);
    assert.equal(result.summary.testCitationsChecked, 0);
    assert.equal(result.summary.skipped, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): sanity check against this repo\'s real docs/okf/ bundle', () => {
  const rootDir = path.join(__dirname, '..');
  const result = run(rootDir);
  assert.equal(result.exitCode, 0);
  assert.equal(result.violations.length, 0);
});
