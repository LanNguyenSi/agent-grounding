/**
 * Unit tests for check-shipped-unreleased-pointer.js.
 *
 * Runs entirely against disposable temp fixture workspaces (never this
 * repo's actual packages/, except a real end-to-end run at the bottom that
 * only reads and asserts exit 0), one fixture per shipped-file kind
 * (README.md, CHANGELOG.md prose, dist/*.js, dist/*.d.ts) plus a negative
 * control (a non-empty Unreleased section still carrying pointer text is
 * NOT a violation). Uses Node's built-in test runner. The shipped-file set
 * is always resolved through an injected `packFn` stub, never a real
 * `npm pack`, except in the one real end-to-end test.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  isPublishable,
  readUnreleasedSectionState,
  isUnreleasedEffectivelyEmpty,
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

/** Stub packFn: ignores pkgName/rootDir, returns a fixed relative path list,
 * exactly like a real `npm pack --dry-run --json` result's `.files[].path`
 * list, without shelling out. */
function stubPackFn(relPaths) {
  return () => relPaths;
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

test('readUnreleasedSectionState: bracketless "## Unreleased" heading is recognized (finding 2)', () => {
  const s = readUnreleasedSectionState('# Changelog\n\n## Unreleased\n\n## 0.1.0, 2026-01-01\n');
  assert.deepEqual(s, { present: true, empty: true });
});

test('readUnreleasedSectionState: heading match is case-insensitive (finding 2)', () => {
  const s = readUnreleasedSectionState('# Changelog\n\n## unreleased\n\n## 0.1.0, 2026-01-01\n');
  assert.deepEqual(s, { present: true, empty: true });
});

test('readUnreleasedSectionState: a body with only ### sub-headings is empty (finding 3)', () => {
  const s = readUnreleasedSectionState(
    '# Changelog\n\n## [Unreleased]\n\n### Added\n\n### Changed\n\n## 0.1.0, 2026-01-01\n',
  );
  assert.deepEqual(s, { present: true, empty: true });
});

test('readUnreleasedSectionState: a body with only an HTML comment (incl. multi-line) is empty (finding 3)', () => {
  const s = readUnreleasedSectionState(
    '# Changelog\n\n## [Unreleased]\n\n<!--\n  nothing pending yet\n-->\n\n## 0.1.0, 2026-01-01\n',
  );
  assert.deepEqual(s, { present: true, empty: true });
});

test('readUnreleasedSectionState: negative control -- real content survives stripping', () => {
  const s = readUnreleasedSectionState(
    '# Changelog\n\n## [Unreleased]\n\n### Added\n\n- a real pending item\n\n## 0.1.0, 2026-01-01\n',
  );
  assert.deepEqual(s, { present: true, empty: false });
});

// ── isUnreleasedEffectivelyEmpty (finding 2) ────────────────────────────

test('isUnreleasedEffectivelyEmpty: no CHANGELOG.md at all -> effectively empty', () => {
  const tmpRoot = tmp('eff-nochangelog');
  try {
    assert.equal(isUnreleasedEffectivelyEmpty(path.join(tmpRoot, 'CHANGELOG.md')), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('isUnreleasedEffectivelyEmpty: CHANGELOG.md with no [Unreleased] heading -> effectively empty', () => {
  const tmpRoot = tmp('eff-noheading');
  try {
    const p = path.join(tmpRoot, 'CHANGELOG.md');
    fs.writeFileSync(p, '# Changelog\n\n## 0.1.0, 2026-01-01\n\nfirst release\n');
    assert.equal(isUnreleasedEffectivelyEmpty(p), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('isUnreleasedEffectivelyEmpty: negative control -- non-empty heading -> not effectively empty', () => {
  const tmpRoot = tmp('eff-nonempty');
  try {
    const p = path.join(tmpRoot, 'CHANGELOG.md');
    fs.writeFileSync(p, '# Changelog\n\n## [Unreleased]\n\n- pending\n');
    assert.equal(isUnreleasedEffectivelyEmpty(p), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── resolveShippedFiles (finding 4: npm-pack-derived, injectable) ──────

test('resolveShippedFiles: uses the injected packFn result, not a hard-coded list', () => {
  const tmpRoot = tmp('resolve');
  try {
    const pkgDir = writePkg(tmpRoot, 'pkg-a', {
      'README.md': 'hi',
      'CHANGELOG.md': '# Changelog\n',
      'dist/index.js': '// x',
      'dist/nested/x.d.ts': '// y',
      'src/index.ts': 'ignored, not reported by pack',
    });
    const packFn = stubPackFn(['README.md', 'CHANGELOG.md', 'dist/index.js', 'dist/nested/x.d.ts']);
    const shipped = resolveShippedFiles({ dir: pkgDir, name: '@x/pkg-a' }, tmpRoot, packFn);
    const rels = shipped.map((p) => path.relative(pkgDir, p)).sort();
    assert.deepEqual(
      rels,
      ['CHANGELOG.md', 'README.md', path.join('dist', 'index.js'), path.join('dist', 'nested', 'x.d.ts')].sort(),
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('resolveShippedFiles: a pack-reported path that no longer exists on disk is skipped, not thrown', () => {
  const tmpRoot = tmp('resolve-stale');
  try {
    const pkgDir = writePkg(tmpRoot, 'pkg-a', { 'README.md': 'hi' });
    const packFn = stubPackFn(['README.md', 'dist/gone.js']);
    const shipped = resolveShippedFiles({ dir: pkgDir, name: '@x/pkg-a' }, tmpRoot, packFn);
    assert.deepEqual(shipped.map((p) => path.relative(pkgDir, p)), ['README.md']);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('isScannedKind: README.md, CHANGELOG.md, dist/*.js, dist/*.d.ts, dist/*.mjs, dist/*.cjs, dist/*.d.mts, dist/*.d.cts are scanned (finding 6); other dist entries are not', () => {
  const pkgDir = '/pkg';
  assert.equal(isScannedKind('/pkg/README.md', pkgDir), true);
  assert.equal(isScannedKind('/pkg/CHANGELOG.md', pkgDir), true);
  assert.equal(isScannedKind('/pkg/dist/a.js', pkgDir), true);
  assert.equal(isScannedKind('/pkg/dist/a.d.ts', pkgDir), true);
  assert.equal(isScannedKind('/pkg/dist/a.mjs', pkgDir), true);
  assert.equal(isScannedKind('/pkg/dist/a.cjs', pkgDir), true);
  assert.equal(isScannedKind('/pkg/dist/a.d.mts', pkgDir), true);
  assert.equal(isScannedKind('/pkg/dist/a.d.cts', pkgDir), true);
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

test('findPointerHit: bracketless CHANGELOG.md heading line itself is not a hit', () => {
  const tmpRoot = tmp('hit-heading-bareheading');
  try {
    const p = path.join(tmpRoot, 'CHANGELOG.md');
    fs.writeFileSync(p, '# Changelog\n\n## Unreleased\n\n## 0.1.0, 2026-01-01\n');
    assert.equal(findPointerHit(p), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('findPointerHit: keep-a-changelog link-reference line is not a hit (finding 7)', () => {
  const tmpRoot = tmp('hit-linkref');
  try {
    const p = path.join(tmpRoot, 'CHANGELOG.md');
    fs.writeFileSync(
      p,
      '# Changelog\n\n## [Unreleased]\n\n## 0.1.0, 2026-01-01\n\n[Unreleased]: https://example.com/compare/v0.1.0...HEAD\n',
    );
    assert.equal(findPointerHit(p), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('findPointerHit: CHANGELOG.md prose pointer elsewhere IS a hit (negative control for the heading/link-ref exclusion)', () => {
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

test('findPointerHit: README.md bracketed pointer is a hit', () => {
  const tmpRoot = tmp('hit-readme');
  try {
    const p = path.join(tmpRoot, 'README.md');
    fs.writeFileSync(p, 'See CHANGELOG.md [Unreleased] for upcoming notes.\n');
    assert.equal(findPointerHit(p), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('findPointerHit: README.md bracketless capitalised word-bounded pointer is a hit (finding 6)', () => {
  const tmpRoot = tmp('hit-readme-bareword');
  try {
    const p = path.join(tmpRoot, 'README.md');
    fs.writeFileSync(p, 'See the Unreleased section of the CHANGELOG for upcoming notes.\n');
    assert.equal(findPointerHit(p), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('findPointerHit: README.md "(Unreleased)" parenthetical is a hit (finding 6)', () => {
  const tmpRoot = tmp('hit-readme-paren');
  try {
    const p = path.join(tmpRoot, 'README.md');
    fs.writeFileSync(p, 'Docs for the current (Unreleased) build.\n');
    assert.equal(findPointerHit(p), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('findPointerHit: negative control -- lowercase "unreleased" is not a hit (word must be capitalised)', () => {
  const tmpRoot = tmp('hit-readme-lower');
  try {
    const p = path.join(tmpRoot, 'README.md');
    fs.writeFileSync(p, 'This package has unreleased local changes during development.\n');
    assert.equal(findPointerHit(p), false);
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
    const pkg = { name: '@x/pkg', dir: pkgDir };
    const packFn = stubPackFn(['README.md', 'CHANGELOG.md']);
    const violations = collectPackageViolations(pkg, tmpRoot, packFn);
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
    const pkg = { name: '@x/pkg', dir: pkgDir };
    const packFn = stubPackFn(['CHANGELOG.md']);
    const violations = collectPackageViolations(pkg, tmpRoot, packFn);
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
    const pkg = { name: '@x/pkg', dir: pkgDir };
    const packFn = stubPackFn(['CHANGELOG.md', 'dist/index.js']);
    const violations = collectPackageViolations(pkg, tmpRoot, packFn);
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
    const pkg = { name: '@x/pkg', dir: pkgDir };
    const packFn = stubPackFn(['CHANGELOG.md', 'dist/index.d.ts']);
    const violations = collectPackageViolations(pkg, tmpRoot, packFn);
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
    const pkg = { name: '@x/pkg', dir: pkgDir };
    const packFn = stubPackFn(['README.md', 'CHANGELOG.md']);
    const violations = collectPackageViolations(pkg, tmpRoot, packFn);
    assert.deepEqual(violations, []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('collectPackageViolations: no [Unreleased] heading at all + a shipped pointer -> violation (finding 2: treated like empty, not skipped)', () => {
  const tmpRoot = tmp('pkg-noheading');
  try {
    const pkgDir = writePkg(tmpRoot, 'pkg', {
      'CHANGELOG.md': '# Changelog\n\n## 0.1.0, 2026-01-01\n\nfirst release\n',
      'README.md': 'See the Unreleased section for what is next.\n',
    });
    const pkg = { name: '@x/pkg', dir: pkgDir };
    const packFn = stubPackFn(['README.md', 'CHANGELOG.md']);
    const violations = collectPackageViolations(pkg, tmpRoot, packFn);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, 'README.md');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('collectPackageViolations: no CHANGELOG.md at all + a shipped pointer -> violation (finding 2)', () => {
  const tmpRoot = tmp('pkg-nochangelog');
  try {
    const pkgDir = writePkg(tmpRoot, 'pkg', {
      'README.md': 'See CHANGELOG.md [Unreleased] for what is next.\n',
    });
    const pkg = { name: '@x/pkg', dir: pkgDir };
    const packFn = stubPackFn(['README.md']);
    const violations = collectPackageViolations(pkg, tmpRoot, packFn);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, 'README.md');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('collectPackageViolations: Unreleased body with only ### stubs + a shipped pointer -> violation (finding 3)', () => {
  const tmpRoot = tmp('pkg-stubs');
  try {
    const pkgDir = writePkg(tmpRoot, 'pkg', {
      'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n### Added\n\n### Changed\n\n## 0.1.0, 2026-01-01\n\nfirst release\n',
      'README.md': 'See CHANGELOG.md [Unreleased] for what is next.\n',
    });
    const pkg = { name: '@x/pkg', dir: pkgDir };
    const packFn = stubPackFn(['README.md', 'CHANGELOG.md']);
    const violations = collectPackageViolations(pkg, tmpRoot, packFn);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].file, 'README.md');
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
    const packFn = stubPackFn(['README.md', 'CHANGELOG.md']);
    assert.equal(run(tmpRoot, packFn), 1, 'expected red with the dangling pointer present');

    fs.writeFileSync(
      path.join(tmpRoot, 'packages', 'pkg', 'README.md'),
      'No pointer here anymore.\n',
    );
    assert.equal(run(tmpRoot, packFn), 0, 'expected green once the pointer is removed');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test(
  'run: real repo sanity check (asserts exit 0 against the actual packages/ tree, finding 9)',
  { timeout: 120000 },
  () => {
    const rootDir = path.join(__dirname, '..');
    assert.equal(run(rootDir), 0);
  },
);
