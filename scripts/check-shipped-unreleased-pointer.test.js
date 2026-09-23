/**
 * Unit tests for check-shipped-unreleased-pointer.js.
 *
 * Runs entirely against disposable temp fixture workspaces (never this
 * repo's actual packages/), one fixture per shipped-file kind
 * (README.md, CHANGELOG.md prose, dist/*.js, dist/*.d.ts) plus a negative
 * control (a non-empty Unreleased section still carrying pointer text is
 * NOT a violation). Uses Node's built-in test runner.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  isPublishable,
  readUnreleasedSectionState,
  resolveShippedFiles,
  isScannedKind,
  findPointerHit,
  collectPackageViolations,
  run,
} = require('./check-shipped-unreleased-pointer');

function writePkg(tmpRoot, dirName, files) {
  const pkgDir = path.join(tmpRoot, 'packages', dirName);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(pkgDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return pkgDir;
}

function tmp(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `check-unreleased-ptr-${name}-`));
}

// ── isPublishable ───────────────────────────────────────────────────────

test('isPublishable', () => {
  assert.equal(isPublishable({ private: false }), true);
  assert.equal(isPublishable({ private: undefined }), true);
  assert.equal(isPublishable({ private: true }), false);
});

// ── readUnreleasedSectionState ─────────────────────────────────────────

test('readUnreleasedSectionState: empty section', () => {
  const s = readUnreleasedSectionState('# Changelog\n\n## [Unreleased]\n\n## 0.1.0, 2026-01-01\n\nstuff\n');
  assert.deepEqual(s, { present: true, empty: true });
});

test('readUnreleasedSectionState: non-empty section', () => {
  const s = readUnreleasedSectionState('# Changelog\n\n## [Unreleased]\n\n- a thing\n\n## 0.1.0, 2026-01-01\n');
  assert.deepEqual(s, { present: true, empty: false });
});

test('readUnreleasedSectionState: no heading at all', () => {
  const s = readUnreleasedSectionState('# Changelog\n\n## 0.1.0, 2026-01-01\n\nstuff\n');
  assert.deepEqual(s, { present: false, empty: false });
});

test('readUnreleasedSectionState: empty section at end of file (no following heading)', () => {
  const s = readUnreleasedSectionState('# Changelog\n\n## [Unreleased]\n');
  assert.deepEqual(s, { present: true, empty: true });
});

// ── resolveShippedFiles / isScannedKind ─────────────────────────────────

test('resolveShippedFiles: expands a directory entry from "files" and includes plain file entries', () => {
  const tmpRoot = tmp('resolve');
  try {
    const pkgDir = writePkg(tmpRoot, 'pkg-a', {
      'README.md': 'hi',
      'CHANGELOG.md': '# Changelog\n',
      'dist/index.js': '// x',
      'dist/nested/x.d.ts': '// y',
      'src/index.ts': 'ignored, not in files',
    });
    const shipped = resolveShippedFiles({ dir: pkgDir, files: ['dist', 'README.md', 'CHANGELOG.md'] });
    const rels = shipped.map((p) => path.relative(pkgDir, p)).sort();
    assert.deepEqual(rels, [
      'CHANGELOG.md',
      'README.md',
      path.join('dist', 'index.js'),
      path.join('dist', 'nested', 'x.d.ts'),
    ].sort());
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('resolveShippedFiles: derives from "files", not hard-coded (a package with no dist entry ships no dist files)', () => {
  const tmpRoot = tmp('resolve-nodist');
  try {
    const pkgDir = writePkg(tmpRoot, 'pkg-a', {
      'README.md': 'hi',
      'dist/index.js': '// should not be scanned: not listed in files',
    });
    const shipped = resolveShippedFiles({ dir: pkgDir, files: ['README.md'] });
    const rels = shipped.map((p) => path.relative(pkgDir, p));
    assert.deepEqual(rels, ['README.md']);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('isScannedKind: README.md, CHANGELOG.md, dist/*.js, dist/*.d.ts are scanned; other dist entries are not', () => {
  const pkgDir = '/pkg';
  assert.equal(isScannedKind('/pkg/README.md', pkgDir), true);
  assert.equal(isScannedKind('/pkg/CHANGELOG.md', pkgDir), true);
  assert.equal(isScannedKind('/pkg/dist/a.js', pkgDir), true);
  assert.equal(isScannedKind('/pkg/dist/a.d.ts', pkgDir), true);
  assert.equal(isScannedKind('/pkg/dist/a.js.map', pkgDir), false);
  assert.equal(isScannedKind('/pkg/LICENSE', pkgDir), false);
});

// ── findPointerHit ────────────────────────────────────────────────────

test('findPointerHit: CHANGELOG.md heading line itself is not a hit', () => {
  const tmpRoot = tmp('hit-heading');
  try {
    const p = path.join(tmpRoot, 'CHANGELOG.md');
    fs.writeFileSync(p, '# Changelog\n\n## [Unreleased]\n\n## 0.1.0, 2026-01-01\n');
    assert.equal(findPointerHit(p), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('findPointerHit: CHANGELOG.md prose pointer elsewhere IS a hit (negative control for the heading exclusion)', () => {
  const tmpRoot = tmp('hit-prose');
  try {
    const p = path.join(tmpRoot, 'CHANGELOG.md');
    fs.writeFileSync(
      p,
      '# Changelog\n\n## [Unreleased]\n\n## 0.1.0, 2026-01-01\n\nSee CHANGELOG [Unreleased] for upcoming notes.\n',
    );
    assert.equal(findPointerHit(p), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('findPointerHit: README.md pointer is a hit', () => {
  const tmpRoot = tmp('hit-readme');
  try {
    const p = path.join(tmpRoot, 'README.md');
    fs.writeFileSync(p, 'See CHANGELOG.md [Unreleased] for upcoming notes.\n');
    assert.equal(findPointerHit(p), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('findPointerHit: dist/*.js comment pointer is a hit', () => {
  const tmpRoot = tmp('hit-js');
  try {
    const p = path.join(tmpRoot, 'index.js');
    fs.writeFileSync(p, '// see CHANGELOG.md [Unreleased] for the roadmap\nmodule.exports = {};\n');
    assert.equal(findPointerHit(p), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('findPointerHit: dist/*.d.ts comment pointer is a hit', () => {
  const tmpRoot = tmp('hit-dts');
  try {
    const p = path.join(tmpRoot, 'index.d.ts');
    fs.writeFileSync(p, '/** see CHANGELOG.md [Unreleased] for the roadmap */\nexport {};\n');
    assert.equal(findPointerHit(p), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── collectPackageViolations (per-kind fixtures + negative control) ────

const CHANGELOG_EMPTY = '# Changelog\n\n## [Unreleased]\n\n## 0.1.0, 2026-01-01\n\nfirst release\n';
const CHANGELOG_NONEMPTY = '# Changelog\n\n## [Unreleased]\n\n- something pending\n\n## 0.1.0, 2026-01-01\n\nfirst release\n';

test('collectPackageViolations: README.md fixture, empty Unreleased -> violation', () => {
  const tmpRoot = tmp('pkg-readme');
  try {
    const pkgDir = writePkg(tmpRoot, 'pkg', {
      'CHANGELOG.md': CHANGELOG_EMPTY,
      'README.md': 'See CHANGELOG.md [Unreleased] for what is coming next.\n',
    });
    const pkg = { name: '@x/pkg', dir: pkgDir, private: false, files: ['README.md', 'CHANGELOG.md'] };
    const violations = collectPackageViolations(pkg);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, 'README.md');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('collectPackageViolations: CHANGELOG.md prose fixture, empty Unreleased -> violation', () => {
  const tmpRoot = tmp('pkg-changelog');
  try {
    const pkgDir = writePkg(tmpRoot, 'pkg', {
      'CHANGELOG.md':
        '# Changelog\n\n## [Unreleased]\n\n## 0.1.0, 2026-01-01\n\nSee [Unreleased] above for what is next.\n',
    });
    const pkg = { name: '@x/pkg', dir: pkgDir, private: false, files: ['CHANGELOG.md'] };
    const violations = collectPackageViolations(pkg);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, 'CHANGELOG.md');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('collectPackageViolations: dist/*.js fixture, empty Unreleased -> violation', () => {
  const tmpRoot = tmp('pkg-js');
  try {
    const pkgDir = writePkg(tmpRoot, 'pkg', {
      'CHANGELOG.md': CHANGELOG_EMPTY,
      'dist/index.js': '// see CHANGELOG.md [Unreleased] for the roadmap\nmodule.exports = {};\n',
    });
    const pkg = { name: '@x/pkg', dir: pkgDir, private: false, files: ['dist', 'CHANGELOG.md'] };
    const violations = collectPackageViolations(pkg);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, path.join('dist', 'index.js'));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('collectPackageViolations: dist/*.d.ts fixture, empty Unreleased -> violation', () => {
  const tmpRoot = tmp('pkg-dts');
  try {
    const pkgDir = writePkg(tmpRoot, 'pkg', {
      'CHANGELOG.md': CHANGELOG_EMPTY,
      'dist/index.d.ts': '/** see CHANGELOG.md [Unreleased] for the roadmap */\nexport {};\n',
    });
    const pkg = { name: '@x/pkg', dir: pkgDir, private: false, files: ['dist', 'CHANGELOG.md'] };
    const violations = collectPackageViolations(pkg);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, path.join('dist', 'index.d.ts'));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('collectPackageViolations: negative control -- non-empty Unreleased with the same pointer text is NOT a violation', () => {
  const tmpRoot = tmp('pkg-neg');
  try {
    const pkgDir = writePkg(tmpRoot, 'pkg', {
      'CHANGELOG.md': CHANGELOG_NONEMPTY,
      'README.md': 'See CHANGELOG.md [Unreleased] for what is coming next.\n',
    });
    const pkg = { name: '@x/pkg', dir: pkgDir, private: false, files: ['README.md', 'CHANGELOG.md'] };
    const violations = collectPackageViolations(pkg);
    assert.deepEqual(violations, []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('collectPackageViolations: no [Unreleased] heading at all -> not applicable, no violation even with pointer text', () => {
  const tmpRoot = tmp('pkg-noheading');
  try {
    const pkgDir = writePkg(tmpRoot, 'pkg', {
      'CHANGELOG.md': '# Changelog\n\n## 0.1.0, 2026-01-01\n\nfirst release\n',
      'README.md': 'Mentions [Unreleased] in passing but there is no such heading.\n',
    });
    const pkg = { name: '@x/pkg', dir: pkgDir, private: false, files: ['README.md', 'CHANGELOG.md'] };
    assert.deepEqual(collectPackageViolations(pkg), []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── run() ────────────────────────────────────────────────────────────

test('run: fails loudly on zero publishable packages (vacuous-pass guard)', () => {
  const tmpRoot = tmp('run-zero');
  try {
    fs.mkdirSync(path.join(tmpRoot, 'packages'), { recursive: true });
    assert.equal(run(tmpRoot), 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run: red on a seeded violation, green after removing the pointer (fix-or-allowlist shape)', () => {
  const tmpRoot = tmp('run-e2e');
  try {
    writePkg(tmpRoot, 'pkg', {
      'CHANGELOG.md': CHANGELOG_EMPTY,
      'README.md': 'See CHANGELOG.md [Unreleased] for what is coming next.\n',
    });
    fs.writeFileSync(
      path.join(tmpRoot, 'packages', 'pkg', 'package.json'),
      JSON.stringify({ name: '@x/pkg', private: false, files: ['README.md', 'CHANGELOG.md'] }),
    );
    assert.equal(run(tmpRoot), 1, 'expected red with the dangling pointer present');

    fs.writeFileSync(
      path.join(tmpRoot, 'packages', 'pkg', 'README.md'),
      'No pointer here anymore.\n',
    );
    assert.equal(run(tmpRoot), 0, 'expected green once the pointer is removed');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run: real repo sanity check (never crashes against the actual packages/ tree)', () => {
  const rootDir = path.join(__dirname, '..');
  assert.doesNotThrow(() => run(rootDir));
});
