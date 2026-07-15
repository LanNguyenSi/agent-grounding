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
      dependencies: pkg.dependencies || {},
      devDependencies: pkg.devDependencies || {},
      peerDependencies: pkg.peerDependencies || {},
      optionalDependencies: pkg.optionalDependencies || {},
    });
  }
  return workspaces;
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

function formatViolation(violation) {
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

  const violations = collectPinViolations(workspaces);

  if (violations.length > 0) {
    console.error(`Pin consistency check failed (${violations.length} violation(s)):\n`);
    for (const violation of violations) {
      console.error(formatViolation(violation));
    }
    console.error(
      '\nBump the offending pin to match the sibling workspace version (or bump the ' +
        'sibling workspace version so the existing pin is satisfied again).',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `Pin consistency check passed: ${workspaces.length} workspace package(s), all internal ` +
      `${INTERNAL_SCOPE_PREFIX}* pins are satisfied by their workspace's current version.`,
  );
}

module.exports = { loadWorkspacePackages, collectPinViolations };

if (require.main === module) {
  main();
}
