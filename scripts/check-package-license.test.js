/**
 * Unit tests for the pure checkers in check-package-license.js.
 *
 * `collectMissingOrDivergedLicenseViolations` / `collectFilesFieldViolations`
 * run against in-memory fixture workspace arrays plus disposable temp
 * directories for the filesystem-reading half. `collectPackEntryViolations`
 * uses an injected `packFn` stub throughout: no real `npm pack` shells out
 * during these tests, mirroring `installTarballs`/`runVersionCommand`'s
 * argv-stub pattern in check-grounding-mcp-pack.test.js. `run()`'s own real
 * end-to-end test at the bottom exercises the actual repo state (real
 * packages/, real LICENSE files this task adds, real `npm pack --dry-run`),
 * which is the coverage that actually proves this task's change shipped.
 *
 * Uses Node's built-in test runner (`node --test`), matching this repo's
 * other scripts/*.test.js files.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadWorkspacePackages,
  isPublishable,
  collectMissingOrDivergedLicenseViolations,
  collectFilesFieldViolations,
  collectPackEntryViolations,
  run,
} = require('./check-package-license');

const MIT_TEXT = 'MIT License\n\nCopyright (c) 2026 Test\n';

function writeWorkspacePackage(tmpRoot, dirName, pkg) {
  const pkgDir = path.join(tmpRoot, 'packages', dirName);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkg));
  return pkgDir;
}

// ── isPublishable ────────────────────────────────────────────────────────

test('isPublishable: private !== true is publishable', () => {
  assert.equal(isPublishable({ private: false }), true);
  assert.equal(isPublishable({ private: undefined }), true);
});

test('isPublishable: negative control: private: true is not publishable', () => {
  assert.equal(isPublishable({ private: true }), false);
});

// ── loadWorkspacePackages ───────────────────────────────────────────────

test('loadWorkspacePackages: finds real package.json files alongside non-package dirs', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-license-mixed-'));
  try {
    fs.mkdirSync(path.join(tmpRoot, 'packages', 'not-a-package'), { recursive: true });
    writeWorkspacePackage(tmpRoot, 'real-pkg', { name: '@lannguyensi/real-pkg', private: false, files: ['dist'] });

    const workspaces = loadWorkspacePackages(tmpRoot);
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0].name, '@lannguyensi/real-pkg');
    assert.deepEqual(workspaces[0].files, ['dist']);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('loadWorkspacePackages: a package.json with no "files" field reads files as null (not checked by the files guard)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-license-nofiles-'));
  try {
    writeWorkspacePackage(tmpRoot, 'pkg-a', { name: '@lannguyensi/pkg-a', private: false });
    const workspaces = loadWorkspacePackages(tmpRoot);
    assert.equal(workspaces[0].files, null);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── collectMissingOrDivergedLicenseViolations ───────────────────────────

test('license file guard: passes when every publishable package carries a byte-identical LICENSE', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-license-present-'));
  try {
    const dir = writeWorkspacePackage(tmpRoot, 'pkg-a', { name: '@lannguyensi/pkg-a', private: false });
    fs.writeFileSync(path.join(dir, 'LICENSE'), MIT_TEXT);
    const workspaces = loadWorkspacePackages(tmpRoot);
    const violations = collectMissingOrDivergedLicenseViolations(workspaces, Buffer.from(MIT_TEXT));
    assert.deepEqual(violations, []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('license file guard: negative control: a missing LICENSE file is flagged', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-license-missing-'));
  try {
    writeWorkspacePackage(tmpRoot, 'pkg-a', { name: '@lannguyensi/pkg-a', private: false });
    const workspaces = loadWorkspacePackages(tmpRoot);
    const violations = collectMissingOrDivergedLicenseViolations(workspaces, Buffer.from(MIT_TEXT));
    assert.deepEqual(violations, [{ reason: 'license-missing', consumer: '@lannguyensi/pkg-a' }]);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('license file guard: negative control: a diverged (byte-different) LICENSE file is flagged, not treated as present', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-license-diverged-'));
  try {
    const dir = writeWorkspacePackage(tmpRoot, 'pkg-a', { name: '@lannguyensi/pkg-a', private: false });
    fs.writeFileSync(path.join(dir, 'LICENSE'), MIT_TEXT.replace('2026', '2020'));
    const workspaces = loadWorkspacePackages(tmpRoot);
    const violations = collectMissingOrDivergedLicenseViolations(workspaces, Buffer.from(MIT_TEXT));
    assert.deepEqual(violations, [{ reason: 'license-diverged', consumer: '@lannguyensi/pkg-a' }]);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('license file guard: a private package with no LICENSE is not flagged (private is out of scope)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-license-private-'));
  try {
    writeWorkspacePackage(tmpRoot, 'pkg-a', { name: '@lannguyensi/pkg-a', private: true });
    const workspaces = loadWorkspacePackages(tmpRoot);
    const violations = collectMissingOrDivergedLicenseViolations(workspaces, Buffer.from(MIT_TEXT));
    assert.deepEqual(violations, []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── collectFilesFieldViolations ─────────────────────────────────────────

test('files-field guard: passes when "files" includes "LICENSE"', () => {
  const workspaces = [{ name: '@lannguyensi/pkg-a', private: false, files: ['dist', 'README.md', 'LICENSE'] }];
  assert.deepEqual(collectFilesFieldViolations(workspaces), []);
});

test('files-field guard: negative control: "files" set but missing "LICENSE" is flagged', () => {
  const workspaces = [{ name: '@lannguyensi/pkg-a', private: false, files: ['dist', 'README.md'] }];
  const violations = collectFilesFieldViolations(workspaces);
  assert.deepEqual(violations, [{ reason: 'files-field-missing-license', consumer: '@lannguyensi/pkg-a' }]);
});

test('files-field guard: a package with no "files" field at all is not checked (files: null skip)', () => {
  const workspaces = [{ name: '@lannguyensi/pkg-a', private: false, files: null }];
  assert.deepEqual(collectFilesFieldViolations(workspaces), []);
});

test('files-field guard: a private package with "files" missing LICENSE is not flagged', () => {
  const workspaces = [{ name: '@lannguyensi/pkg-a', private: true, files: ['dist'] }];
  assert.deepEqual(collectFilesFieldViolations(workspaces), []);
});

// ── collectPackEntryViolations (stubbed packFn, no real npm pack) ───────

test('pack-entry guard: passes when the stubbed pack result lists a LICENSE entry', () => {
  const workspaces = [{ name: '@lannguyensi/pkg-a', private: false }];
  const packFn = () => ({ files: [{ path: 'LICENSE' }, { path: 'dist/index.js' }] });
  assert.deepEqual(collectPackEntryViolations(workspaces, '/fake/root', packFn), []);
});

test('pack-entry guard: negative control: a pack result with no LICENSE entry is flagged (the exact class this check exists to catch)', () => {
  const workspaces = [{ name: '@lannguyensi/pkg-a', private: false }];
  const packFn = () => ({ files: [{ path: 'README.md' }, { path: 'dist/index.js' }] });
  const violations = collectPackEntryViolations(workspaces, '/fake/root', packFn);
  assert.deepEqual(violations, [{ reason: 'pack-entry-missing-license', consumer: '@lannguyensi/pkg-a' }]);
});

test('pack-entry guard: is called once per publishable package, with the package name and rootDir', () => {
  const workspaces = [
    { name: '@lannguyensi/pkg-a', private: false },
    { name: '@lannguyensi/pkg-b', private: true },
    { name: '@lannguyensi/pkg-c', private: false },
  ];
  const calls = [];
  const packFn = (name, rootDir) => {
    calls.push([name, rootDir]);
    return { files: [{ path: 'LICENSE' }] };
  };
  collectPackEntryViolations(workspaces, '/fake/root', packFn);
  assert.deepEqual(calls, [
    ['@lannguyensi/pkg-a', '/fake/root'],
    ['@lannguyensi/pkg-c', '/fake/root'],
  ]);
});

test('pack-entry guard: a pack result with no "files" array at all does not crash and is flagged', () => {
  const workspaces = [{ name: '@lannguyensi/pkg-a', private: false }];
  const packFn = () => ({});
  const violations = collectPackEntryViolations(workspaces, '/fake/root', packFn);
  assert.deepEqual(violations, [{ reason: 'pack-entry-missing-license', consumer: '@lannguyensi/pkg-a' }]);
});

// ── run(rootDir) (CLI core, exit code) ───────────────────────────────────

function writeRootLicense(tmpRoot, content = MIT_TEXT) {
  fs.writeFileSync(path.join(tmpRoot, 'LICENSE'), content);
}

test('run(): zero publishable workspace packages exits 1 via the zero-workspace guard specifically', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-license-run-empty-'));
  const originalError = console.error;
  const errorMessages = [];
  console.error = (...args) => errorMessages.push(args.join(' '));
  try {
    fs.mkdirSync(path.join(tmpRoot, 'packages'));
    writeWorkspacePackage(tmpRoot, 'pkg-a', { name: '@lannguyensi/pkg-a', private: true });
    writeRootLicense(tmpRoot);

    const exitCode = run(tmpRoot, () => ({ files: [{ path: 'LICENSE' }] }));
    assert.equal(exitCode, 1);
    assert.ok(
      errorMessages.some((m) => m.includes('found 0 publishable')),
      `expected the zero-workspace guard's message, got: ${JSON.stringify(errorMessages)}`,
    );
  } finally {
    console.error = originalError;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): a missing root LICENSE exits 1 without crashing', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-license-run-noroot-'));
  const originalError = console.error;
  console.error = () => {};
  try {
    writeWorkspacePackage(tmpRoot, 'pkg-a', { name: '@lannguyensi/pkg-a', private: false });
    const exitCode = run(tmpRoot, () => ({ files: [{ path: 'LICENSE' }] }));
    assert.equal(exitCode, 1);
  } finally {
    console.error = originalError;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): a clean tree (LICENSE present + identical, files includes LICENSE, pack lists LICENSE) exits 0', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-license-run-clean-'));
  try {
    const dir = writeWorkspacePackage(tmpRoot, 'pkg-a', {
      name: '@lannguyensi/pkg-a',
      private: false,
      files: ['dist', 'LICENSE'],
    });
    fs.writeFileSync(path.join(dir, 'LICENSE'), MIT_TEXT);
    writeRootLicense(tmpRoot);

    const exitCode = run(tmpRoot, () => ({ files: [{ path: 'LICENSE' }, { path: 'dist/index.js' }] }));
    assert.equal(exitCode, 0);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): negative control: a pack result missing LICENSE fails the whole run even when the on-disk file is fine', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-license-run-packmiss-'));
  const originalError = console.error;
  console.error = () => {};
  try {
    const dir = writeWorkspacePackage(tmpRoot, 'pkg-a', {
      name: '@lannguyensi/pkg-a',
      private: false,
      files: ['dist', 'LICENSE'],
    });
    fs.writeFileSync(path.join(dir, 'LICENSE'), MIT_TEXT);
    writeRootLicense(tmpRoot);

    const exitCode = run(tmpRoot, () => ({ files: [{ path: 'dist/index.js' }] }));
    assert.equal(exitCode, 1);
  } finally {
    console.error = originalError;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── run(): missing packages/, and a throwing packFn ──────────────────────

test('run(): a temp root with no packages/ directory exits 1 with a readable message, not an uncaught exception', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-license-run-nopackages-'));
  const originalError = console.error;
  const errorMessages = [];
  console.error = (...args) => errorMessages.push(args.join(' '));
  try {
    // Deliberately no packages/ directory under tmpRoot at all.
    let exitCode;
    assert.doesNotThrow(() => {
      exitCode = run(tmpRoot, () => ({ files: [{ path: 'LICENSE' }] }));
    });
    assert.equal(exitCode, 1);
    assert.ok(
      errorMessages.some((m) => m.includes('packages/') && m.includes(tmpRoot)),
      `expected a readable packages/-read-failure message naming ${tmpRoot}, got: ${JSON.stringify(errorMessages)}`,
    );
  } finally {
    console.error = originalError;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('run(): a throwing packFn (e.g. a real npm-side error against a non-workspace directory) exits 1, no uncaught exception', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-license-run-packthrows-'));
  const originalError = console.error;
  const errorMessages = [];
  console.error = (...args) => errorMessages.push(args.join(' '));
  try {
    const dir = writeWorkspacePackage(tmpRoot, 'pkg-a', {
      name: '@lannguyensi/pkg-a',
      private: false,
      files: ['dist', 'LICENSE'],
    });
    fs.writeFileSync(path.join(dir, 'LICENSE'), MIT_TEXT);
    writeRootLicense(tmpRoot);

    const throwingPackFn = () => {
      throw new Error('npm ENOWORKSPACES simulated: not a workspace root');
    };
    let exitCode;
    assert.doesNotThrow(() => {
      exitCode = run(tmpRoot, throwingPackFn);
    });
    assert.equal(exitCode, 1);
    assert.ok(
      errorMessages.some((m) => m.includes('npm pack') && m.includes('ENOWORKSPACES simulated')),
      `expected the packFn error to be reported, got: ${JSON.stringify(errorMessages)}`,
    );
  } finally {
    console.error = originalError;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── root manifest: the workspace glob this script hardcodes ─────────────

test('the repository root package.json declares exactly the "packages/*" workspace glob this script hardcodes', () => {
  // scripts/check-package-license.js (like check-pins.js and check-deps.js)
  // reads packages/ directly instead of the root "workspaces" field. That is
  // only safe while the root manifest declares nothing else; this test turns
  // red when a second glob is added, so the script gets widened instead of
  // silently skipping the new workspace root.
  const rootPkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  // The reverse direction (the script's hardcoded directory renamed away from
  // packages/) is covered by the real-repo end-to-end test above.
  assert.deepStrictEqual(rootPkg.workspaces, ['packages/*']);
});

// ── loadWorkspacePackages: discovery against a synthetic packages/ tree ──


test('loadWorkspacePackages: discovers every package a synthetic manifest\'s "packages/*" glob declares', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-license-run-workspaces-'));
  try {
    fs.writeFileSync(
      path.join(tmpRoot, 'package.json'),
      JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
    );
    writeWorkspacePackage(tmpRoot, 'pkg-a', { name: '@lannguyensi/pkg-a', private: false });
    writeWorkspacePackage(tmpRoot, 'pkg-b', { name: '@lannguyensi/pkg-b', private: true });
    // A workspace-glob directory entry with no package.json: excluded from
    // both the expected expansion and discovery.
    fs.mkdirSync(path.join(tmpRoot, 'packages', 'not-a-package'), { recursive: true });

    // Independent expansion of the synthetic manifest's "workspaces" glob
    // (does not call loadWorkspacePackages or reuse its hardcoded
    // "packages/" path). This checks the loader against a tree the glob
    // declares; the pin that the REAL root manifest still declares only
    // "packages/*" is the separate test above.
    const rootPkg = JSON.parse(fs.readFileSync(path.join(tmpRoot, 'package.json'), 'utf8'));
    const expectedNames = [];
    for (const pattern of rootPkg.workspaces) {
      assert.ok(pattern.endsWith('/*'), `fixture only supports the "<dir>/*" glob form, got: ${pattern}`);
      const baseDir = path.join(tmpRoot, pattern.slice(0, -'/*'.length));
      for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!fs.existsSync(path.join(baseDir, entry.name, 'package.json'))) continue;
        expectedNames.push(entry.name);
      }
    }
    expectedNames.sort();

    const discoveredNames = loadWorkspacePackages(tmpRoot)
      .map((pkg) => path.basename(pkg.dir))
      .sort();
    assert.deepEqual(discoveredNames, expectedNames);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── run(): real repo end-to-end (this task's actual change) ─────────────
// Runs the real checker against the real repo root, with the real
// `runNpmPackDryRun` (default packFn, so this one test DOES shell out to
// `npm pack --dry-run --json` per publishable package): the actual proof
// that every publishable packages/* member ships LICENSE in its real
// tarball, not just in a synthetic fixture.

test('run(): the real repo, with the real npm pack --dry-run, exits 0 for every publishable package', () => {
  const rootDir = path.join(__dirname, '..');
  const exitCode = run(rootDir);
  assert.equal(exitCode, 0);
});
