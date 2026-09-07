/**
 * Unit tests for check-grounding-mcp-pack.js.
 *
 * `evaluateVersionMatch` and `corruptInstalledPackage`'s unknown-mode branch
 * are pure/in-memory and run against synthetic values only (including the
 * required negative control: a stub wrong-version pair, proving the
 * comparison actually discriminates rather than always passing).
 * `readTarballVersion` is exercised against small disposable fixture
 * tarballs built with `tar` in a temp dir (a real tarball shape, not this
 * repo's own package). The end-to-end `run()` tests are the real coverage
 * for the manual verification this check replaces: they pack, install, and
 * execute the ACTUAL `packages/grounding-mcp` workspace package (requires
 * `dist/` already built, same precondition the CI "Build" step guarantees
 * before this check's own step runs) — a happy-path pass, and the
 * negative-control corruption path failing red with a named message.
 * Uses Node's built-in test runner (`node --test`), matching this repo's
 * other scripts/*.test.js files. The two `run()` end-to-end tests each do
 * one real `npm pack` + one real `npm install`, so they are slower than
 * this repo's other checker unit tests but stay within "one pack, one
 * install" per test, matching the checker's own runtime budget.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  readTarballVersion,
  installedPackageJsonPath,
  corruptInstalledPackage,
  evaluateVersionMatch,
  run,
} = require('./check-grounding-mcp-pack');

const REPO_ROOT = path.join(__dirname, '..');
const DIST_ENTRY = path.join(REPO_ROOT, 'packages', 'grounding-mcp', 'dist', 'server.js');

// ── evaluateVersionMatch (pure) ─────────────────────────────────────────────

test('evaluateVersionMatch: matching versions is ok', () => {
  const result = evaluateVersionMatch('0.11.0', '0.11.0', '/tmp/consumer');
  assert.equal(result.ok, true);
  assert.match(result.message, /0\.11\.0/);
});

test('evaluateVersionMatch: negative control -- a wrong-version stub is NOT ok (the comparison discriminates)', () => {
  // Regression guard for "always passes" / "compares against the repo's
  // version instead of the tarball's" mutants: feeding a reported version
  // that does not match the expected (tarball) version must fail, and the
  // message must name BOTH values plus the consumer path so a real CI
  // failure is self-explanatory.
  const result = evaluateVersionMatch('0.10.0', '0.11.0', '/tmp/scratch-consumer-xyz');
  assert.equal(result.ok, false);
  assert.match(result.message, /0\.10\.0/);
  assert.match(result.message, /0\.11\.0/);
  assert.match(result.message, /\/tmp\/scratch-consumer-xyz/);
});

test('evaluateVersionMatch: the reported value alone (e.g. the server.ts ENOENT fallback "0.0.0") never reads as ok', () => {
  const result = evaluateVersionMatch('0.0.0', '0.11.0', '/tmp/consumer');
  assert.equal(result.ok, false);
});

// ── corruptInstalledPackage ──────────────────────────────────────────────

test('corruptInstalledPackage: null/undefined mode is a no-op', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-check-corrupt-noop-'));
  try {
    assert.doesNotThrow(() => corruptInstalledPackage(tmpRoot, null));
    assert.doesNotThrow(() => corruptInstalledPackage(tmpRoot, undefined));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('corruptInstalledPackage: "remove-package-json" deletes the installed package.json', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-check-corrupt-remove-'));
  try {
    const pkgJsonPath = installedPackageJsonPath(tmpRoot);
    fs.mkdirSync(path.dirname(pkgJsonPath), { recursive: true });
    fs.writeFileSync(pkgJsonPath, '{"version":"0.11.0"}\n');
    assert.equal(fs.existsSync(pkgJsonPath), true);
    corruptInstalledPackage(tmpRoot, 'remove-package-json');
    assert.equal(fs.existsSync(pkgJsonPath), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('corruptInstalledPackage: "remove-package-json" on an already-missing file is a no-op, not a throw', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-check-corrupt-remove-missing-'));
  try {
    assert.doesNotThrow(() => corruptInstalledPackage(tmpRoot, 'remove-package-json'));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('corruptInstalledPackage: negative control -- an unknown mode throws rather than silently doing nothing', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-check-corrupt-unknown-'));
  try {
    assert.throws(() => corruptInstalledPackage(tmpRoot, 'not-a-real-mode'), /unknown corrupt mode/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── readTarballVersion (fixture tarballs, no real npm pack) ─────────────────

function makeFixtureTarball(tmpRoot, pkgJsonContent) {
  const stageDir = path.join(tmpRoot, 'stage', 'package');
  fs.mkdirSync(stageDir, { recursive: true });
  fs.writeFileSync(path.join(stageDir, 'package.json'), pkgJsonContent);
  const tgzPath = path.join(tmpRoot, 'fixture.tgz');
  execFileSync('tar', ['-czf', tgzPath, '-C', path.join(tmpRoot, 'stage'), 'package']);
  return tgzPath;
}

test('readTarballVersion: reads the version out of a real fixture tarball', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-check-tarball-version-'));
  try {
    const tgzPath = makeFixtureTarball(tmpRoot, JSON.stringify({ name: 'fixture-pkg', version: '9.9.9' }));
    assert.equal(readTarballVersion(tgzPath), '9.9.9');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('readTarballVersion: negative control -- a tarball whose package.json has no version field throws', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-check-tarball-noversion-'));
  try {
    const tgzPath = makeFixtureTarball(tmpRoot, JSON.stringify({ name: 'fixture-pkg' }));
    assert.throws(() => readTarballVersion(tgzPath), /no non-empty string "version"/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('readTarballVersion: negative control -- an unparseable package.json entry throws', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-check-tarball-badjson-'));
  try {
    const tgzPath = makeFixtureTarball(tmpRoot, 'not valid json {{{');
    assert.throws(() => readTarballVersion(tgzPath), /unparseable/);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── run() end-to-end (real packages/grounding-mcp workspace package) ───────
// Requires packages/grounding-mcp/dist to already be built (the CI step
// this check runs as places it after "Build"; a local run needs `npm run
// build` first, same as any other test here that reads dist/ output).

test('run(): the real grounding-mcp package packs, installs, and reports a matching --version (happy path)', { skip: fs.existsSync(DIST_ENTRY) ? false : 'packages/grounding-mcp/dist not built -- run `npm run build` first' }, () => {
  assert.equal(run({ rootDir: REPO_ROOT }), 0);
});

test('run(): negative control -- removing the installed package.json fails red with a named message', { skip: fs.existsSync(DIST_ENTRY) ? false : 'packages/grounding-mcp/dist not built -- run `npm run build` first' }, () => {
  // Captures the checker's own stderr so the test can assert on the named
  // failure message (both the "0.0.0" fallback value and the real
  // tarball version must appear), not just the exit code.
  const originalError = console.error;
  const lines = [];
  console.error = (...args) => {
    lines.push(args.join(' '));
  };
  let code;
  try {
    code = run({ rootDir: REPO_ROOT, corrupt: 'remove-package-json' });
  } finally {
    console.error = originalError;
  }
  assert.equal(code, 1);
  const combined = lines.join('\n');
  assert.match(combined, /"0\.0\.0"/);
  assert.match(combined, /grounding-mcp pack check failed/);
});
