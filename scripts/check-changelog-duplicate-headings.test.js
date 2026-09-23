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

// ── findDuplicateKinds ──────────────────────────────────────────────────

test('findDuplicateKinds: flags a kind occurring twice in one section', () => {
  const dupes = findDuplicateKinds([{ version: '0.12.0', kinds: ['Added', 'Changed', 'Added'] }]);
  assert.deepEqual(dupes, [{ version: '0.12.0', kind: 'Added', count: 2 }]);
});

test('findDuplicateKinds: negative control -- distinct kinds, no duplicate', () => {
  const dupes = findDuplicateKinds([{ version: '0.12.0', kinds: ['Added', 'Changed', 'Fixed'] }]);
  assert.deepEqual(dupes, []);
});

// ── isAllowlisted / collectFileViolations ───────────────────────────────

test('isAllowlisted: false when ALLOWLIST is empty (today\'s real state)', () => {
  assert.equal(isAllowlisted('CHANGELOG.md', '0.1.0', 'Added'), false);
});

test('collectFileViolations: seeded duplicate -> violation', () => {
  const text =
    '# Changelog\n\n## 0.12.0, 2026-09-21\n\n### Added\n\n- a\n\n### Changed\n\n- b\n\n### Added\n\n- c\n';
  const violations = collectFileViolations('packages/x/CHANGELOG.md', text);
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0], {
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

test('run: fails loudly on zero CHANGELOG.md files found (vacuous-pass guard)', () => {
  const tmpRoot = tmp('run-zero');
  try {
    fs.mkdirSync(tmpRoot, { recursive: true });
    assert.equal(run(tmpRoot), 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run: real repo sanity check -- clean today (no pre-existing duplicate survives, verified when this check was introduced)', () => {
  const rootDir = path.join(__dirname, '..');
  assert.equal(run(rootDir), 0);
});
