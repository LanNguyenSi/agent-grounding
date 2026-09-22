#!/usr/bin/env node
/**
 * Package LICENSE check.
 *
 * Every publishable (`private` !== true) `packages/*` workspace member is
 * supposed to ship the repo's MIT LICENSE text inside its own published
 * tarball (task ae26b625: a copied file per package, not a prepack step, so
 * the merge-approval `pure_release` path, which classifies a release PR
 * purely from its changed-file list, see `scripts/release-exception.js`, and
 * the publish workflows stay untouched). Nothing previously asserted that
 * copy actually landed, or that it actually ships in the packed tarball; npm
 * auto-includes a `LICENSE` file that physically exists in a package
 * directory (it does not need to be listed in `files` to be included), so
 * the failure mode this guards is a genuinely MISSING or DIVERGED file, not
 * a `files` omission alone: the `files` check below exists only because
 * `files` documents intent and must stay accurate when it's set.
 *
 * Three independent checks per publishable package:
 *
 *   1. `packages/<name>/LICENSE` exists and is byte-identical to the repo
 *      root `LICENSE` (a raw Buffer comparison, not a text/whitespace-
 *      normalized one: "byte-identical" per the acceptance criterion).
 *   2. If that package's `package.json` declares a `files` array, it
 *      includes the literal string `"LICENSE"`.
 *   3. `npm pack --dry-run --json -w <name>` (run once per package, from the
 *      repo root, via the injectable `packFn` so tests never shell out for
 *      real) lists a `LICENSE` entry in its `files` array: this is the
 *      actual "does it ship" proof; (1) and (2) alone can't rule out an
 *      `.npmignore`, a case-sensitivity mismatch, or some other packaging
 *      quirk silently excluding it from the real tarball.
 *
 * Deliberately NOT run: a real (non-dry-run) `npm pack`, which would leave a
 * tarball on disk and requires the package to actually build; `--dry-run
 * --json` reports the same file list npm would pack without doing so, and
 * without requiring `dist/` to exist first (only what's *listed* is
 * inspected: an unbuilt `dist/` just packs fewer files, LICENSE ships
 * either way since it lives at the package root).
 *
 * Check 3 (the pack-entry guard) cannot fail independently of check 1 (the
 * on-disk LICENSE guard) under this repo's npm: on npm 11, across every
 * configuration tried (`files` set without LICENSE listed, an `.npmignore`
 * present with LICENSE on disk, both, neither), npm force-includes an
 * on-disk `LICENSE` in the packed file list regardless of `files` or
 * `.npmignore` content, so check 3 never independently discriminates a
 * violation check 1 would have missed. It stays as a pin against a future
 * npm packaging-rule change, not as evidence of present-day discriminating
 * power.
 *
 * Usage: `node scripts/check-package-license.js` (wired as the
 * `check:package-license` npm script). Exits non-zero and prints one line
 * per offending package + reason on failure. Also exits non-zero (instead of
 * vacuously passing) if zero publishable workspace packages are found,
 * mirroring check-pins.js's / check-deps.js's zero-workspace guard.
 *
 * ── Assumption: workspaces === packages/* ─────────────────────────────────
 *
 * This script (like check-pins.js and check-deps.js) hardcodes `packages/`
 * as the one and only workspace root, matching this repo's root
 * `package.json` `workspaces: ["packages/*\/"]` today. It does not read the
 * root `workspaces` field, so a second workspace glob added *alongside*
 * `packages/*\/` (e.g. `apps/*\/`) would silently go unchecked here. Unlike
 * check-deps.js, a missing `packages/` directory does NOT fail loudly with
 * an uncaught exception: `run()` catches the read failure and reports it as
 * a named violation (exit 1, readable message), because this check's own
 * `node --test` suite exercises `run()` against disposable temp roots that
 * intentionally omit `packages/`, and a real `npm pack --dry-run` call that
 * throws (a non-workspace `rootDir`, or any other npm-side error) is caught
 * the same way rather than crashing the process.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Reads every packages/*\/package.json under `rootDir` and returns an array
 * of `{ name, dir, private, files }` shapes. Skips any workspace directory
 * that has no package.json. `dir` is the package's absolute directory path.
 */
function loadWorkspacePackages(rootDir) {
  const packagesDir = path.join(rootDir, 'packages');
  const entries = fs.readdirSync(packagesDir, { withFileTypes: true });
  const workspaces = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(packagesDir, entry.name);
    const pkgJsonPath = path.join(dir, 'package.json');
    if (!fs.existsSync(pkgJsonPath)) continue;
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    workspaces.push({
      name: pkg.name,
      dir,
      private: pkg.private === true,
      files: Array.isArray(pkg.files) ? pkg.files : null,
    });
  }
  return workspaces;
}

/** Publishable === not explicitly marked `private: true`. */
function isPublishable(pkg) {
  return !pkg.private;
}

/**
 * Check 1: the package directory carries a `LICENSE` file, byte-identical to
 * `rootLicense` (a Buffer). A missing file and a diverged file are reported
 * as distinct reasons so the violation message is specific about the fix.
 *
 * Violations: { reason: 'license-missing', consumer }
 *             { reason: 'license-diverged', consumer }
 */
function collectMissingOrDivergedLicenseViolations(workspacePackages, rootLicense) {
  const violations = [];
  for (const pkg of workspacePackages.filter(isPublishable)) {
    const licensePath = path.join(pkg.dir, 'LICENSE');
    if (!fs.existsSync(licensePath)) {
      violations.push({ reason: 'license-missing', consumer: pkg.name });
      continue;
    }
    const packageLicense = fs.readFileSync(licensePath);
    if (!packageLicense.equals(rootLicense)) {
      violations.push({ reason: 'license-diverged', consumer: pkg.name });
    }
  }
  return violations;
}

/**
 * Check 2: when a publishable package's `package.json` declares a `files`
 * array at all, it must include `"LICENSE"`. A package with no `files` field
 * is not checked here: npm packs everything not excluded by `.npmignore`/
 * `.gitignore` in that case, `files` documents intent only when present.
 *
 * Violation: { reason: 'files-field-missing-license', consumer }
 */
function collectFilesFieldViolations(workspacePackages) {
  const violations = [];
  for (const pkg of workspacePackages.filter(isPublishable)) {
    if (pkg.files === null) continue;
    if (!pkg.files.includes('LICENSE')) {
      violations.push({ reason: 'files-field-missing-license', consumer: pkg.name });
    }
  }
  return violations;
}

/**
 * Real `packFn`: runs `npm pack --dry-run --json -w <name>` from `rootDir`
 * and returns the parsed single-package result object (`npm pack --json`
 * always returns a one-element array for a single `-w` target).
 */
function runNpmPackDryRun(pkgName, rootDir) {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '-w', pkgName], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(output);
  return parsed[0];
}

/**
 * Check 3: `npm pack --dry-run --json -w <name>`'s own reported file list
 * (the ground truth for what actually ships) must include a `LICENSE`
 * entry. `packFn` is injectable so tests can exercise this against a stub
 * instead of shelling out to real npm for every fixture case; it defaults to
 * `runNpmPackDryRun`.
 *
 * Violation: { reason: 'pack-entry-missing-license', consumer }
 */
function collectPackEntryViolations(workspacePackages, rootDir, packFn = runNpmPackDryRun) {
  const violations = [];
  for (const pkg of workspacePackages.filter(isPublishable)) {
    const result = packFn(pkg.name, rootDir);
    const paths = (result && Array.isArray(result.files) ? result.files : []).map((f) => f.path);
    if (!paths.includes('LICENSE')) {
      violations.push({ reason: 'pack-entry-missing-license', consumer: pkg.name });
    }
  }
  return violations;
}

function formatViolation(violation) {
  if (violation.reason === 'license-missing') {
    return `  - ${violation.consumer} has no LICENSE file in its package directory.`;
  }
  if (violation.reason === 'license-diverged') {
    return `  - ${violation.consumer}'s LICENSE file is not byte-identical to the repo root LICENSE.`;
  }
  if (violation.reason === 'files-field-missing-license') {
    return `  - ${violation.consumer}'s package.json declares a "files" array that does not include "LICENSE".`;
  }
  if (violation.reason === 'pack-entry-missing-license') {
    return `  - ${violation.consumer}'s \`npm pack --dry-run --json\` file list does not include a LICENSE entry.`;
  }
  return `  - ${violation.consumer}: unrecognized violation reason "${violation.reason}".`;
}

/**
 * CLI core: runs every LICENSE check against `rootDir` and returns the
 * process exit code, printing findings along the way. Extracted from main()
 * so tests can exercise the vacuous-green guard and exit codes against
 * disposable root directories, and inject a stub `packFn` to avoid shelling
 * out to real npm. `rootDir` defaults to this script's own repo root,
 * matching main()'s prior behavior.
 */
function run(rootDir = path.join(__dirname, '..'), packFn = runNpmPackDryRun) {
  let workspaces;
  try {
    workspaces = loadWorkspacePackages(rootDir);
  } catch (err) {
    console.error(
      `Package LICENSE check failed: could not read the packages/ workspace directory under ${rootDir} ` +
        `(${err.message}).`,
    );
    return 1;
  }
  const publishable = workspaces.filter(isPublishable);

  if (publishable.length === 0) {
    // Fail loudly instead of vacuously passing (mirrors check-pins.js's /
    // check-deps.js's zero-workspace guard). If every package were ever
    // marked private, or packages/ were renamed/emptied, silently reporting
    // success here would disable this CI gate without anyone noticing.
    console.error(
      'Package LICENSE check failed: found 0 publishable (private !== true) workspace packages under ' +
        'packages/. Expected at least one; packages/ exists but contains no non-private package.json (renamed, ' +
        'emptied, or all marked private?).',
    );
    return 1;
  }

  const rootLicensePath = path.join(rootDir, 'LICENSE');
  if (!fs.existsSync(rootLicensePath)) {
    console.error(`Package LICENSE check failed: no root LICENSE file found at ${rootLicensePath}.`);
    return 1;
  }
  const rootLicense = fs.readFileSync(rootLicensePath);

  let packEntryViolations;
  try {
    packEntryViolations = collectPackEntryViolations(workspaces, rootDir, packFn);
  } catch (err) {
    console.error(
      `Package LICENSE check failed: \`npm pack --dry-run\` reporting failed for a publishable workspace ` +
        `package under ${rootDir} (${err.message}).`,
    );
    return 1;
  }

  const violations = [
    ...collectMissingOrDivergedLicenseViolations(workspaces, rootLicense),
    ...collectFilesFieldViolations(workspaces),
    ...packEntryViolations,
  ];

  if (violations.length > 0) {
    console.error(`Package LICENSE check failed (${violations.length} violation(s)):\n`);
    for (const violation of violations) {
      console.error(formatViolation(violation));
    }
    console.error(
      '\nCopy the repo root LICENSE into the offending package directory (byte-identical), add "LICENSE" to ' +
        'its package.json "files" array where that field is set, and re-run.',
    );
    return 1;
  }

  console.log(
    `Package LICENSE check passed: ${publishable.length} publishable workspace package(s) each carry a ` +
      `LICENSE file byte-identical to the repo root LICENSE, list it in "files" where that field is set, and ` +
      `ship it in their packed tarball.`,
  );
  return 0;
}

function main() {
  process.exitCode = run();
}

module.exports = {
  loadWorkspacePackages,
  isPublishable,
  collectMissingOrDivergedLicenseViolations,
  collectFilesFieldViolations,
  collectPackEntryViolations,
  runNpmPackDryRun,
  run,
};

if (require.main === module) {
  main();
}
