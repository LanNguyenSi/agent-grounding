#!/usr/bin/env node
/**
 * okf-kit pin-coupling check.
 *
 * Two workflows independently `npm install -g okf-kit@<version>`:
 * `.github/workflows/okf-staleness.yml` (warn-only sources-fresh drift
 * watch) and `.github/workflows/ci.yml` (the `okf-anchor-guard` job's
 * red-on-drift citation guard). Nothing coupled the two pins together --
 * bumping one workflow's version string without the other would leave them
 * silently checking the docs/okf bundle against two different okf-kit
 * behaviors (e.g. a citation-anchor rule added in one release but not the
 * other) with no CI signal that they had drifted apart. This mirrors
 * check-pins.js's own reason for existing (internal `@lannguyensi/*`
 * version pins can drift the same silent way), just for an external tool
 * pin instead of a workspace dependency.
 *
 * This script reads the `npm install -g okf-kit@X.Y.Z` line out of both
 * workflow files (plain regex, not a YAML parser -- see check-okf-anchors.js
 * for why this repo avoids the js-yaml dependency in a check that should
 * run without `npm ci`) and asserts both versions are present and equal.
 */
const fs = require('fs');
const path = require('path');

const WORKFLOW_FILES = ['.github/workflows/okf-staleness.yml', '.github/workflows/ci.yml'];
const PIN_RE = /npm install -g okf-kit@(\S+)/;

/** Extracts the pinned okf-kit version from `relPath` under `rootDir`, or
 * `null` if the file has no `npm install -g okf-kit@...` line at all. */
function extractPin(rootDir, relPath) {
  const abs = path.join(rootDir, relPath);
  const content = fs.readFileSync(abs, 'utf8');
  const m = content.match(PIN_RE);
  return m ? m[1] : null;
}

/** Pure core: given `{ file, version }` entries (one per workflow file,
 * `version` possibly `null` when the file has no pin line at all), returns
 * a violations array. Empty means every workflow that pins okf-kit pins the
 * same version. */
function collectPinCouplingViolations(pins) {
  const violations = [];
  for (const p of pins) {
    if (p.version === null) {
      violations.push({ reason: 'missing-pin', file: p.file });
    }
  }
  const found = pins.filter((p) => p.version !== null).map((p) => p.version);
  const distinct = [...new Set(found)];
  if (distinct.length > 1) {
    violations.push({ reason: 'version-mismatch', versions: pins });
  }
  return violations;
}

function formatViolation(v) {
  if (v.reason === 'missing-pin') {
    return `  - ${v.file} has no "npm install -g okf-kit@X.Y.Z" line to check.`;
  }
  const list = v.versions.map((p) => `${p.file}=${p.version ?? '(none)'}`).join(', ');
  return `  - okf-kit pin mismatch across workflows: ${list}. Keep every "npm install -g okf-kit@..." pin identical.`;
}

function run(rootDir = path.join(__dirname, '..')) {
  const pins = WORKFLOW_FILES.map((file) => ({ file, version: extractPin(rootDir, file) }));
  const violations = collectPinCouplingViolations(pins);

  if (violations.length > 0) {
    console.error(`okf-kit pin-coupling check failed (${violations.length} violation(s)):\n`);
    for (const v of violations) console.error(formatViolation(v));
    return 1;
  }

  const version = pins.find((p) => p.version !== null)?.version;
  console.log(
    `okf-kit pin-coupling check passed: ${WORKFLOW_FILES.length} workflow(s) all pin okf-kit@${version}.`,
  );
  return 0;
}

function main() {
  process.exitCode = run();
}

module.exports = {
  WORKFLOW_FILES,
  PIN_RE,
  extractPin,
  collectPinCouplingViolations,
  run,
};

if (require.main === module) {
  main();
}
