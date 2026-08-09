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
const {
  collectPinViolations,
  collectEnginesViolations,
  collectOverrideCouplingViolations,
  collectBraceExpansionCouplingViolations,
  collectAdvisoryFloorViolations,
  loadWorkspacePackages,
  loadRootOverrides,
  loadLockfilePackages,
  ADVISORY_FLOOR_TABLE,
} = require('./check-pins');

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

test('loadLockfilePackages returns {} for a lockfile with an empty "packages" object', () => {
  // main() (in check-pins.js) must not vacuously pass when this happens —
  // mirrors the 0-workspace guard above, applied to package-lock.json's
  // "packages" map. collectBraceExpansionCouplingViolations() itself would
  // (correctly, in isolation) return no violations for an empty packages
  // map, which is why the fail-loud guard has to live in main() before that
  // function is ever called.
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-pins-lockfile-empty-'));
  try {
    fs.writeFileSync(
      path.join(tmpRoot, 'package-lock.json'),
      JSON.stringify({ lockfileVersion: 3, packages: {} }),
    );
    const lockfilePackages = loadLockfilePackages(tmpRoot);
    assert.deepEqual(lockfilePackages, {});
    assert.deepEqual(collectBraceExpansionCouplingViolations(lockfilePackages), []);
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

// ── Override coupling guard (brace-expansion / minimatch / test-exclude) ──
// PR #159 / GHSA-mh99-v99m-4gvg: these three root package.json overrides are
// a coupled set (see the "Override coupling" section of check-pins.js's file
// header for the full rationale). Runs against in-memory fixtures, plus two
// "current real repo state passes" checks that load (but never write) the
// real root package.json / package-lock.json.

test('override coupling: passes when all three coupled keys are present together', () => {
  const overrides = {
    'js-yaml': '^4.2.0',
    'brace-expansion': '^5.0.8',
    minimatch: '^10.2.5',
    'test-exclude': '^8.0.0',
  };
  assert.deepEqual(collectOverrideCouplingViolations(overrides), []);
});

test('override coupling: passes (vacuously) when none of the three coupled keys are present', () => {
  const overrides = { 'js-yaml': '^4.2.0' };
  assert.deepEqual(collectOverrideCouplingViolations(overrides), []);
});

test('override coupling: negative control — brace-expansion removed but minimatch/test-exclude left behind fires', () => {
  // The exact silent-failure mode from the task: only the CVE-fixing
  // override is removed; minimatch/test-exclude are left pinned to the
  // versions that require brace-expansion's 5.x named export.
  const overrides = { minimatch: '^10.2.5', 'test-exclude': '^8.0.0' };
  const violations = collectOverrideCouplingViolations(overrides);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].reason, 'override-coupling-broken');
  assert.deepEqual(violations[0].present, ['minimatch', 'test-exclude']);
  assert.deepEqual(violations[0].missing, ['brace-expansion']);
});

test('override coupling: negative control — only brace-expansion present (partial-fix shape) fires', () => {
  const overrides = { 'js-yaml': '^4.2.0', 'brace-expansion': '^5.0.8' };
  const violations = collectOverrideCouplingViolations(overrides);
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0].present, ['brace-expansion']);
  assert.deepEqual(violations[0].missing, ['minimatch', 'test-exclude']);
});

test('override coupling: current real repo package.json overrides pass', () => {
  const overrides = loadRootOverrides(path.join(__dirname, '..'));
  assert.deepEqual(collectOverrideCouplingViolations(overrides), []);
});

// ── brace-expansion lockfile range guard ───────────────────────────────────
// The other half of the coupling: package-lock.json is the ground truth for
// what actually installs, so every resolved minimatch/test-exclude entry
// that itself depends on brace-expansion must declare a range confined to
// 5.x, regardless of what the root overrides block says.

test('brace-expansion range guard: passes when minimatch/test-exclude declare a range confined to 5.x', () => {
  const lockfilePackages = {
    'node_modules/minimatch': { version: '10.2.5', dependencies: { 'brace-expansion': '^5.0.5' } },
    'node_modules/test-exclude': {
      version: '8.0.0',
      dependencies: { '@istanbuljs/schema': '^0.1.2', glob: '^13.0.6', minimatch: '^10.2.2' },
    },
  };
  assert.deepEqual(collectBraceExpansionCouplingViolations(lockfilePackages), []);
});

test('brace-expansion range guard: an entry with no brace-expansion dependency at all is not a violation', () => {
  // Documents the deliberate choice: nothing to couple-check if the
  // resolved version doesn't depend on brace-expansion in the first place.
  const lockfilePackages = {
    'node_modules/minimatch': { version: '99.0.0', dependencies: {} },
  };
  assert.deepEqual(collectBraceExpansionCouplingViolations(lockfilePackages), []);
});

test('brace-expansion range guard: negative control — a nested pre-5.x minimatch/test-exclude range fires', () => {
  // Reproduces the resolved shape captured 2026-08-06 from a fresh install
  // with only the brace-expansion override present: top-level minimatch
  // stuck on 9.0.9 (range ^2.0.2), plus a nested test-exclude ->
  // node_modules/minimatch at 3.1.5 (range ^1.1.7) — both would throw
  // "TypeError: (0 , brace_expansion_1.default) is not a function" against a
  // globally-resolved brace-expansion 5.x.
  const lockfilePackages = {
    'node_modules/minimatch': { version: '9.0.9', dependencies: { 'brace-expansion': '^2.0.2' } },
    'node_modules/test-exclude': {
      version: '6.0.0',
      dependencies: { '@istanbuljs/schema': '^0.1.2', glob: '^7.1.4', minimatch: '^3.0.4' },
    },
    'node_modules/test-exclude/node_modules/minimatch': {
      version: '3.1.5',
      dependencies: { 'brace-expansion': '^1.1.7' },
    },
  };
  const violations = collectBraceExpansionCouplingViolations(lockfilePackages);
  assert.equal(violations.length, 2);
  assert.deepEqual(
    violations.map((v) => [v.key, v.name, v.version, v.range]),
    [
      ['node_modules/minimatch', 'minimatch', '9.0.9', '^2.0.2'],
      ['node_modules/test-exclude/node_modules/minimatch', 'minimatch', '3.1.5', '^1.1.7'],
    ],
  );
});

test('brace-expansion range guard: a wide-open range like "*" is flagged as not confined to 5.x', () => {
  const lockfilePackages = {
    'node_modules/minimatch': { version: '10.2.5', dependencies: { 'brace-expansion': '*' } },
  };
  const violations = collectBraceExpansionCouplingViolations(lockfilePackages);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].reason, 'brace-expansion-out-of-range');
});

test('brace-expansion range guard: ignores unrelated packages even when resolved alongside minimatch/test-exclude', () => {
  const lockfilePackages = {
    'node_modules/some-other-pkg': { version: '1.0.0', dependencies: { 'brace-expansion': '^1.0.0' } },
  };
  assert.deepEqual(collectBraceExpansionCouplingViolations(lockfilePackages), []);
});

test('brace-expansion range guard: current real repo package-lock.json passes', () => {
  const lockfilePackages = loadLockfilePackages(path.join(__dirname, '..'));
  assert.deepEqual(collectBraceExpansionCouplingViolations(lockfilePackages), []);
});

test('brace-expansion range guard: a non-semver range like "latest" is flagged, not crashed (surviving-mutant guard)', () => {
  // semver.validRange('latest') === null. Without that guard in the
  // confinedTo5x check, semver.intersects('latest', ...) throws
  // "TypeError: Invalid comparator: latest" instead of producing a clean
  // violation — this fixture exercises exactly the branch that guard exists
  // for.
  const lockfilePackages = {
    'node_modules/minimatch': { version: '10.2.5', dependencies: { 'brace-expansion': 'latest' } },
  };
  const violations = collectBraceExpansionCouplingViolations(lockfilePackages);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].reason, 'brace-expansion-out-of-range');
  assert.equal(violations[0].range, 'latest');
});

// ── brace-expansion RESOLVED-version guard (arm-C) ─────────────────────────
// The declared-range check above only reads what minimatch/test-exclude's
// OWN package.json says it needs. An `overrides` entry forces a resolved
// version regardless of that declaration, so a consumer can declare a fine
// 5.x range and still be handed a pre-5.x brace-expansion at runtime. This is
// the "arm-C" shape: overrides { brace-expansion ^2.0.2, minimatch ^10.2.5,
// test-exclude ^8.0.0 } leave both the override-coupling guard and the
// declared-range guard green, and `npm audit` green, while
// `require('minimatch')` throws
// "TypeError: (0 , brace_expansion_1.expand) is not a function".

test('brace-expansion resolved-version guard: arm-C shape fires — declared range confined to 5.x but resolved version is not', () => {
  const lockfilePackages = {
    'node_modules/minimatch': { version: '10.2.5', dependencies: { 'brace-expansion': '^5.0.5' } },
    'node_modules/brace-expansion': { version: '2.0.2' },
  };
  const violations = collectBraceExpansionCouplingViolations(lockfilePackages);
  assert.equal(violations.length, 1);
  assert.deepEqual(violations[0], {
    reason: 'brace-expansion-resolved-mismatch',
    key: 'node_modules/minimatch',
    name: 'minimatch',
    version: '10.2.5',
    declaredRange: '^5.0.5',
    resolvedVersion: '2.0.2',
  });
});

test('brace-expansion resolved-version guard: a consistent tree (declared range confined to 5.x AND resolved version matches) passes', () => {
  const lockfilePackages = {
    'node_modules/minimatch': { version: '10.2.5', dependencies: { 'brace-expansion': '^5.0.5' } },
    'node_modules/brace-expansion': { version: '5.0.9' },
  };
  assert.deepEqual(collectBraceExpansionCouplingViolations(lockfilePackages), []);
});

test('brace-expansion resolved-version guard: walks up to the nearest ANCESTOR node_modules/brace-expansion, not just a nested sibling', () => {
  // node_modules/test-exclude/node_modules/minimatch has no
  // node_modules/test-exclude/node_modules/brace-expansion sitting next to
  // it, so Node's own module resolution (and this guard) falls back to the
  // root node_modules/brace-expansion.
  const lockfilePackages = {
    'node_modules/test-exclude/node_modules/minimatch': {
      version: '10.2.5',
      dependencies: { 'brace-expansion': '^5.0.5' },
    },
    'node_modules/brace-expansion': { version: '5.0.9' },
  };
  assert.deepEqual(collectBraceExpansionCouplingViolations(lockfilePackages), []);
});

// ── Advisory floor guard (curated CVEs) ────────────────────────────────────
// Task 03068fb2 / reviewer-MEDIUM from ce7c1d32: the js-yaml floor raise to
// ^4.3.1 (GHSA-5p4m-2wfm-xmqj) was purely declarative — nothing in CI caught
// a revert, because npm audit reads the lockfile (which kept resolving
// 4.3.1 either way), not the declared range. These tests exercise
// collectAdvisoryFloorViolations() directly against in-memory fixtures, plus
// one "current real repo state passes" check.

test('advisory floor guard: reproduces the ce7c1d32 revert — declared range AND root override both flagged', () => {
  // Exact shape the reviewer's mutation probe used: domain-router's
  // dependency floor reverted to ^4.1.0, root override reverted to ^4.2.0.
  // Both surfaces intersect the closed GHSA-5p4m-2wfm-xmqj range (<4.3.1),
  // and both are independent CI-invisible holes per the task description —
  // this pins that the guard checks both, not just one.
  const workspaces = [
    {
      name: '@lannguyensi/domain-router',
      version: '0.1.3',
      dependencies: { chalk: '^4.1.2', commander: '^11.1.0', 'js-yaml': '^4.1.0' },
    },
  ];
  const overrides = { 'js-yaml': '^4.2.0', 'brace-expansion': '^5.0.8', minimatch: '^10.2.5', 'test-exclude': '^8.0.0' };

  const violations = collectAdvisoryFloorViolations(workspaces, overrides);
  assert.equal(violations.length, 2);

  const declared = violations.find((v) => v.source === 'declared');
  assert.deepEqual(declared, {
    reason: 'advisory-floor-violated',
    source: 'declared',
    consumer: '@lannguyensi/domain-router',
    field: 'dependencies',
    dependency: 'js-yaml',
    range: '^4.1.0',
    advisoryId: 'GHSA-5p4m-2wfm-xmqj',
    vulnerableRange: '<4.3.1',
  });

  const override = violations.find((v) => v.source === 'override');
  assert.deepEqual(override, {
    reason: 'advisory-floor-violated',
    source: 'override',
    dependency: 'js-yaml',
    range: '^4.2.0',
    advisoryId: 'GHSA-5p4m-2wfm-xmqj',
    vulnerableRange: '<4.3.1',
  });
});

test('advisory floor guard: fires from the declared range alone, even when the root override is fine', () => {
  const workspaces = [
    { name: '@lannguyensi/domain-router', version: '0.1.3', dependencies: { 'js-yaml': '^4.1.0' } },
  ];
  const overrides = { 'js-yaml': '^4.3.1' };
  const violations = collectAdvisoryFloorViolations(workspaces, overrides);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].source, 'declared');
});

test('advisory floor guard: fires from the root override alone, even when every declared range is fine', () => {
  const workspaces = [
    { name: '@lannguyensi/domain-router', version: '0.1.3', dependencies: { 'js-yaml': '^4.3.1' } },
  ];
  const overrides = { 'js-yaml': '^4.2.0' };
  const violations = collectAdvisoryFloorViolations(workspaces, overrides);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].source, 'override');
});

test('advisory floor guard: instrument liveness — boundary precision around the curated <4.3.1 cutoff', () => {
  // A declared range that still reaches the last vulnerable patch (4.3.0)
  // must fire; a declared range confined to exactly the curated floor
  // (4.3.1) must not. Any drift in ADVISORY_FLOOR_TABLE's vulnerableRange
  // for js-yaml (e.g. accidentally weakened to "<4.3.0" or "<4.2.0") flips
  // one of these two assertions and turns this test red — proving the guard
  // is wired to the exact curated cutoff, not just "some range check".
  const insideVulnerableWindow = collectAdvisoryFloorViolations(
    [{ name: '@lannguyensi/domain-router', version: '0.1.3', dependencies: { 'js-yaml': '^4.3.0' } }],
    {},
  );
  assert.equal(insideVulnerableWindow.length, 1);
  assert.equal(insideVulnerableWindow[0].advisoryId, 'GHSA-5p4m-2wfm-xmqj');

  const atCuratedFloor = collectAdvisoryFloorViolations(
    [{ name: '@lannguyensi/domain-router', version: '0.1.3', dependencies: { 'js-yaml': '4.3.1' } }],
    {},
  );
  assert.deepEqual(atCuratedFloor, []);
});

test('advisory floor guard: no false positive on ordinary caret runtime deps not in the curated table', () => {
  // The reviewer explicitly measured that a general "floor == resolved"
  // rule would flag 18/20 external runtime deps as ordinary caret-range
  // practice. This fixture exercises exactly that shape (unrelated
  // packages, wide caret ranges) and pins that the curated-table guard
  // stays silent because none of these names are in ADVISORY_FLOOR_TABLE.
  const workspaces = [
    {
      name: '@lannguyensi/domain-router',
      version: '0.1.3',
      dependencies: { chalk: '^4.1.2', commander: '^11.1.0', 'js-yaml': '^4.3.1' },
      devDependencies: { jest: '^30.3.0', typescript: '^5.0.0' },
    },
  ];
  const overrides = { 'brace-expansion': '^5.0.8', minimatch: '^10.2.5', 'test-exclude': '^8.0.0' };
  assert.deepEqual(collectAdvisoryFloorViolations(workspaces, overrides), []);
});

test('advisory floor guard: a non-semver declared range for a curated dependency is reported, not fail-open skipped', () => {
  // Fixed from a MEDIUM found on empirical review: this used to `continue`
  // past any range `semver.validRange` couldn't parse, silently passing a
  // git URL, an npm dist-tag, or (the practically reachable bypass below) an
  // npm alias straight through. That is fail-OPEN for the exact class this
  // guard exists to close, so an unparseable range on a curated name must
  // now be its own violation (fail-CLOSED), never skipped or crashed on.
  const workspaces = [
    { name: '@lannguyensi/pkg', version: '1.0.0', dependencies: { 'js-yaml': 'latest' } },
  ];
  const violations = collectAdvisoryFloorViolations(workspaces, {});
  assert.deepEqual(violations, [
    {
      reason: 'advisory-floor-unparseable-range',
      source: 'declared',
      consumer: '@lannguyensi/pkg',
      field: 'dependencies',
      dependency: 'js-yaml',
      range: 'latest',
      advisoryId: 'GHSA-5p4m-2wfm-xmqj',
      vulnerableRange: '<4.3.1',
    },
  ]);
});

test('advisory floor guard: the npm self-alias bypass ("npm:js-yaml@^4.1.0" under the "js-yaml" key) is reported, not fail-open skipped', () => {
  // Reviewer-measured practical bypass: `"js-yaml": "npm:js-yaml@^4.1.0"` is
  // valid npm syntax that still installs the vulnerable js-yaml under the
  // curated key, but `semver.validRange` can't parse the alias form, so the
  // old skip-on-invalid behavior let this straight through silently.
  const workspaces = [
    { name: '@lannguyensi/pkg', version: '1.0.0', dependencies: { 'js-yaml': 'npm:js-yaml@^4.1.0' } },
  ];
  const violations = collectAdvisoryFloorViolations(workspaces, {});
  assert.equal(violations.length, 1);
  assert.equal(violations[0].reason, 'advisory-floor-unparseable-range');
  assert.equal(violations[0].dependency, 'js-yaml');
  assert.equal(violations[0].range, 'npm:js-yaml@^4.1.0');
});

test('advisory floor guard: a git-URL declared range for a curated dependency is reported, not fail-open skipped', () => {
  const workspaces = [
    {
      name: '@lannguyensi/pkg',
      version: '1.0.0',
      dependencies: { 'js-yaml': 'git+https://github.com/nodeca/js-yaml.git#4.1.0' },
    },
  ];
  const violations = collectAdvisoryFloorViolations(workspaces, {});
  assert.equal(violations.length, 1);
  assert.equal(violations[0].reason, 'advisory-floor-unparseable-range');
});

test('advisory floor guard: the npm alias bypass in the ROOT OVERRIDE is also reported, not fail-open skipped', () => {
  const overrides = { 'js-yaml': 'npm:js-yaml@^4.1.0' };
  const violations = collectAdvisoryFloorViolations([], overrides);
  assert.deepEqual(violations, [
    {
      reason: 'advisory-floor-unparseable-range',
      source: 'override',
      dependency: 'js-yaml',
      range: 'npm:js-yaml@^4.1.0',
      advisoryId: 'GHSA-5p4m-2wfm-xmqj',
      vulnerableRange: '<4.3.1',
    },
  ]);
});

test('advisory floor guard: current real repo package.json + root overrides pass', () => {
  const rootDir = path.join(__dirname, '..');
  const workspaces = loadWorkspacePackages(rootDir);
  const overrides = loadRootOverrides(rootDir);
  assert.deepEqual(collectAdvisoryFloorViolations(workspaces, overrides), []);
});

test('advisory floor guard: the curated table currently only covers js-yaml (GHSA-5p4m-2wfm-xmqj)', () => {
  // Documents the current scope so an accidental table edit (e.g. a typo'd
  // key, or an entry silently dropped) is visible as a diff in this test
  // rather than only as a gap in coverage nobody notices.
  assert.deepEqual(ADVISORY_FLOOR_TABLE, {
    'js-yaml': { id: 'GHSA-5p4m-2wfm-xmqj', vulnerableRange: '<4.3.1' },
  });
});

test('advisory floor guard: ADVISORY_FLOOR_TABLE (and its entries) are frozen so nothing can weaken the curated table at runtime', () => {
  assert.equal(Object.isFrozen(ADVISORY_FLOOR_TABLE), true);
  assert.equal(Object.isFrozen(ADVISORY_FLOOR_TABLE['js-yaml']), true);
});

// ── Advisory floor guard: object-form npm `overrides` (reviewer MEDIUM) ────
// npm's `overrides` field allows a nested-object value instead of a plain
// version string, either to set the key's own version via a "." sub-key, or
// to scope an override to a dependency nested inside that key's subtree.
// The original override loop only iterated top-level keys and treated every
// value as a string; `semver.validRange(<object>)` is `null`, so both shapes
// below used to fall through the same non-semver skip and pass silently even
// though both are valid npm and both can reintroduce the vulnerable version.

test('advisory floor guard: object-form self-override ({"js-yaml": {".": "^4.1.0"}}) is caught, not silently skipped', () => {
  const overrides = { 'js-yaml': { '.': '^4.1.0' } };
  const violations = collectAdvisoryFloorViolations([], overrides);
  assert.deepEqual(violations, [
    {
      reason: 'advisory-floor-violated',
      source: 'override',
      dependency: 'js-yaml',
      range: '^4.1.0',
      advisoryId: 'GHSA-5p4m-2wfm-xmqj',
      vulnerableRange: '<4.3.1',
    },
  ]);
});

test('advisory floor guard: object-form nested override ({"some-pkg": {"js-yaml": "^4.1.0"}}) is caught, not silently skipped', () => {
  const overrides = { 'some-pkg': { 'js-yaml': '^4.1.0' } };
  const violations = collectAdvisoryFloorViolations([], overrides);
  assert.deepEqual(violations, [
    {
      reason: 'advisory-floor-violated',
      source: 'override',
      dependency: 'js-yaml',
      range: '^4.1.0',
      advisoryId: 'GHSA-5p4m-2wfm-xmqj',
      vulnerableRange: '<4.3.1',
    },
  ]);
});

test('advisory floor guard: an override value this guard cannot interpret at all (neither string nor nested object) is reported, not skipped', () => {
  const overrides = { 'js-yaml': 42 };
  const violations = collectAdvisoryFloorViolations([], overrides);
  assert.deepEqual(violations, [
    {
      reason: 'advisory-floor-unhandled-override-shape',
      source: 'override',
      dependency: 'js-yaml',
      advisoryId: 'GHSA-5p4m-2wfm-xmqj',
      vulnerableRange: '<4.3.1',
    },
  ]);
});

test('advisory floor guard: object-form overrides for a non-curated key stay silent (no false positive)', () => {
  const overrides = { 'some-pkg': { '.': '^2.0.0', chalk: '^4.1.2' } };
  assert.deepEqual(collectAdvisoryFloorViolations([], overrides), []);
});

// ── Advisory floor guard: field coverage (reviewer MEDIUM) ─────────────────
// Every prior fixture in this file only ever put js-yaml under `dependencies`.
// That leaves `for (const field of DEPENDENCY_FIELDS)` untested for the other
// three fields — a mutant collapsing DEPENDENCY_FIELDS to `['dependencies']`
// would pass every test above unnoticed. This fixture puts a curated name
// under devDependencies, peerDependencies, and optionalDependencies and
// asserts `field` on each violation, so that mutant now loses a violation
// and turns this test red.

test('advisory floor guard: fires for js-yaml under devDependencies, peerDependencies, and optionalDependencies too (not just dependencies)', () => {
  const workspaces = [
    { name: '@lannguyensi/pkg-dev', version: '1.0.0', devDependencies: { 'js-yaml': '^4.1.0' } },
    { name: '@lannguyensi/pkg-peer', version: '1.0.0', peerDependencies: { 'js-yaml': '^4.1.0' } },
    { name: '@lannguyensi/pkg-optional', version: '1.0.0', optionalDependencies: { 'js-yaml': '^4.1.0' } },
  ];
  const violations = collectAdvisoryFloorViolations(workspaces, {});
  assert.equal(violations.length, 3);
  assert.deepEqual(
    violations.map((v) => v.field).sort(),
    ['devDependencies', 'optionalDependencies', 'peerDependencies'],
  );
  for (const violation of violations) {
    assert.equal(violation.reason, 'advisory-floor-violated');
    assert.equal(violation.dependency, 'js-yaml');
  }
});

// ── Advisory floor guard: prototype-key safety (reviewer LOW) ──────────────
// `ADVISORY_FLOOR_TABLE[dependency]` with `dependency === 'constructor'` (a
// syntactically valid npm package name) used to return the inherited
// `Object.prototype.constructor` function — truthy, so the old `if
// (!advisory) continue` guard did not skip it — and then crash inside
// `semver.intersects` on `advisory.vulnerableRange` being `undefined`. The
// fix is an explicit `hasOwnProperty` guard; these fixtures must resolve
// cleanly (no throw) to `[]` rather than crash the whole check.

test('advisory floor guard: a declared dependency literally named "constructor" is looked up safely, not crashed', () => {
  const workspaces = [
    { name: '@lannguyensi/pkg', version: '1.0.0', dependencies: { constructor: '^4.1.0' } },
  ];
  assert.deepEqual(collectAdvisoryFloorViolations(workspaces, {}), []);
});

test('advisory floor guard: a root override literally named "constructor" is looked up safely, not crashed', () => {
  const overrides = { constructor: '^4.1.0' };
  assert.deepEqual(collectAdvisoryFloorViolations([], overrides), []);
});
