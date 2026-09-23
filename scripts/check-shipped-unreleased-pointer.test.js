/**
 * Unit tests for check-shipped-unreleased-pointer.js.
 *
 * Runs entirely against disposable temp fixture workspaces (never this
 * repo's actual packages/, except two real end-to-end reads at the bottom
 * that only read and assert), one fixture per shipped-file kind (README.md,
 * CHANGELOG.md prose, dist/*.js, dist/*.d.ts, and a third *.md kind that
 * proves the scan is not an allowlist of known kinds)
 * plus a negative control (a non-empty Unreleased section still carrying
 * pointer text is NOT a violation). Uses Node's built-in test runner. The
 * shipped-file set is always resolved through an injected `packFn` stub,
 * never a real `npm pack`, except in the two real end-to-end tests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CoverageInvariantError,
  isPublishable,
  readUnreleasedSectionState,
  isUnreleasedEffectivelyEmpty,
  runNpmPackDryRun,
  readLiteralFilesFieldEntries,
  loadPackedFileList,
  resolveShippedFiles,
  isExcludedShippedFile,
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
 * list, without shelling out. Every fixture list below includes
 * "package.json" and "README.md" so it satisfies the coverage invariant
 * (loadPackedFileList) unless a test is specifically about that invariant;
 * neither file needs to exist on disk for the invariant check itself
 * (resolveShippedFiles separately drops any reported path that isn't
 * actually a file on disk). */
function stubPackFn(relPaths) {
  return () => relPaths;
}

const BASE_SHIPPED = ['package.json', 'README.md'];

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

test('readUnreleasedSectionState: bracketless "## Unreleased" heading is recognized', () => {
  const s = readUnreleasedSectionState('# Changelog\n\n## Unreleased\n\n## 0.1.0, 2026-01-01\n');
  assert.deepEqual(s, { present: true, empty: true });
});

test('readUnreleasedSectionState: heading match is case-insensitive', () => {
  const s = readUnreleasedSectionState('# Changelog\n\n## unreleased\n\n## 0.1.0, 2026-01-01\n');
  assert.deepEqual(s, { present: true, empty: true });
});

test('readUnreleasedSectionState: a body with only ### sub-headings is empty', () => {
  const s = readUnreleasedSectionState(
    '# Changelog\n\n## [Unreleased]\n\n### Added\n\n### Changed\n\n## 0.1.0, 2026-01-01\n',
  );
  assert.deepEqual(s, { present: true, empty: true });
});

test('readUnreleasedSectionState: a body with only an HTML comment (incl. multi-line) is empty', () => {
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

// ── isUnreleasedEffectivelyEmpty ────────────────────────────────────────

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

// ── loadPackedFileList / coverage invariant ───────────────────────────

test('loadPackedFileList: negative control -- a valid pack result (package.json + README.md present) passes through unchanged', () => {
  const relPaths = loadPackedFileList({ name: '@x/pkg' }, '/root', stubPackFn(['package.json', 'README.md', 'dist/index.js']));
  assert.deepEqual(relPaths, ['package.json', 'README.md', 'dist/index.js']);
});

test('loadPackedFileList: throws CoverageInvariantError when the pack result is empty (vacuous-pass regression)', () => {
  assert.throws(
    () => loadPackedFileList({ name: '@x/pkg' }, '/root', stubPackFn([])),
    (err) => err instanceof CoverageInvariantError && /is empty/.test(err.message),
  );
});

test('loadPackedFileList: throws CoverageInvariantError when the pack result is missing package.json', () => {
  assert.throws(
    () => loadPackedFileList({ name: '@x/pkg' }, '/root', stubPackFn(['README.md'])),
    (err) => err instanceof CoverageInvariantError && /does not include package\.json/.test(err.message),
  );
});

test('loadPackedFileList: throws CoverageInvariantError when the pack result is missing README.md', () => {
  assert.throws(
    () => loadPackedFileList({ name: '@x/pkg' }, '/root', stubPackFn(['package.json'])),
    (err) => err instanceof CoverageInvariantError && /does not include README\.md/.test(err.message),
  );
});

test('loadPackedFileList: throws CoverageInvariantError when packFn throws', () => {
  const packFn = () => {
    throw new Error('npm pack exited 1');
  };
  assert.throws(
    () => loadPackedFileList({ name: '@x/pkg' }, '/root', packFn),
    (err) => err instanceof CoverageInvariantError && /threw \(npm pack exited 1\)/.test(err.message),
  );
});

test('loadPackedFileList: throws CoverageInvariantError when packFn returns unparsable output (not an array)', () => {
  const packFn = () => ({ not: 'an array' });
  assert.throws(
    () => loadPackedFileList({ name: '@x/pkg' }, '/root', packFn),
    (err) => err instanceof CoverageInvariantError && /unparsable output/.test(err.message),
  );
});

test('loadPackedFileList: error message never includes a stack trace (formatted, named error only)', () => {
  try {
    loadPackedFileList({ name: '@x/pkg' }, '/root', stubPackFn([]));
    assert.fail('expected loadPackedFileList to throw');
  } catch (err) {
    assert.equal(err instanceof CoverageInvariantError, true);
    assert.equal(/\n\s*at /.test(err.message), false, 'error message should not embed stack-trace-shaped text');
  }
});

test('loadPackedFileList: throws CoverageInvariantError when a literal package.json "files" entry (dist) is missing from the pack result (unbuilt package)', () => {
  const tmpRoot = tmp('files-field-unbuilt');
  try {
    const pkgDir = writePkg(tmpRoot, 'pkg', {
      'package.json': JSON.stringify({ name: '@x/pkg', files: ['dist', 'README.md'] }),
    });
    const pkg = { name: '@x/pkg', dir: pkgDir };
    // No dist/ was ever built, so the pack result cannot include it, even
    // though package.json declares it as a shipped entry.
    const packFn = stubPackFn(['package.json', 'README.md']);
    assert.throws(
      () => loadPackedFileList(pkg, tmpRoot, packFn),
      (err) =>
        err instanceof CoverageInvariantError
        && /does not include its package\.json "files" entry "dist"/.test(err.message)
        && /build the package/.test(err.message),
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('loadPackedFileList: passes when a literal "files" entry (dist) is present as a directory prefix in the pack result (built package)', () => {
  const tmpRoot = tmp('files-field-built');
  try {
    const pkgDir = writePkg(tmpRoot, 'pkg', {
      'package.json': JSON.stringify({ name: '@x/pkg', files: ['dist', 'README.md'] }),
    });
    const pkg = { name: '@x/pkg', dir: pkgDir };
    const packFn = stubPackFn(['package.json', 'README.md', 'dist/index.js', 'dist/index.d.ts']);
    const relPaths = loadPackedFileList(pkg, tmpRoot, packFn);
    assert.deepEqual(relPaths, ['package.json', 'README.md', 'dist/index.js', 'dist/index.d.ts']);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('loadPackedFileList: glob and negated "files" entries are not required as literal matches', () => {
  const tmpRoot = tmp('files-field-glob');
  try {
    const pkgDir = writePkg(tmpRoot, 'pkg', {
      'package.json': JSON.stringify({ name: '@x/pkg', files: ['dist/**/*.js', '!dist/**/*.test.js', 'README.md'] }),
    });
    const pkg = { name: '@x/pkg', dir: pkgDir };
    const packFn = stubPackFn(['package.json', 'README.md', 'dist/index.js']);
    // Neither the glob entry nor the negated entry is checked as a literal
    // path; only 'README.md' is, and it is present.
    assert.doesNotThrow(() => loadPackedFileList(pkg, tmpRoot, packFn));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('loadPackedFileList: no pkg.dir (older call sites) skips the files-field check entirely', () => {
  const relPaths = loadPackedFileList({ name: '@x/pkg' }, '/root', stubPackFn(['package.json', 'README.md']));
  assert.deepEqual(relPaths, ['package.json', 'README.md']);
});

test('readLiteralFilesFieldEntries: filters out globs and negations, keeps literal entries', () => {
  const tmpRoot = tmp('literal-entries');
  try {
    const pkgDir = writePkg(tmpRoot, 'pkg', {
      'package.json': JSON.stringify({
        name: '@x/pkg',
        files: ['dist', 'README.md', 'assets/*.png', '!dist/**/*.test.js', 'bin/cli.js'],
      }),
    });
    assert.deepEqual(readLiteralFilesFieldEntries({ dir: pkgDir }), ['dist', 'README.md', 'bin/cli.js']);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('loadPackedFileList: real built repo package still passes the files-field coverage check', () => {
  const rootDir = path.join(__dirname, '..');
  const pkgDir = path.join(rootDir, 'packages', 'grounding-mcp');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  if (!Array.isArray(pkgJson.files) || !fs.existsSync(path.join(pkgDir, 'dist'))) {
    console.log('skip: grounding-mcp is not built (no dist/) or declares no files field');
    return;
  }
  const relPaths = loadPackedFileList({ name: pkgJson.name, dir: pkgDir }, rootDir, runNpmPackDryRun);
  assert.ok(relPaths.includes('package.json'));
});

// ── resolveShippedFiles ─────────────────────────────────────────────────

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
    const packFn = stubPackFn([...BASE_SHIPPED, 'CHANGELOG.md', 'dist/index.js', 'dist/nested/x.d.ts']);
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
    const packFn = stubPackFn([...BASE_SHIPPED, 'dist/gone.js']);
    const shipped = resolveShippedFiles({ dir: pkgDir, name: '@x/pkg-a' }, tmpRoot, packFn);
    assert.deepEqual(shipped.map((p) => path.relative(pkgDir, p)), ['README.md']);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── isExcludedShippedFile (exclusion list, not an allowlist of kinds) ──

test('isExcludedShippedFile: package.json and LICENSE*/LICENCE* are excluded; everything else text-shaped is scanned', () => {
  const pkgDir = '/pkg';
  assert.equal(isExcludedShippedFile('/pkg/package.json'), true);
  assert.equal(isExcludedShippedFile('/pkg/LICENSE'), true);
  assert.equal(isExcludedShippedFile('/pkg/LICENSE.md'), true);
  assert.equal(isExcludedShippedFile('/pkg/LICENCE'), true);
  assert.equal(isExcludedShippedFile('/pkg/LICENSE.txt'), true);
  assert.equal(isExcludedShippedFile('/pkg/LICENSE-MIT'), true, 'a LICENSE-MIT style variant with no code extension is still a license file');
  assert.equal(
    isExcludedShippedFile(path.join(pkgDir, 'dist/license-policy.js')),
    false,
    'a real shipped script whose basename merely starts with the word license must still be scanned (LICENSE prefix regex was too broad)',
  );
  assert.equal(isExcludedShippedFile('/pkg/README.md'), false);
  assert.equal(isExcludedShippedFile('/pkg/CHANGELOG.md'), false);
  assert.equal(isExcludedShippedFile('/pkg/ROADMAP.md'), false, 'a third *.md kind must be scanned, not allowlisted away');
  assert.equal(isExcludedShippedFile('/pkg/docs/notes.md'), false);
  assert.equal(isExcludedShippedFile(path.join(pkgDir, 'dist/a.js')), false);
  assert.equal(isExcludedShippedFile(path.join(pkgDir, 'dist/a.d.ts')), false);
  assert.equal(isExcludedShippedFile(path.join(pkgDir, 'dist/a.mjs')), false);
  assert.equal(isExcludedShippedFile(path.join(pkgDir, 'dist/a.cjs')), false);
  assert.equal(isExcludedShippedFile(path.join(pkgDir, 'dist/a.d.mts')), false);
  assert.equal(isExcludedShippedFile(path.join(pkgDir, 'dist/a.d.cts')), false);
  assert.equal(
    isExcludedShippedFile(path.join(pkgDir, 'dist/a.js.map')),
    false,
    'a source map is text (JSON), not binary, and is now scanned under the widened rule',
  );
});

test('isExcludedShippedFile: the explicit binary-extension list (images, fonts, archives, .node, .wasm) is excluded', () => {
  const pkgDir = '/pkg';
  for (const ext of ['.png', '.jpg', '.gif', '.woff', '.woff2', '.ttf', '.zip', '.tgz', '.node', '.wasm']) {
    assert.equal(isExcludedShippedFile(path.join(pkgDir, `asset${ext}`)), true, `expected ${ext} excluded`);
  }
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

test('findPointerHit: keep-a-changelog link-reference line (a real URL) is not a hit', () => {
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

test('findPointerHit: a relative-path link-reference line is not a hit', () => {
  const tmpRoot = tmp('hit-linkref-relative');
  try {
    const p = path.join(tmpRoot, 'CHANGELOG.md');
    fs.writeFileSync(
      p,
      '# Changelog\n\n## [Unreleased]\n\n## 0.1.0, 2026-01-01\n\n[Unreleased]: ./compare/v0.1.0...HEAD\n',
    );
    assert.equal(findPointerHit(p), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('findPointerHit: CHANGELOG.md prose line shaped like a link reference but with NO url IS a hit (LINK_REF_RE tightened, finding: false negative)', () => {
  const tmpRoot = tmp('hit-linkref-nourl');
  try {
    const p = path.join(tmpRoot, 'CHANGELOG.md');
    fs.writeFileSync(
      p,
      '# Changelog\n\n## [Unreleased]\n\n## 0.1.0, 2026-01-01\n\n[Unreleased]: see the next release for what is coming.\n',
    );
    assert.equal(findPointerHit(p), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('findPointerHit: README.md prose line shaped like a link reference but with NO url IS a hit', () => {
  const tmpRoot = tmp('hit-readme-linkref-nourl');
  try {
    const p = path.join(tmpRoot, 'README.md');
    fs.writeFileSync(p, '[Unreleased]: see the next release for what is coming.\n');
    assert.equal(findPointerHit(p), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('findPointerHit: a non-CHANGELOG.md shipped file is not subject to the CHANGELOG-only heading/link-ref exclusions', () => {
  const tmpRoot = tmp('hit-nonchangelog-noexclusion');
  try {
    const p = path.join(tmpRoot, 'ROADMAP.md');
    fs.writeFileSync(p, '## [Unreleased]\n\nSee CHANGELOG.md [Unreleased] for the current status.\n');
    assert.equal(findPointerHit(p), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// The two tests above always have extra prose on top of the heading/link-ref
// line, so they still hit even if the CHANGELOG-only exclusions were
// mistakenly applied to every shipped file (the isChangelog scoping bug this
// check exists to avoid): the prose line alone still matches. These two
// fixtures isolate the exclusion-shaped line itself, with nothing else in
// the file, so a README whose ENTIRE content is a heading-only or
// link-ref-only line still has to register as a hit -- proving the
// CHANGELOG-only exclusions are actually scoped to CHANGELOG.md and are not
// silently stripping the same lines out of every shipped file.
test('findPointerHit: README.md whose ONLY content is the [Unreleased] heading line is still a hit (exclusion scoping)', () => {
  const tmpRoot = tmp('hit-readme-headingonly');
  try {
    const p = path.join(tmpRoot, 'README.md');
    fs.writeFileSync(p, '## [Unreleased]\n');
    assert.equal(findPointerHit(p), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('findPointerHit: README.md whose ONLY content is a keep-a-changelog link-reference line is still a hit (exclusion scoping)', () => {
  const tmpRoot = tmp('hit-readme-linkrefonly');
  try {
    const p = path.join(tmpRoot, 'README.md');
    fs.writeFileSync(p, '[Unreleased]: https://example.com/compare/v1...HEAD\n');
    assert.equal(findPointerHit(p), true);
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

test('findPointerHit: README.md bracketless capitalised word-bounded pointer is a hit', () => {
  const tmpRoot = tmp('hit-readme-bareword');
  try {
    const p = path.join(tmpRoot, 'README.md');
    fs.writeFileSync(p, 'See the Unreleased section of the CHANGELOG for upcoming notes.\n');
    assert.equal(findPointerHit(p), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('findPointerHit: README.md "(Unreleased)" parenthetical is a hit', () => {
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

test('findPointerHit: a shipped ROADMAP.md comment pointer is a hit (not an allowlist of kinds)', () => {
  const tmpRoot = tmp('hit-roadmap');
  try {
    const p = path.join(tmpRoot, 'ROADMAP.md');
    fs.writeFileSync(p, 'See CHANGELOG.md [Unreleased] for what ships next.\n');
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
    const packFn = stubPackFn([...BASE_SHIPPED, 'CHANGELOG.md']);
    const result = collectPackageViolations(pkg, tmpRoot, packFn);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].file, 'README.md');
    assert.equal(result.scannedCount, 2, 'README.md + CHANGELOG.md scanned (package.json excluded)');
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
    const packFn = stubPackFn([...BASE_SHIPPED, 'CHANGELOG.md']);
    const result = collectPackageViolations(pkg, tmpRoot, packFn);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].file, 'CHANGELOG.md');
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
    const packFn = stubPackFn([...BASE_SHIPPED, 'CHANGELOG.md', 'dist/index.js']);
    const result = collectPackageViolations(pkg, tmpRoot, packFn);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].file, path.join('dist', 'index.js'));
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
    const packFn = stubPackFn([...BASE_SHIPPED, 'CHANGELOG.md', 'dist/index.d.ts']);
    const result = collectPackageViolations(pkg, tmpRoot, packFn);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].file, path.join('dist', 'index.d.ts'));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('collectPackageViolations: shipped ROADMAP.md fixture, empty Unreleased -> violation (widened scan catches a fourth file kind with no code change)', () => {
  const tmpRoot = tmp('pkg-roadmap');
  try {
    const pkgDir = writePkg(tmpRoot, 'pkg', {
      'CHANGELOG.md': CHANGELOG_EMPTY,
      'ROADMAP.md': 'See CHANGELOG.md [Unreleased] for what ships next.\n',
    });
    const pkg = { name: '@x/pkg', dir: pkgDir };
    const packFn = stubPackFn([...BASE_SHIPPED, 'CHANGELOG.md', 'ROADMAP.md']);
    const result = collectPackageViolations(pkg, tmpRoot, packFn);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].file, 'ROADMAP.md');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('collectPackageViolations: shipped dist/license-policy.js with a pointer -> violation (LICENSE-prefix exclusion must not swallow real scripts)', () => {
  const tmpRoot = tmp('pkg-license-script');
  try {
    const pkgDir = writePkg(tmpRoot, 'pkg', {
      'CHANGELOG.md': CHANGELOG_EMPTY,
      'dist/license-policy.js': '// see CHANGELOG.md [Unreleased] for the current policy notes\n',
    });
    const pkg = { name: '@x/pkg', dir: pkgDir };
    const packFn = stubPackFn([...BASE_SHIPPED, 'CHANGELOG.md', 'dist/license-policy.js']);
    const result = collectPackageViolations(pkg, tmpRoot, packFn);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].file, 'dist/license-policy.js');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('collectPackageViolations: shipped LICENSE and LICENSE.md are excluded from the scan even with pointer text', () => {
  const tmpRoot = tmp('pkg-license-excluded');
  try {
    const pkgDir = writePkg(tmpRoot, 'pkg', {
      'CHANGELOG.md': CHANGELOG_EMPTY,
      LICENSE: 'MIT, see CHANGELOG.md [Unreleased] for details.\n',
      'LICENSE.md': 'MIT, see CHANGELOG.md [Unreleased] for details.\n',
    });
    const pkg = { name: '@x/pkg', dir: pkgDir };
    const packFn = stubPackFn([...BASE_SHIPPED, 'CHANGELOG.md', 'LICENSE', 'LICENSE.md']);
    const result = collectPackageViolations(pkg, tmpRoot, packFn);
    assert.equal(result.violations.length, 0);
    assert.equal(
      result.scannedCount,
      1,
      'only CHANGELOG.md itself is scanned (its own heading is stripped); LICENSE and LICENSE.md are excluded and never counted',
    );
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
    const packFn = stubPackFn([...BASE_SHIPPED, 'CHANGELOG.md']);
    const result = collectPackageViolations(pkg, tmpRoot, packFn);
    assert.deepEqual(result.violations, []);
    assert.equal(result.scannedCount, 0, 'a clean/skipped package never resolves or scans its shipped files');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('collectPackageViolations: no [Unreleased] heading at all + a shipped pointer -> violation (treated like empty, not skipped)', () => {
  const tmpRoot = tmp('pkg-noheading');
  try {
    const pkgDir = writePkg(tmpRoot, 'pkg', {
      'CHANGELOG.md': '# Changelog\n\n## 0.1.0, 2026-01-01\n\nfirst release\n',
      'README.md': 'See the Unreleased section for what is next.\n',
    });
    const pkg = { name: '@x/pkg', dir: pkgDir };
    const packFn = stubPackFn([...BASE_SHIPPED, 'CHANGELOG.md']);
    const result = collectPackageViolations(pkg, tmpRoot, packFn);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].file, 'README.md');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('collectPackageViolations: no CHANGELOG.md at all + a shipped pointer -> violation', () => {
  const tmpRoot = tmp('pkg-nochangelog');
  try {
    const pkgDir = writePkg(tmpRoot, 'pkg', {
      'README.md': 'See CHANGELOG.md [Unreleased] for what is next.\n',
    });
    const pkg = { name: '@x/pkg', dir: pkgDir };
    const packFn = stubPackFn(BASE_SHIPPED);
    const result = collectPackageViolations(pkg, tmpRoot, packFn);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].file, 'README.md');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('collectPackageViolations: Unreleased body with only ### stubs + a shipped pointer -> violation', () => {
  const tmpRoot = tmp('pkg-stubs');
  try {
    const pkgDir = writePkg(tmpRoot, 'pkg', {
      'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n### Added\n\n### Changed\n\n## 0.1.0, 2026-01-01\n\nfirst release\n',
      'README.md': 'See CHANGELOG.md [Unreleased] for what is next.\n',
    });
    const pkg = { name: '@x/pkg', dir: pkgDir };
    const packFn = stubPackFn([...BASE_SHIPPED, 'CHANGELOG.md']);
    const result = collectPackageViolations(pkg, tmpRoot, packFn);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].file, 'README.md');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('collectPackageViolations: propagates CoverageInvariantError for a package that needs scanning but has an untrustworthy pack listing', () => {
  const tmpRoot = tmp('pkg-invariant');
  try {
    const pkgDir = writePkg(tmpRoot, 'pkg', { 'CHANGELOG.md': CHANGELOG_EMPTY });
    const pkg = { name: '@x/pkg', dir: pkgDir };
    assert.throws(
      () => collectPackageViolations(pkg, tmpRoot, stubPackFn([])),
      (err) => err instanceof CoverageInvariantError,
    );
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
    const packFn = stubPackFn([...BASE_SHIPPED, 'CHANGELOG.md']);
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

test('run: coverage invariant violation (empty pack result) fails the whole check with a named, non-stack-trace error', () => {
  const tmpRoot = tmp('run-invariant');
  try {
    writePkg(tmpRoot, 'pkg', { 'CHANGELOG.md': CHANGELOG_EMPTY, 'README.md': 'fine' });
    fs.writeFileSync(
      path.join(tmpRoot, 'packages', 'pkg', 'package.json'),
      JSON.stringify({ name: '@x/pkg', private: false }),
    );
    assert.equal(run(tmpRoot, stubPackFn([])), 1);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run: a private package with a shipped pointer next to a scanned, clean public package exits 0, and packFn is never called for the private package (asserts the run()-level private filter, not just isPublishable in isolation)', () => {
  const tmpRoot = tmp('run-private');
  try {
    writePkg(tmpRoot, 'priv', {
      'CHANGELOG.md': CHANGELOG_EMPTY,
      'README.md': 'See CHANGELOG.md [Unreleased] for what is next.\n',
    });
    fs.writeFileSync(
      path.join(tmpRoot, 'packages', 'priv', 'package.json'),
      JSON.stringify({ name: '@x/priv', private: true }),
    );
    writePkg(tmpRoot, 'pub', {
      'CHANGELOG.md': CHANGELOG_EMPTY,
      'README.md': 'Nothing dangling here.\n',
    });
    fs.writeFileSync(
      path.join(tmpRoot, 'packages', 'pub', 'package.json'),
      JSON.stringify({ name: '@x/pub', private: false }),
    );

    const calledWith = [];
    const packFn = (pkgName) => {
      calledWith.push(pkgName);
      if (pkgName === '@x/priv') throw new Error('packFn must never be called for a private package');
      return [...BASE_SHIPPED, 'CHANGELOG.md'];
    };

    assert.equal(run(tmpRoot, packFn), 0);
    assert.equal(calledWith.includes('@x/priv'), false, 'packFn must not be called for the private package');
    assert.equal(calledWith.includes('@x/pub'), true, 'packFn must be called for the scanned public package');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run: success line reports "<pkg>: N file(s) scanned" with the expected N, omits a package that needed no scanning, and omits the private package', () => {
  const tmpRoot = tmp('run-success-line');
  try {
    // A private package: filtered out before the loop entirely, must never
    // appear in the summary.
    writePkg(tmpRoot, 'priv', {
      'CHANGELOG.md': CHANGELOG_EMPTY,
      'README.md': 'See CHANGELOG.md [Unreleased] for what is next.\n',
    });
    fs.writeFileSync(
      path.join(tmpRoot, 'packages', 'priv', 'package.json'),
      JSON.stringify({ name: '@x/priv', private: true }),
    );
    // A publishable package whose Unreleased section already has content:
    // scannedCount stays 0 (never even resolves a pack listing), so the
    // un-mutated code never pushes it into scannedCounts.
    writePkg(tmpRoot, 'clean', { 'CHANGELOG.md': CHANGELOG_NONEMPTY });
    fs.writeFileSync(
      path.join(tmpRoot, 'packages', 'clean', 'package.json'),
      JSON.stringify({ name: '@x/clean', private: false }),
    );
    // A publishable package that actually gets scanned: 3 shipped files
    // (README.md, CHANGELOG.md, ROADMAP.md; package.json is excluded).
    writePkg(tmpRoot, 'pub', {
      'CHANGELOG.md': CHANGELOG_EMPTY,
      'README.md': 'Nothing dangling here.\n',
      'ROADMAP.md': 'Nothing dangling here either.\n',
    });
    fs.writeFileSync(
      path.join(tmpRoot, 'packages', 'pub', 'package.json'),
      JSON.stringify({ name: '@x/pub', private: false }),
    );

    const packFn = (pkgName) => {
      if (pkgName === '@x/clean') {
        throw new Error('packFn must never be called for a package whose Unreleased section already has content');
      }
      return [...BASE_SHIPPED, 'CHANGELOG.md', 'ROADMAP.md'];
    };

    const originalLog = console.log;
    const logged = [];
    console.log = (msg) => logged.push(msg);
    let exitCode;
    try {
      exitCode = run(tmpRoot, packFn);
    } finally {
      console.log = originalLog;
    }

    assert.equal(exitCode, 0);
    assert.equal(logged.length, 1, 'exactly one summary line is printed on success');
    assert.match(logged[0], /@x\/pub: 3 file\(s\) scanned/);
    assert.doesNotMatch(logged[0], /@x\/priv/, 'the private package must never appear in the summary');
    assert.doesNotMatch(
      logged[0],
      /0 file\(s\) scanned/,
      'a package that needed no scanning (scannedCount 0) must not be listed at all',
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test(
  'run: real repo sanity check (asserts exit 0 against the actual packages/ tree)',
  { timeout: 120000 },
  () => {
    const rootDir = path.join(__dirname, '..');
    assert.equal(run(rootDir), 0);
  },
);

test(
  'runNpmPackDryRun: real npm pack for @lannguyensi/grounding-mcp includes README.md and at least one dist/ entry (skips with a clear message if dist/ is absent -- CI builds before this check runs)',
  { timeout: 60000 },
  () => {
    const rootDir = path.join(__dirname, '..');
    const distDir = path.join(rootDir, 'packages', 'grounding-mcp', 'dist');
    if (!fs.existsSync(distDir) || fs.readdirSync(distDir).length === 0) {
      console.log(
        'SKIP: packages/grounding-mcp/dist is absent or empty; run `npm run build` first (CI builds before this check runs).',
      );
      return;
    }
    const relPaths = runNpmPackDryRun('@lannguyensi/grounding-mcp', rootDir);
    assert.ok(relPaths.includes('README.md'), 'expected README.md in the real packed file list');
    assert.ok(
      relPaths.some((p) => p.startsWith('dist/')),
      'expected at least one dist/ entry in the real packed file list',
    );
  },
);
