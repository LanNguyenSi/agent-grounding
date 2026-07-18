/**
 * Unit tests for the pure `collectPinViolations` checker in check-pins.js.
 *
 * Runs entirely against in-memory fixture workspace arrays (never the real
 * repo manifests), so these tests can safely include a "negative control"
 * fixture with a deliberately broken pin without touching any real
 * package.json. Uses Node's built-in test runner (`node --test`), no
 * additional test-framework dependency needed for a root-level script.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collectPinViolations, collectEnginesViolations, loadWorkspacePackages } = require('./check-pins');

test('engines guard: passes when all published packages declare the same value (private may omit)', () => {
  const workspaces = [
    { name: '@lannguyensi/a', version: '1.0.0', private: false, engines: { node: '>=20' } },
    { name: '@lannguyensi/b', version: '1.0.0', private: false, engines: { node: '>=20' } },
    { name: '@lannguyensi/c', version: '1.0.0', private: true, engines: null },
  ];
  assert.deepEqual(collectEnginesViolations(workspaces), []);
});

test('engines guard: negative control — a diverging engines.node value is flagged as the outlier', () => {
  const workspaces = [
    { name: '@lannguyensi/a', version: '1.0.0', private: false, engines: { node: '>=20' } },
    { name: '@lannguyensi/b', version: '1.0.0', private: false, engines: { node: '>=22' } },
    { name: '@lannguyensi/c', version: '1.0.0', private: false, engines: { node: '>=20' } },
  ];
  const violations = collectEnginesViolations(workspaces);
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0], {
    reason: 'engines-drift',
    consumer: '@lannguyensi/b',
    enginesNode: '>=22',
    expected: '>=20',
  });
});

test('engines guard: modal reference — the outlier is flagged even when it sorts FIRST', () => {
  const workspaces = [
    { name: '@lannguyensi/a', version: '1.0.0', private: false, engines: { node: '>=22' } },
    { name: '@lannguyensi/b', version: '1.0.0', private: false, engines: { node: '>=20' } },
    { name: '@lannguyensi/c', version: '1.0.0', private: false, engines: { node: '>=20' } },
  ];
  const violations = collectEnginesViolations(workspaces);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].consumer, '@lannguyensi/a');
  assert.equal(violations[0].expected, '>=20');
});

test('engines guard: a published package without engines.node is flagged as missing', () => {
  const workspaces = [
    { name: '@lannguyensi/a', version: '1.0.0', private: false, engines: { node: '>=20' } },
    { name: '@lannguyensi/b', version: '1.0.0', private: false, engines: null },
    // engines object present but no .node key counts as missing too
    { name: '@lannguyensi/c', version: '1.0.0', private: false, engines: {} },
  ];
  const violations = collectEnginesViolations(workspaces);
  assert.deepEqual(
    violations.map((v) => [v.reason, v.consumer]),
    [
      ['engines-missing', '@lannguyensi/b'],
      ['engines-missing', '@lannguyensi/c'],
    ],
  );
});

test('passes when every internal pin exactly matches the workspace version', () => {
  const workspaces = [
    { name: '@lannguyensi/a', version: '1.2.0', dependencies: {} },
    { name: '@lannguyensi/b', version: '2.0.0', dependencies: { '@lannguyensi/a': '1.2.0' } },
  ];
  assert.deepEqual(collectPinViolations(workspaces), []);
});

test('passes when a range pin is still satisfied after a patch bump', () => {
  // e.g. an internal pin of "^0.1.0" survives the sibling package moving
  // from 0.1.0 to 0.1.1 unchanged.
  const workspaces = [
    { name: '@lannguyensi/a', version: '0.1.1', dependencies: {} },
    { name: '@lannguyensi/b', version: '2.0.0', dependencies: { '@lannguyensi/a': '^0.1.0' } },
  ];
  assert.deepEqual(collectPinViolations(workspaces), []);
});

test('negative control: catches an exact pin left stale after a version bump', () => {
  // @lannguyensi/a bumped 0.1.0 -> 0.1.1 but the consumer's exact pin was not
  // updated. This is exactly the class of drift the checker exists to catch.
  const workspaces = [
    { name: '@lannguyensi/a', version: '0.1.1', dependencies: {} },
    { name: '@lannguyensi/b', version: '2.0.0', dependencies: { '@lannguyensi/a': '0.1.0' } },
  ];
  const violations = collectPinViolations(workspaces);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].reason, 'unsatisfied');
  assert.equal(violations[0].consumer, '@lannguyensi/b');
  assert.equal(violations[0].dependency, '@lannguyensi/a');
  assert.equal(violations[0].pin, '0.1.0');
  assert.equal(violations[0].workspaceVersion, '0.1.1');
});

test('checks devDependencies as well as dependencies', () => {
  const workspaces = [
    { name: '@lannguyensi/a', version: '3.0.0', dependencies: {} },
    {
      name: '@lannguyensi/b',
      version: '1.0.0',
      dependencies: {},
      devDependencies: { '@lannguyensi/a': '2.9.0' },
    },
  ];
  const violations = collectPinViolations(workspaces);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].field, 'devDependencies');
});

test('flags an unsatisfied internal peerDependency pin', () => {
  const workspaces = [
    { name: '@lannguyensi/a', version: '1.0.0', dependencies: {} },
    {
      name: '@lannguyensi/b',
      version: '1.0.0',
      dependencies: {},
      peerDependencies: { '@lannguyensi/a': '^2.0.0' },
    },
  ];
  const violations = collectPinViolations(workspaces);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].reason, 'unsatisfied');
  assert.equal(violations[0].field, 'peerDependencies');
  assert.equal(violations[0].consumer, '@lannguyensi/b');
});

test('passes when an internal optionalDependency pin is satisfied', () => {
  const workspaces = [
    { name: '@lannguyensi/a', version: '1.2.3', dependencies: {} },
    {
      name: '@lannguyensi/b',
      version: '1.0.0',
      dependencies: {},
      optionalDependencies: { '@lannguyensi/a': '^1.2.0' },
    },
  ];
  assert.deepEqual(collectPinViolations(workspaces), []);
});

test('a prerelease workspace version does NOT satisfy a range pin (strict internal check)', () => {
  // For a strict internal-consistency check, a prerelease sibling
  // (0.1.1-rc.1) should not silently satisfy a consumer's "^0.1.0" pin, even
  // though semver's default (non-prerelease) range matching would normally
  // treat "^0.1.0" as excluding all 0.1.1-rc.1-style prereleases anyway.
  // This pins that behavior explicitly (no `includePrerelease`).
  const workspaces = [
    { name: '@lannguyensi/a', version: '0.1.1-rc.1', dependencies: {} },
    { name: '@lannguyensi/b', version: '2.0.0', dependencies: { '@lannguyensi/a': '^0.1.0' } },
  ];
  const violations = collectPinViolations(workspaces);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].reason, 'unsatisfied');
  assert.equal(violations[0].dependency, '@lannguyensi/a');
});

test('ignores external (non-@lannguyensi) dependency pins entirely', () => {
  const workspaces = [
    {
      name: '@lannguyensi/a',
      version: '1.0.0',
      dependencies: { chalk: '^4.1.2', commander: '^11.1.0' },
    },
  ];
  assert.deepEqual(collectPinViolations(workspaces), []);
});

test('flags a pin referencing a workspace package that does not exist', () => {
  const workspaces = [
    {
      name: '@lannguyensi/b',
      version: '1.0.0',
      dependencies: { '@lannguyensi/does-not-exist': '1.0.0' },
    },
  ];
  const violations = collectPinViolations(workspaces);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].reason, 'unknown-workspace');
  assert.equal(violations[0].dependency, '@lannguyensi/does-not-exist');
});

test('reports one violation per offending pin across multiple packages', () => {
  const workspaces = [
    { name: '@lannguyensi/a', version: '1.0.0', dependencies: {} },
    { name: '@lannguyensi/b', version: '2.0.0', dependencies: { '@lannguyensi/a': '0.9.0' } },
    { name: '@lannguyensi/c', version: '3.0.0', dependencies: { '@lannguyensi/a': '0.8.0' } },
  ];
  const violations = collectPinViolations(workspaces);
  assert.equal(violations.length, 2);
});

// ── Zero-workspace guard ─────────────────────────────────────────────────
// main() (in check-pins.js) must not vacuously pass when loadWorkspacePackages()
// finds zero packages (e.g. packages/ renamed/emptied) — that would silently
// disable the CI gate. These tests exercise loadWorkspacePackages() itself
// against real (but temporary, disposable) directory layouts; they never
// touch this repo's actual packages/ directory.

test('loadWorkspacePackages returns [] for a packages/ dir with no package.json subdirs', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-pins-empty-'));
  try {
    fs.mkdirSync(path.join(tmpRoot, 'packages'));
    // A subdirectory with no package.json should not count as a workspace.
    fs.mkdirSync(path.join(tmpRoot, 'packages', 'not-a-package'));

    const workspaces = loadWorkspacePackages(tmpRoot);
    assert.deepEqual(workspaces, []);
    // The empty result is exactly the input that must make main() (the CLI
    // entrypoint) exit non-zero instead of vacuously reporting success;
    // collectPinViolations() itself would (correctly, in isolation) return
    // no violations for an empty workspace list, which is why the guard has
    // to live in main() before collectPinViolations() is ever called.
    assert.deepEqual(collectPinViolations(workspaces), []);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('loadWorkspacePackages finds real package.json files alongside non-package dirs', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-pins-mixed-'));
  try {
    fs.mkdirSync(path.join(tmpRoot, 'packages', 'not-a-package'), { recursive: true });
    const realPkgDir = path.join(tmpRoot, 'packages', 'real-pkg');
    fs.mkdirSync(realPkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(realPkgDir, 'package.json'),
      JSON.stringify({ name: '@lannguyensi/real-pkg', version: '1.0.0' }),
    );

    const workspaces = loadWorkspacePackages(tmpRoot);
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0].name, '@lannguyensi/real-pkg');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
