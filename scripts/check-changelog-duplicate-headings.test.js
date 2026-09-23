/**
 * Unit tests for check-changelog-duplicate-headings.js.
 *
 * Runs entirely against disposable temp fixture roots (never this repo's
 * actual CHANGELOG.md files, except one real-repo sanity check at the
 * bottom that only reads). Uses Node's built-in test runner.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  isAllowlisted,
  findChangelogPaths,
  parseDatedSections,
  findDuplicateKinds,
  findAmbiguousHeadings,
  collectFileViolations,
  run,
} = require('./check-changelog-duplicate-headings');

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `check-dup-headings-${name}-`));
}

// ── parseDatedSections ──────────────────────────────────────────────────

test('parseDatedSections: "## X, DATE" shape', () => {
  const text = '# Changelog\n\n## [Unreleased]\n\n## 0.2.2, 2026-05-03\n\n### Added\n\n- a\n\n### Changed\n\n- b\n';
  const sections = parseDatedSections(text);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].version, '0.2.2');
  assert.deepEqual(sections[0].kinds, ['Added', 'Changed']);
});

test('parseDatedSections: "## [X] - DATE" shape', () => {
  const text = '# Changelog\n\n## [1.0.0] - 2026-01-01\n\n### Added\n\n- a\n';
  const sections = parseDatedSections(text);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].version, '1.0.0');
  assert.deepEqual(sections[0].kinds, ['Added']);
});

test('parseDatedSections: "## X \u2014 DATE" (em dash) shape is recognized (decision D-013: real packages/understanding-gate/CHANGELOG.md uses this)', () => {
  const text = '# Changelog\n\n## 0.2.0 \u2014 2026-05-02\n\n### Added\n\n- a\n';
  const sections = parseDatedSections(text);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].version, '0.2.0');
  assert.deepEqual(sections[0].kinds, ['Added']);
});

test('parseDatedSections: "## [X] \u2013 DATE" (en dash) shape is recognized', () => {
  const text = '# Changelog\n\n## [0.13.0] \u2013 2026-10-01\n\n### Added\n\n- a\n';
  const sections = parseDatedSections(text);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].version, '0.13.0');
});

test('parseDatedSections: "## [Unreleased]" is not a dated section', () => {
  const text = '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- pending\n';
  assert.deepEqual(parseDatedSections(text), []);
});

test('parseDatedSections: kinds do not leak across sections', () => {
  const text =
    '# Changelog\n\n## 0.2.0, 2026-02-01\n\n### Added\n\n- a\n\n## 0.1.0, 2026-01-01\n\n### Added\n\n- b\n';
  const sections = parseDatedSections(text);
  assert.equal(sections.length, 2);
  assert.deepEqual(sections[0].kinds, ['Added']);
  assert.deepEqual(sections[1].kinds, ['Added']);
});

test('parseDatedSections: a non-dated "## Notes" section after a dated one does not leak repeated ### headings into it', () => {
  const text =
    '# Changelog\n\n## 0.1.0, 2026-01-01\n\n### Added\n\n- a\n\n## Notes\n\n### Added\n\n- x\n\n### Added\n\n- y\n';
  const sections = parseDatedSections(text);
  assert.equal(sections.length, 1);
  assert.deepEqual(sections[0].kinds, ['Added']);
});

test('collectFileViolations: a non-dated "## Notes" section holding a repeated ### heading after a dated section -> no violation', () => {
  const text =
    '# Changelog\n\n## [Unreleased]\n\n## 0.1.0, 2026-01-01\n\n### Added\n\n- a\n\n## Notes\n\n### Added\n\n- x\n\n### Added\n\n- y\n';
  assert.deepEqual(collectFileViolations('packages/x/CHANGELOG.md', text), []);
});

// ── findAmbiguousHeadings / the three example shapes (decision D-013) ──

test('findAmbiguousHeadings: "## X.Y.Z (DATE)" (parenthesised date) does NOT match DATED_HEADING_RE and is reported as ambiguous (FAIL visibly, not silently skipped)', () => {
  const text = '# Changelog\n\n## 0.13.0 (2026-10-01)\n\n### Added\n\n- a\n\n### Added\n\n- b\n';
  assert.deepEqual(parseDatedSections(text), [], 'not recognized as a dated section');
  assert.deepEqual(findAmbiguousHeadings(text), ['## 0.13.0 (2026-10-01)']);
});

test('findAmbiguousHeadings: "## [X] \u2013 DATE" (en dash) DOES match DATED_HEADING_RE and is therefore NOT ambiguous (recognized as dated, then scanned)', () => {
  const text = '# Changelog\n\n## [0.13.0] \u2013 2026-10-01\n\n### Added\n\n- a\n';
  assert.deepEqual(findAmbiguousHeadings(text), []);
  assert.equal(parseDatedSections(text).length, 1, 'recognized as a dated section');
});

test('findAmbiguousHeadings: "## X, DATE (yanked)" (trailing annotation after the date) does NOT match DATED_HEADING_RE and is reported as ambiguous (FAIL visibly)', () => {
  const text = '# Changelog\n\n## 0.13.0, 2026-10-01 (yanked)\n\n### Added\n\n- a\n\n### Added\n\n- b\n';
  assert.deepEqual(parseDatedSections(text), [], 'not recognized as a dated section');
  assert.deepEqual(findAmbiguousHeadings(text), ['## 0.13.0, 2026-10-01 (yanked)']);
});

test('findAmbiguousHeadings: "## [Unreleased]" is never ambiguous (no semver token)', () => {
  assert.deepEqual(findAmbiguousHeadings('# Changelog\n\n## [Unreleased]\n\n- pending\n'), []);
});

test('findAmbiguousHeadings: a non-semver "## Notes" heading is never ambiguous', () => {
  assert.deepEqual(findAmbiguousHeadings('# Changelog\n\n## Notes\n\nsome prose\n'), []);
});

test('findAmbiguousHeadings: negative control -- a properly dated "## X, DATE" heading is not ambiguous', () => {
  assert.deepEqual(findAmbiguousHeadings('# Changelog\n\n## 0.1.0, 2026-01-01\n\n- a\n'), []);
});

test('collectFileViolations: an ambiguous heading produces an ambiguous-dated-heading violation, not allowlist-suppressible', () => {
  const text = '# Changelog\n\n## 0.13.0 (2026-10-01)\n\n### Added\n\n- a\n';
  const violations = collectFileViolations('CHANGELOG.md', text, [
    { file: 'CHANGELOG.md', version: '0.13.0 (2026-10-01)', kind: 'Added', reason: 'irrelevant: not allowlist-suppressible' },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].type, 'ambiguous-dated-heading');
  assert.equal(violations[0].heading, '## 0.13.0 (2026-10-01)');
});

test('run: an ambiguous version-shaped heading fails the whole check, an unrelated real dated section still passes clean otherwise', () => {
  const tmpRoot = tmp('run-ambiguous');
  try {
    fs.mkdirSync(path.join(tmpRoot, 'packages', 'pkg'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'packages', 'pkg', 'CHANGELOG.md'),
      '# Changelog\n\n## [Unreleased]\n\n## 0.2.0, 2026-05-02\n\n### Added\n\n- a\n\n## 0.13.0 (2026-10-01)\n\n### Added\n\n- b\n',
    );
    assert.equal(run(tmpRoot), 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── findDuplicateKinds ──────────────────────────────────────────────────

test('findDuplicateKinds: flags a kind occurring twice in one section', () => {
  const dupes = findDuplicateKinds([{ version: '0.12.0', kinds: ['Added', 'Changed', 'Added'] }]);
  assert.deepEqual(dupes, [{ version: '0.12.0', kind: 'Added', count: 2 }]);
});

test('findDuplicateKinds: negative control -- distinct kinds, no duplicate', () => {
  const dupes = findDuplicateKinds([{ version: '0.12.0', kinds: ['Added', 'Changed', 'Fixed'] }]);
  assert.deepEqual(dupes, []);
});

// ── isAllowlisted / collectFileViolations (injectable allowlist, decision D-013) ──

test('isAllowlisted: false when ALLOWLIST is empty (today\'s real state)', () => {
  assert.equal(isAllowlisted('CHANGELOG.md', '0.1.0', 'Added'), false);
});

test('isAllowlisted: an injected allowlist (not the module-level ALLOWLIST) is consulted when passed', () => {
  const allowlist = [{ file: 'CHANGELOG.md', version: '0.1.0', kind: 'Added', reason: 'pre-existing, task d51ae64b' }];
  assert.equal(isAllowlisted('CHANGELOG.md', '0.1.0', 'Added', allowlist), true);
  assert.equal(isAllowlisted('CHANGELOG.md', '0.1.0', 'Changed', allowlist), false);
  assert.equal(isAllowlisted('CHANGELOG.md', '0.1.0', 'Added'), false, 'the module-level ALLOWLIST is untouched');
});

test('collectFileViolations: seeded duplicate -> violation', () => {
  const text =
    '# Changelog\n\n## 0.12.0, 2026-09-21\n\n### Added\n\n- a\n\n### Changed\n\n- b\n\n### Added\n\n- c\n';
  const violations = collectFileViolations('packages/x/CHANGELOG.md', text);
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0], {
    type: 'duplicate-heading',
    file: 'packages/x/CHANGELOG.md',
    version: '0.12.0',
    kind: 'Added',
    count: 2,
  });
});

test('collectFileViolations: negative control -- no seeded duplicate, no violation', () => {
  const text = '# Changelog\n\n## 0.12.0, 2026-09-21\n\n### Added\n\n- a\n\n### Changed\n\n- b\n';
  assert.deepEqual(collectFileViolations('packages/x/CHANGELOG.md', text), []);
});

test('collectFileViolations: an allowlisted { file, version, kind } triple is suppressed, while a different non-listed duplicate in the same section still fails', () => {
  const text =
    '# Changelog\n\n## 0.12.0, 2026-09-21\n\n' +
    '### Added\n\n- a\n\n### Added\n\n- c\n\n' + // allowlisted duplicate: Added x2
    '### Changed\n\n- b\n\n### Changed\n\n- d\n'; // NOT allowlisted duplicate: Changed x2
  const allowlist = [{ file: 'packages/x/CHANGELOG.md', version: '0.12.0', kind: 'Added', reason: 'pre-existing' }];
  const violations = collectFileViolations('packages/x/CHANGELOG.md', text, allowlist);
  assert.equal(violations.length, 1, 'only the non-allowlisted Changed duplicate should be reported');
  assert.deepEqual(violations[0], {
    type: 'duplicate-heading',
    file: 'packages/x/CHANGELOG.md',
    version: '0.12.0',
    kind: 'Changed',
    count: 2,
  });
});

test('collectFileViolations: when the ONLY duplicate is allowlisted, the file has no violations at all (isAllowlisted mutation-probe target)', () => {
  const text = '# Changelog\n\n## 0.12.0, 2026-09-21\n\n### Added\n\n- a\n\n### Added\n\n- c\n';
  const allowlist = [{ file: 'packages/x/CHANGELOG.md', version: '0.12.0', kind: 'Added', reason: 'pre-existing' }];
  assert.deepEqual(collectFileViolations('packages/x/CHANGELOG.md', text, allowlist), []);
});

// ── findChangelogPaths ───────────────────────────────────────────────────

test('findChangelogPaths: finds root and packages/* CHANGELOG.md files', () => {
  const tmpRoot = tmp('find');
  try {
    fs.writeFileSync(path.join(tmpRoot, 'CHANGELOG.md'), '# Changelog\n');
    fs.mkdirSync(path.join(tmpRoot, 'packages', 'a'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'packages', 'a', 'CHANGELOG.md'), '# Changelog\n');
    fs.mkdirSync(path.join(tmpRoot, 'packages', 'b'), { recursive: true }); // no CHANGELOG.md
    const paths = findChangelogPaths(tmpRoot).sort();
    assert.deepEqual(paths, ['CHANGELOG.md', path.join('packages', 'a', 'CHANGELOG.md')].sort());
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── run() ────────────────────────────────────────────────────────────

test('run: red on a seeded duplicate, green after merging it back into one section (fix-or-allowlist shape)', () => {
  const tmpRoot = tmp('run-e2e');
  try {
    fs.mkdirSync(path.join(tmpRoot, 'packages', 'pkg'), { recursive: true });
    const changelogPath = path.join(tmpRoot, 'packages', 'pkg', 'CHANGELOG.md');
    fs.writeFileSync(
      changelogPath,
      '# Changelog\n\n## [Unreleased]\n\n## 0.12.0, 2026-09-21\n\n### Added\n\n- a\n\n### Changed\n\n- b\n\n### Added\n\n- c\n',
    );
    assert.equal(run(tmpRoot), 1, 'expected red with the seeded duplicate present');

    fs.writeFileSync(
      changelogPath,
      '# Changelog\n\n## [Unreleased]\n\n## 0.12.0, 2026-09-21\n\n### Added\n\n- a\n- c\n\n### Changed\n\n- b\n',
    );
    assert.equal(run(tmpRoot), 0, 'expected green once merged into one ### Added block');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run: an allowlisted duplicate (injected allowlist) does not fail the check', () => {
  const tmpRoot = tmp('run-allowlisted');
  try {
    fs.mkdirSync(path.join(tmpRoot, 'packages', 'pkg'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, 'packages', 'pkg', 'CHANGELOG.md'),
      '# Changelog\n\n## 0.12.0, 2026-09-21\n\n### Added\n\n- a\n\n### Added\n\n- c\n',
    );
    const allowlist = [
      { file: path.join('packages', 'pkg', 'CHANGELOG.md'), version: '0.12.0', kind: 'Added', reason: 'pre-existing' },
    ];
    assert.equal(run(tmpRoot, allowlist), 0);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run: fails loudly on zero CHANGELOG.md files found (vacuous-pass guard)', () => {
  const tmpRoot = tmp('run-zero');
  try {
    fs.mkdirSync(tmpRoot, { recursive: true });
    assert.equal(run(tmpRoot), 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run: real repo sanity check -- clean today (no pre-existing duplicate or ambiguous heading survives, verified when this check was introduced and again at round 3, decision D-013)', () => {
  const rootDir = path.join(__dirname, '..');
  assert.equal(run(rootDir), 0);
});
