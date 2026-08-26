/**
 * Unit tests for the pure/checker functions in check-okf-anchors.js.
 *
 * Parsing/resolution tests run against in-memory strings and disposable temp
 * directories. `run()` tests build a small fixture `docs/okf/` bundle plus
 * fixture target source files under a disposable temp root -- never this
 * repo's real docs/okf/ -- so the three negative controls named in this
 * task (missing anchor, anchor off its last line, duplicate anchor token in
 * range) can each assert a failing exit code without touching a real file.
 * Uses Node's built-in test runner (`node --test`), matching the sibling
 * check-*.test.js files.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  collectCitations,
  parseAnchor,
  parseSourcesFrontmatter,
  hasParentSegment,
  resolveCitedPath,
  buildBasenameIndex,
  run,
  TEST_HEAD_RE,
  TEST_CLOSE_RE,
} = require('./check-okf-anchors');

// ── parseAnchor ──────────────────────────────────────────────────────────

test('parseAnchor: undefined capture is no anchor', () => {
  assert.equal(parseAnchor(undefined), null);
});

test('parseAnchor: a quoted capture is a string anchor', () => {
  assert.deepEqual(parseAnchor('"return hyp;"'), { kind: 'string', text: 'return hyp;' });
});

test('parseAnchor: an unquoted capture is a heading anchor', () => {
  assert.deepEqual(parseAnchor('MyHeading'), { kind: 'heading', text: 'MyHeading' });
});

// ── collectCitations ─────────────────────────────────────────────────────

test('collectCitations: backtick-optional, with a range and a string anchor', () => {
  const content = 'see `lib.ts:10-12#"return x;"` for detail';
  const citations = collectCitations(content);
  assert.equal(citations.length, 1);
  assert.equal(citations[0].citedPath, 'lib.ts');
  assert.equal(citations[0].startLine, 10);
  assert.equal(citations[0].endLine, 12);
  assert.deepEqual(citations[0].anchor, { kind: 'string', text: 'return x;' });
});

test('collectCitations: single line, no anchor at all', () => {
  const content = 'see lib.ts:9 for the type';
  const citations = collectCitations(content);
  assert.equal(citations.length, 1);
  assert.equal(citations[0].startLine, 9);
  assert.equal(citations[0].endLine, 9);
  assert.equal(citations[0].anchor, null);
});

test('collectCitations: a bare "lines N-M" prose mention is NOT a citation', () => {
  const content = 'declares them on its type (lines 26-36)';
  assert.equal(collectCitations(content).length, 0);
});

// ── parseSourcesFrontmatter ──────────────────────────────────────────────

test('parseSourcesFrontmatter: reads a top-level sources: list', () => {
  const content = '---\ntype: invariant\nsources:\n  - a/b.ts\n  - c/d.ts\ntags: [x]\n---\n\nbody';
  assert.deepEqual(parseSourcesFrontmatter(content), ['a/b.ts', 'c/d.ts']);
});

test('parseSourcesFrontmatter: no frontmatter at all returns []', () => {
  assert.deepEqual(parseSourcesFrontmatter('just a body, no frontmatter'), []);
});

// ── resolveCitedPath ──────────────────────────────────────────────────────

test('resolveCitedPath: a qualified path resolves root-relative', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-anchors-resolve-'));
  try {
    fs.mkdirSync(path.join(tmpRoot, 'packages', 'a', 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'packages', 'a', 'src', 'lib.ts'), 'x\n');
    const docAbsPath = path.join(tmpRoot, 'docs', 'okf', 'doc.md');
    const citation = { citedPath: 'packages/a/src/lib.ts', matchIndex: 0 };
    const result = resolveCitedPath(tmpRoot, docAbsPath, [], [citation], citation, new Map());
    assert.equal(result.resolved, path.join(tmpRoot, 'packages', 'a', 'src', 'lib.ts'));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('resolveCitedPath: a bare filename named in the doc sources: resolves unambiguously', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-anchors-resolve-bare-'));
  try {
    fs.mkdirSync(path.join(tmpRoot, 'packages', 'a', 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'packages', 'b', 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'packages', 'a', 'src', 'cli.ts'), 'a\n');
    fs.writeFileSync(path.join(tmpRoot, 'packages', 'b', 'src', 'cli.ts'), 'b\n');
    const docAbsPath = path.join(tmpRoot, 'docs', 'okf', 'doc.md');
    const basenameIndex = buildBasenameIndex(tmpRoot);
    const citation = { citedPath: 'cli.ts', matchIndex: 0 };
    // Two same-named files exist repo-wide, but this doc's own `sources:`
    // names only packages/a's -- must resolve to that one, not fall
    // through to a false "ambiguous" via the repo-wide basename index.
    const result = resolveCitedPath(
      tmpRoot,
      docAbsPath,
      ['packages/a/src/cli.ts'],
      [citation],
      citation,
      basenameIndex,
    );
    assert.equal(result.resolved, path.join(tmpRoot, 'packages', 'a', 'src', 'cli.ts'));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('resolveCitedPath: a bare filename with two real candidates and no disambiguation is ambiguous', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-anchors-resolve-ambig-'));
  try {
    fs.mkdirSync(path.join(tmpRoot, 'packages', 'a', 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'packages', 'b', 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'packages', 'a', 'src', 'cli.ts'), 'a\n');
    fs.writeFileSync(path.join(tmpRoot, 'packages', 'b', 'src', 'cli.ts'), 'b\n');
    const docAbsPath = path.join(tmpRoot, 'docs', 'okf', 'doc.md');
    const basenameIndex = buildBasenameIndex(tmpRoot);
    const citation = { citedPath: 'cli.ts', matchIndex: 0 };
    const result = resolveCitedPath(tmpRoot, docAbsPath, [], [citation], citation, basenameIndex);
    assert.deepEqual(result, { skipped: 'ambiguous' });
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('resolveCitedPath: a nonexistent path is unresolved', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-anchors-resolve-missing-'));
  try {
    const docAbsPath = path.join(tmpRoot, 'docs', 'okf', 'doc.md');
    const citation = { citedPath: 'nope.ts', matchIndex: 0 };
    const result = resolveCitedPath(tmpRoot, docAbsPath, [], [citation], citation, new Map());
    assert.deepEqual(result, { skipped: 'unresolved' });
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── hasParentSegment / path traversal ───────────────────────────────────

test('hasParentSegment: a ".." path segment is detected', () => {
  assert.equal(hasParentSegment('../../etc/passwd'), true);
  assert.equal(hasParentSegment('packages/a/../../etc/passwd'), true);
});

test('hasParentSegment: a normal path, or one merely containing ".." as a substring, is not flagged', () => {
  assert.equal(hasParentSegment('packages/a/src/lib.ts'), false);
  assert.equal(hasParentSegment('packages/a..b/src/lib.ts'), false); // ".." inside a segment, not its own segment
});

test('resolveCitedPath: a citedPath with a ".." segment is rejected explicitly, not silently unresolved', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-anchors-resolve-traversal-'));
  try {
    // Even though ../../etc/passwd happens to exist on disk relative to
    // some directory, the ".." segment must reject it before any
    // filesystem check runs (mirrors okf-kit's own hasParentSegment,
    // checked before resolveCitation).
    const docAbsPath = path.join(tmpRoot, 'docs', 'okf', 'doc.md');
    const citation = { citedPath: '../../etc/passwd', matchIndex: 0 };
    const result = resolveCitedPath(tmpRoot, docAbsPath, [], [citation], citation, new Map());
    assert.deepEqual(result, { skipped: 'path-traversal-rejected' });
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): negative control -- a citedPath with a ".." segment is a violation, naming the citation', () => {
  const tmpRoot = buildFixtureRepo();
  try {
    fs.writeFileSync(
      path.join(tmpRoot, 'docs', 'okf', 'fixture.md'),
      '---\ntype: invariant\nsources:\n  - lib.ts\n---\n\n' +
        'See `../lib.ts:1-3#"const c = 3;"` for detail.\n',
    );
    const result = run(tmpRoot);
    assert.equal(result.exitCode, 1);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].rule, 'path-traversal-rejected');
    assert.match(result.violations[0].citation, /\.\.\/lib\.ts/);
    // Not silently counted as "unresolved" -- that would hide a
    // traversal attempt inside an innocuous-looking skip count.
    assert.equal(result.summary.skippedUnresolved, 0);
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

// ── run(rootDir): fixture bundle, including the three required negative
// controls ──────────────────────────────────────────────────────────────

/** Builds a disposable fixture repo: `docs/okf/fixture.md` (frontmatter
 * `sources:` pointing at `lib.ts`) plus `lib.ts` itself, three lines,
 * cited as `lib.ts:1-3`. Returns the root dir and the citation text used,
 * so a test can mutate the doc's own citation line and re-run. */
function buildFixtureRepo() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-okf-anchors-run-'));
  fs.mkdirSync(path.join(tmpRoot, 'docs', 'okf'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'lib.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  return tmpRoot;
}

function writeFixtureDoc(tmpRoot, citationLine) {
  fs.writeFileSync(
    path.join(tmpRoot, 'docs', 'okf', 'fixture.md'),
    `---\ntype: invariant\nsources:\n  - lib.ts\n---\n\nSee ${citationLine} for detail.\n`,
  );
}

test('run(): a fixture bundle with every citation correctly anchored passes', () => {
  const tmpRoot = buildFixtureRepo();
  try {
    writeFixtureDoc(tmpRoot, '`lib.ts:1-3#"const c = 3;"`');
    const result = run(tmpRoot);
    assert.equal(result.exitCode, 0);
    assert.equal(result.summary.totalCitations, 1);
    assert.equal(result.summary.anchored, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): negative control -- removing the anchor fails, naming the citation', () => {
  const tmpRoot = buildFixtureRepo();
  try {
    writeFixtureDoc(tmpRoot, '`lib.ts:1-3`'); // anchor removed entirely
    const result = run(tmpRoot);
    assert.equal(result.exitCode, 1);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].rule, 'missing-anchor');
    assert.match(result.violations[0].citation, /lib\.ts:1-3/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): negative control -- shifting the anchor off the range\'s last line fails', () => {
  const tmpRoot = buildFixtureRepo();
  try {
    // "const a = 1;" is line 1, not line 3 (the range's last line).
    writeFixtureDoc(tmpRoot, '`lib.ts:1-3#"const a = 1;"`');
    const result = run(tmpRoot);
    assert.equal(result.exitCode, 1);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].rule, 'anchor-not-on-last-line');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): negative control -- an anchor token duplicated inside the range fails', () => {
  const tmpRoot = buildFixtureRepo();
  try {
    // "const" occurs on the last line, but also on lines 1-2 of the range.
    writeFixtureDoc(tmpRoot, '`lib.ts:1-3#"const"`');
    const result = run(tmpRoot);
    assert.equal(result.exitCode, 1);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].rule, 'anchor-not-unique-in-range');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): a *.test.ts citation whose range does not span one whole test fails test-citation-shape', () => {
  const tmpRoot = buildFixtureRepo();
  try {
    fs.mkdirSync(path.join(tmpRoot, 'tests'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'tests', 'foo.test.ts'),
      "it('does a thing', () => {\n  expect(1).toBe(1);\n});\n",
    );
    fs.writeFileSync(
      path.join(tmpRoot, 'docs', 'okf', 'fixture.md'),
      '---\ntype: invariant\nsources:\n  - tests/foo.test.ts\n---\n\n' +
        'See `tests/foo.test.ts:2#"expect(1).toBe(1);"` for detail.\n',
    );
    const result = run(tmpRoot);
    assert.equal(result.exitCode, 1);
    assert.ok(result.violations.some((v) => v.rule === 'test-citation-shape'));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): a *.test.ts citation shaped head-to-close passes, even with a repeated nested });', () => {
  const tmpRoot = buildFixtureRepo();
  try {
    fs.mkdirSync(path.join(tmpRoot, 'tests'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'tests', 'foo.test.ts'),
      "it('does a thing', () => {\n  const x = fn({\n    a: 1,\n  });\n  expect(x.a).toBe(1);\n});\n",
    );
    fs.writeFileSync(
      path.join(tmpRoot, 'docs', 'okf', 'fixture.md'),
      '---\ntype: invariant\nsources:\n  - tests/foo.test.ts\n---\n\n' +
        'See `tests/foo.test.ts:1-6#"expect(x.a).toBe(1);"` for detail.\n',
    );
    const result = run(tmpRoot);
    assert.equal(result.exitCode, 0);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): rule (b) is intentionally DROPPED, not just satisfied by luck, for a *.test.ts citation', () => {
  // Same fixture shape as the test above, but this one is explicit about
  // WHY it passes: the anchor "expect(x.a).toBe(1);" sits on line 5 of a
  // 1-6 range, NOT the range's last line (6, "});"). For a non-test
  // citation this would be an anchor-not-on-last-line violation (rule b).
  // For a *.test.ts citation the shape rule (start on the test's own
  // head, end on its own closing });) REPLACES (b) entirely -- only (c)
  // ("occurs exactly once, anywhere in range") still applies. A pass here
  // proves (b) was skipped on purpose for this citation, not merely that
  // this particular anchor happened to also satisfy it.
  const tmpRoot = buildFixtureRepo();
  try {
    fs.mkdirSync(path.join(tmpRoot, 'tests'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'tests', 'foo.test.ts'),
      "it('does a thing', () => {\n  const x = fn({\n    a: 1,\n  });\n  expect(x.a).toBe(1);\n});\n",
    );
    fs.writeFileSync(
      path.join(tmpRoot, 'docs', 'okf', 'fixture.md'),
      '---\ntype: invariant\nsources:\n  - tests/foo.test.ts\n---\n\n' +
        'See `tests/foo.test.ts:1-6#"expect(x.a).toBe(1);"` for detail.\n',
    );
    const result = run(tmpRoot);
    assert.equal(result.exitCode, 0);
    assert.equal(result.summary.anchoredTestShaped, 1);
    assert.equal(result.summary.anchoredLastLineUnique, 0);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): negative control -- a *.test.ts citation whose anchor occurs TWICE in range still fails anchor-not-unique-in-range', () => {
  // Proves (c) still applies to a *.test.ts citation even though (b) does
  // not: only the LAST-LINE requirement is relaxed, not the
  // exactly-once-in-range one.
  const tmpRoot = buildFixtureRepo();
  try {
    fs.mkdirSync(path.join(tmpRoot, 'tests'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'tests', 'foo.test.ts'),
      "it('does a thing', () => {\n  expect(1).toBe(1);\n  expect(1).toBe(1);\n});\n",
    );
    fs.writeFileSync(
      path.join(tmpRoot, 'docs', 'okf', 'fixture.md'),
      '---\ntype: invariant\nsources:\n  - tests/foo.test.ts\n---\n\n' +
        'See `tests/foo.test.ts:1-4#"expect(1).toBe(1);"` for detail.\n',
    );
    const result = run(tmpRoot);
    assert.equal(result.exitCode, 1);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].rule, 'anchor-not-unique-in-range');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): log.md is excluded entirely, even with an unanchored citation in it', () => {
  const tmpRoot = buildFixtureRepo();
  try {
    writeFixtureDoc(tmpRoot, '`lib.ts:1-3#"const c = 3;"`');
    fs.writeFileSync(
      path.join(tmpRoot, 'docs', 'okf', 'log.md'),
      '---\ntype: invariant\nsources:\n  - lib.ts\n---\n\n- unanchored mention: lib.ts:1-3\n',
    );
    const result = run(tmpRoot);
    assert.equal(result.exitCode, 0);
    assert.equal(result.summary.filesChecked, 1); // fixture.md only, log.md excluded
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): an unresolvable target is skipped, not a violation', () => {
  const tmpRoot = buildFixtureRepo();
  try {
    fs.writeFileSync(
      path.join(tmpRoot, 'docs', 'okf', 'fixture.md'),
      '---\ntype: invariant\nsources:\n  - nowhere.ts\n---\n\nSee `nowhere.ts:1-3` for detail.\n',
    );
    const result = run(tmpRoot);
    assert.equal(result.exitCode, 0);
    assert.equal(result.summary.skippedUnresolved, 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── Sanity check against the real repo ─────────────────────────────────────
// Not a substitute for `npm run check:okf-anchors` in CI (that's the real
// gate), but confirms the real docs/okf/ bundle stays at 0 violations.

test('run() against the real repo docs/okf bundle passes', () => {
  const rootDir = path.join(__dirname, '..');
  const result = run(rootDir);
  assert.equal(result.exitCode, 0, JSON.stringify(result.violations, null, 2));
});
