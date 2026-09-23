/**
 * Unit tests for check-grounding-mcp-pack-shape.js.
 *
 * `evaluatePackShape` / `isTestFilePath` are exercised against in-memory
 * path lists. `run()` is exercised with an injected `packFn` stub for the
 * seeded-defect probe (never a real `npm pack`), plus one real end-to-end
 * test against the actual grounding-mcp workspace package's real
 * `npm pack --dry-run --json` output at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  REQUIRED_ENTRIES,
  isTestFilePath,
  evaluatePackShape,
  run,
} = require('./check-grounding-mcp-pack-shape');

// ── isTestFilePath ───────────────────────────────────────────────────────

test('isTestFilePath: .test. and .spec. basenames', () => {
  assert.equal(isTestFilePath('dist/foo.test.js'), true);
  assert.equal(isTestFilePath('dist/foo.spec.js'), true);
});

test('isTestFilePath: under a test/ or tests/ directory', () => {
  assert.equal(isTestFilePath('test/fixtures/a.js'), true);
  assert.equal(isTestFilePath('dist/tests/a.js'), true);
});

test('isTestFilePath: negative control -- an ordinary dist file is not a test file', () => {
  assert.equal(isTestFilePath('dist/server.js'), false);
  assert.equal(isTestFilePath('dist/latest.js'), false); // contains "test" as a substring, not a segment/suffix
});

// ── evaluatePackShape ────────────────────────────────────────────────────

test('evaluatePackShape: clean shape passes', () => {
  const result = evaluatePackShape(['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE', 'dist/server.js']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
});

test('evaluatePackShape: missing a required entry', () => {
  const result = evaluatePackShape(['package.json', 'dist/server.js']);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.includes('README.md')));
  assert.ok(result.violations.some((v) => v.includes('CHANGELOG.md')));
});

test('evaluatePackShape: seeded defect -- src/ entry present (the mutation probe this AC names)', () => {
  const clean = evaluatePackShape(['package.json', 'README.md', 'CHANGELOG.md', 'dist/server.js']);
  assert.equal(clean.ok, true, 'sanity: clean list passes first');

  const withSrc = evaluatePackShape([
    'package.json',
    'README.md',
    'CHANGELOG.md',
    'dist/server.js',
    'src/server.ts',
  ]);
  assert.equal(withSrc.ok, false);
  assert.ok(withSrc.violations.some((v) => v.includes('src/server.ts')));
});

test('evaluatePackShape: a shipped test file is a violation', () => {
  const result = evaluatePackShape(['package.json', 'README.md', 'CHANGELOG.md', 'dist/server.test.js']);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.includes('dist/server.test.js')));
});

assert.deepEqual(REQUIRED_ENTRIES, ['package.json', 'README.md', 'CHANGELOG.md']);

// ── run() with an injected packFn (the seeded-defect / clean red-green probe) ──

test('run: green with a clean stubbed pack result', () => {
  const packFn = () => ({ files: [{ path: 'package.json' }, { path: 'README.md' }, { path: 'CHANGELOG.md' }, { path: 'dist/server.js' }] });
  assert.equal(run('/does/not/matter', packFn), 0);
});

test('run: red once "src" is added to the packed file list (mutation probe: adding src to files)', () => {
  const packFn = () => ({
    files: [
      { path: 'package.json' },
      { path: 'README.md' },
      { path: 'CHANGELOG.md' },
      { path: 'dist/server.js' },
      { path: 'src/server.ts' },
    ],
  });
  assert.equal(run('/does/not/matter', packFn), 1);
});

test('run: red when npm pack --dry-run reports zero files', () => {
  const packFn = () => ({ files: [] });
  assert.equal(run('/does/not/matter', packFn), 1);
});

test('run: red when packFn throws', () => {
  const packFn = () => {
    throw new Error('npm pack failed');
  };
  assert.equal(run('/does/not/matter', packFn), 1);
});

test('run: real repo end-to-end -- actual grounding-mcp npm pack --dry-run ships a clean shape', { timeout: 60000 }, () => {
  const rootDir = path.join(__dirname, '..');
  assert.equal(run(rootDir), 0);
});
