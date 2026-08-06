#!/usr/bin/env node
/**
 * Pin-consistency check.
 *
 * The per-tag version guard (publish-libs.yml / publish-npm.yml) only
 * validates that the *tagged* package's own `version` field matches the git
 * tag. Nothing asserts that every internal `@lannguyensi/*` dependency pin
 * declared by one workspace package actually points at a version the
 * corresponding sibling workspace carries (or is being bumped to in the same
 * PR). A stale pin left behind after a version bump would only surface much
 * later, as an npm install resolution error or a runtime mismatch.
 *
 * This script walks every `packages/*\/package.json`, and for every
 * `@lannguyensi/*` dependency pin (in `dependencies`, `devDependencies`,
 * `peerDependencies`, or `optionalDependencies`), asserts the pin is
 * satisfiable (semver `satisfies`, prereleases excluded) by the current
 * `version` of the workspace package it names. An exact pin (`"0.5.0"`) must
 * equal the sibling's version; a range pin (`"^0.1.0"`) just needs to still
 * match after a patch/minor bump.
 *
 * Assumption: every `@lannguyensi/*` dependency named anywhere in this
 * monorepo is one of *this* monorepo's own workspace packages (true today;
 * verified by grep over packages/*\/package.json). If a package ever pins a
 * `@lannguyensi/*` dependency that is published from a different repo (not a
 * workspace member here), that pin has no corresponding entry in
 * `versionByName` and is deliberately hard-failed as `unknown-workspace`
 * rather than silently skipped. Introducing a cross-repo `@lannguyensi/*`
 * dependency would need an explicit allowlist added here first.
 *
 * ── Override coupling (brace-expansion / minimatch / test-exclude) ────────
 *
 * PR #159 closed GHSA-mh99-v99m-4gvg (brace-expansion DoS, HIGH) by pinning
 * the root `overrides` block to brace-expansion@^5.0.8, but that fix is only
 * safe together with minimatch@^10.2.5 and test-exclude@^8.0.0: those are
 * the first releases of minimatch/test-exclude that consume brace-expansion
 * 5.x's named `expand` export instead of the pre-5.x callable default. The
 * three overrides are a COUPLED SET, and npm enforces nothing about that
 * coupling on its own — removing only the brace-expansion override still
 * resolves brace-expansion@5.x (nothing else in the tree pins it lower) and
 * stays `npm audit --audit-level=high` green (no known CVE in the resolved
 * versions), while an older minimatch/test-exclude that resolves against it
 * throws at runtime:
 *   TypeError: (0 , brace_expansion_1.default) is not a function
 * (reproduced 2026-08-06 against a fresh install with only the
 * brace-expansion override present: minimatch resolves to 9.0.9, with a
 * nested test-exclude -> minimatch@3.1.5, both declaring a pre-5.x
 * brace-expansion range, while brace-expansion itself resolves to 5.0.9.)
 *
 * Two checks below guard this coupling from opposite ends:
 *   - `collectOverrideCouplingViolations` checks the root package.json
 *     `overrides` block: if any of the three coupled keys is present, all
 *     three must be present.
 *   - `collectBraceExpansionCouplingViolations` checks package-lock.json
 *     itself (the ground truth for what actually installs): every resolved
 *     minimatch/test-exclude entry that declares its own brace-expansion
 *     dependency must declare a range confined to 5.x. This catches a stale
 *     lockfile even if the overrides block above is correct (e.g. hand-
 *     edited, or generated before the coupled overrides existed and never
 *     regenerated).
 * Neither check repairs anything; both only fail loudly. (Deliberately not
 * adding `glob` as a fourth coupled override: glob@13's CJS build sets
 * `__esModule: true` without a `default` export, which breaks Jest's
 * `_interopRequireDefault` in consuming packages; test-exclude@8 already
 * pulls glob ^13.0.6 itself where it needs it.)
 *
 * Usage: `node scripts/check-pins.js` (wired as the `check:pins` npm script).
 * Exits non-zero and prints one line per offending package + pin on failure.
 * Also exits non-zero (instead of vacuously passing) if zero workspace
 * packages are found at all, e.g. `packages/` was renamed or emptied and the
 * check would otherwise silently stop checking anything.
 */
const fs = require('fs');
const path = require('path');
const semver = require('semver');

const INTERNAL_SCOPE_PREFIX = '@lannguyensi/';
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

/**
 * Reads every packages/*\/package.json under `rootDir` and returns an array
 * of `{ name, version, dependencies, devDependencies, peerDependencies,
 * optionalDependencies }` shapes. Skips any workspace directory that has no
 * package.json.
 */
function loadWorkspacePackages(rootDir) {
  const packagesDir = path.join(rootDir, 'packages');
  const entries = fs.readdirSync(packagesDir, { withFileTypes: true });
  const workspaces = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgJsonPath = path.join(packagesDir, entry.name, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    workspaces.push({
      name: pkg.name,
      version: pkg.version,
      private: pkg.private === true,
      engines: pkg.engines || null,
      dependencies: pkg.dependencies || {},
      devDependencies: pkg.devDependencies || {},
      peerDependencies: pkg.peerDependencies || {},
      optionalDependencies: pkg.optionalDependencies || {},
    });
  }
  return workspaces;
}

/**
 * Reads the root package.json and returns its `overrides` object (or `{}` if
 * absent).
 */
function loadRootOverrides(rootDir) {
  const pkgJsonPath = path.join(rootDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  return pkg.overrides || {};
}

/**
 * Reads the root package-lock.json and returns its `packages` object (keyed
 * by node_modules path, e.g. `"node_modules/minimatch"` or
 * `"node_modules/test-exclude/node_modules/minimatch"` for a nested
 * resolution) — or `{}` if the lockfile has no `packages` field at all
 * (unexpected for the npm lockfileVersion this repo uses, but handled the
 * same defensive way as an empty workspace list below: a missing field here
 * must not silently skip the coupling check).
 */
function loadLockfilePackages(rootDir) {
  const lockPath = path.join(rootDir, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  return lock.packages || {};
}

/**
 * Pure checker: given the array of workspace package shapes (as returned by
 * loadWorkspacePackages, or an equivalent in-memory fixture), returns an
 * array of violation objects. Empty array means every internal pin is
 * consistent.
 *
 * Each violation is one of:
 *   { reason: 'unsatisfied', consumer, field, dependency, pin, workspaceVersion }
 *   { reason: 'unknown-workspace', consumer, field, dependency, pin }
 */
function collectPinViolations(workspacePackages) {
  const versionByName = new Map(workspacePackages.map((pkg) => [pkg.name, pkg.version]));
  const violations = [];

  for (const pkg of workspacePackages) {
    for (const field of DEPENDENCY_FIELDS) {
      const deps = pkg[field] || {};
      for (const [dependency, pin] of Object.entries(deps)) {
        if (!dependency.startsWith(INTERNAL_SCOPE_PREFIX)) continue;

        if (!versionByName.has(dependency)) {
          violations.push({
            reason: 'unknown-workspace',
            consumer: pkg.name,
            field,
            dependency,
            pin,
          });
          continue;
        }

        const workspaceVersion = versionByName.get(dependency);
        // No `includePrerelease`: this is a strict internal-consistency
        // check, so a prerelease sibling (e.g. 0.1.1-rc.1) deliberately does
        // NOT satisfy a range pin like "^0.1.0" — a prerelease should not be
        // treated as an interchangeable stand-in for the range it's cut from.
        if (!semver.satisfies(workspaceVersion, pin)) {
          violations.push({
            reason: 'unsatisfied',
            consumer: pkg.name,
            field,
            dependency,
            pin,
            workspaceVersion,
          });
        }
      }
    }
  }

  return violations;
}

/**
 * Engines policy guard (decision 2026-07-18, uniform baseline):
 *
 *  1. Presence — every PUBLISHED workspace package (`private` !== true)
 *     must declare `engines.node`. The monorepo releases packages
 *     together; a published package without the baseline silently drops
 *     the supported-Node signal for its consumers.
 *  2. Uniformity — every declared `engines.node` value (published or not)
 *     must be identical. `expected` is the modal (most common) declared
 *     value, so the violation message points at the actual outlier, not
 *     at whichever package happens to sort first. On an even split there
 *     is no true majority; the tie breaks to the first-declared value —
 *     arbitrary, but any split is real drift and fails the gate either way.
 *
 * Violations:
 *   { reason: 'engines-missing', consumer }
 *   { reason: 'engines-drift', consumer, enginesNode, expected }
 */
function collectEnginesViolations(workspacePackages) {
  const violations = [];

  for (const pkg of workspacePackages) {
    if (!pkg.private && !(pkg.engines && pkg.engines.node)) {
      violations.push({ reason: 'engines-missing', consumer: pkg.name });
    }
  }

  const declaring = workspacePackages.filter((pkg) => pkg.engines && pkg.engines.node);
  if (declaring.length === 0) return violations;

  const counts = new Map();
  for (const pkg of declaring) {
    counts.set(pkg.engines.node, (counts.get(pkg.engines.node) || 0) + 1);
  }
  let expected = declaring[0].engines.node;
  for (const [value, count] of counts) {
    if (count > counts.get(expected)) expected = value;
  }

  for (const pkg of declaring) {
    if (pkg.engines.node !== expected) {
      violations.push({
        reason: 'engines-drift',
        consumer: pkg.name,
        enginesNode: pkg.engines.node,
        expected,
      });
    }
  }
  return violations;
}

/**
 * Coupled-override guard: brace-expansion / minimatch / test-exclude (see
 * the "Override coupling" section of the file header for the full
 * rationale). Given the root package.json `overrides` object, asserts that
 * if ANY of the three coupled keys is present, ALL three are present — a
 * partial set (e.g. brace-expansion removed but minimatch/test-exclude left
 * behind) is exactly the silent failure mode this guard exists to catch. An
 * overrides block containing NONE of the three keys is not a violation on
 * its own (nothing here asserts the coupled set must exist at all — that is
 * a product decision, not something a pin-consistency script should force).
 *
 * Violation: { reason: 'override-coupling-broken', present, missing }
 */
const COUPLED_OVERRIDE_KEYS = ['brace-expansion', 'minimatch', 'test-exclude'];

function collectOverrideCouplingViolations(overrides) {
  const present = COUPLED_OVERRIDE_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(overrides || {}, key),
  );
  if (present.length === 0 || present.length === COUPLED_OVERRIDE_KEYS.length) {
    return [];
  }
  const missing = COUPLED_OVERRIDE_KEYS.filter((key) => !present.includes(key));
  return [{ reason: 'override-coupling-broken', present, missing }];
}

/**
 * Coupled-override guard, lockfile half: given package-lock.json's
 * `packages` object, finds every resolved `minimatch` and `test-exclude`
 * entry (at any nesting depth — a nested resolution not reached by the root
 * override would be exactly the kind of drift this exists to catch) and, for
 * each one that itself declares a `brace-expansion` dependency, asserts that
 * declared range is confined to 5.x (i.e. does not intersect anything
 * outside `>=5.0.0 <6.0.0`). A version whose own declared range reaches
 * outside 5.x predates the named-export migration and breaks at runtime
 * against the brace-expansion 5.x this repo forces.
 *
 * An entry with no `brace-expansion` key in its own `dependencies` at all
 * (e.g. some future minimatch major that drops the dependency, or an
 * unrelated package that happens to share the name) has nothing to
 * couple-check and is deliberately NOT a violation — there is no declared
 * range to conflict with the override.
 *
 * Violation: { reason: 'brace-expansion-out-of-range', key, name, version, range }
 */
const BRACE_EXPANSION_COUPLED_CONSUMERS = new Set(['minimatch', 'test-exclude']);
const BRACE_EXPANSION_OUTSIDE_5X_RANGE = '<5.0.0 || >=6.0.0';

function lockfilePackageBaseName(key) {
  const marker = 'node_modules/';
  const idx = key.lastIndexOf(marker);
  if (idx === -1) return null; // the root project entry (key === '') has no node_modules segment
  return key.slice(idx + marker.length);
}

function collectBraceExpansionCouplingViolations(lockfilePackages) {
  const violations = [];
  for (const [key, entry] of Object.entries(lockfilePackages || {})) {
    const name = lockfilePackageBaseName(key);
    if (!name || !BRACE_EXPANSION_COUPLED_CONSUMERS.has(name)) continue;

    const range = entry && entry.dependencies && entry.dependencies['brace-expansion'];
    if (!range) continue; // no brace-expansion dependency declared at all — nothing to couple-check

    const confinedTo5x = semver.validRange(range) !== null && !semver.intersects(range, BRACE_EXPANSION_OUTSIDE_5X_RANGE);
    if (!confinedTo5x) {
      violations.push({
        reason: 'brace-expansion-out-of-range',
        key,
        name,
        version: entry.version,
        range,
      });
    }
  }
  return violations;
}

function formatViolation(violation) {
  if (violation.reason === 'engines-missing') {
    return (
      `  - ${violation.consumer} is published (not private) but declares no engines.node — ` +
      `every published package carries the uniform supported-Node baseline.`
    );
  }
  if (violation.reason === 'engines-drift') {
    return (
      `  - ${violation.consumer} declares engines.node "${violation.enginesNode}", ` +
      `but the workspace baseline is "${violation.expected}" — keep the value uniform.`
    );
  }
  if (violation.reason === 'override-coupling-broken') {
    return (
      `  - root package.json overrides declares ${violation.present.join(', ')} but not ` +
      `${violation.missing.join(', ')} — brace-expansion/minimatch/test-exclude are a coupled set ` +
      `(minimatch@10.2.5 and test-exclude@8.0.0 are the first releases consuming brace-expansion 5.x's ` +
      `named \`expand\` export instead of the pre-5.x callable default; a partial set still resolves ` +
      `brace-expansion 5.x and stays audit-green while an older minimatch/test-exclude throws ` +
      `"TypeError: (0 , brace_expansion_1.default) is not a function" at runtime). Add the missing ` +
      `override(s) back, or remove all three together.`
    );
  }
  if (violation.reason === 'brace-expansion-out-of-range') {
    return (
      `  - package-lock.json "${violation.key}" (${violation.name}@${violation.version}) declares a ` +
      `brace-expansion dependency range "${violation.range}" that is not confined to 5.x — this resolved ` +
      `version predates brace-expansion 5.x's named \`expand\` export and throws ` +
      `"TypeError: (0 , brace_expansion_1.default) is not a function" if it resolves against the current ` +
      `brace-expansion override. Regenerate package-lock.json against the coupled override set (or bump ` +
      `${violation.name} to a version whose own brace-expansion range is confined to 5.x).`
    );
  }
  const location = `${violation.consumer} (${violation.field})`;
  if (violation.reason === 'unknown-workspace') {
    return (
      `  - ${location} pins "${violation.dependency}": "${violation.pin}", ` +
      `but no workspace package named ${violation.dependency} exists.`
    );
  }
  return (
    `  - ${location} pins "${violation.dependency}": "${violation.pin}", which does not ` +
    `match ${violation.dependency}'s current workspace version ${violation.workspaceVersion}.`
  );
}

function main() {
  const rootDir = path.join(__dirname, '..');
  const workspaces = loadWorkspacePackages(rootDir);

  if (workspaces.length === 0) {
    // Fail loudly instead of vacuously passing. If packages/ were ever
    // renamed, moved, or emptied, silently reporting success here would
    // disable this CI gate without anyone noticing.
    console.error(
      'Pin consistency check failed: found 0 workspace packages under packages/. ' +
        'Expected at least one packages/*/package.json; packages/ exists but contains no ' +
        'subdirectory with a package.json (renamed, emptied, or reorganized?).',
    );
    process.exitCode = 1;
    return;
  }

  const overrides = loadRootOverrides(rootDir);
  const lockfilePackages = loadLockfilePackages(rootDir);

  const violations = [
    ...collectPinViolations(workspaces),
    ...collectEnginesViolations(workspaces),
    ...collectOverrideCouplingViolations(overrides),
    ...collectBraceExpansionCouplingViolations(lockfilePackages),
  ];

  if (violations.length > 0) {
    console.error(`Pin consistency check failed (${violations.length} violation(s)):\n`);
    for (const violation of violations) {
      console.error(formatViolation(violation));
    }
    console.error(
      '\nSee each violation above for its specific fix (an internal pin bump, an engines.node ' +
        'fix, or restoring/regenerating the coupled brace-expansion/minimatch/test-exclude overrides).',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `Pin consistency check passed: ${workspaces.length} workspace package(s), all internal ` +
      `${INTERNAL_SCOPE_PREFIX}* pins are satisfied by their workspace's current version, engines.node is ` +
      `uniform, and the brace-expansion/minimatch/test-exclude override coupling holds.`,
  );
}

module.exports = {
  loadWorkspacePackages,
  loadRootOverrides,
  loadLockfilePackages,
  collectPinViolations,
  collectEnginesViolations,
  collectOverrideCouplingViolations,
  collectBraceExpansionCouplingViolations,
};

if (require.main === module) {
  main();
}
