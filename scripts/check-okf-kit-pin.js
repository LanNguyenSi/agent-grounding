#!/usr/bin/env node
/**
 * okf-kit pin-coupling check.
 *
 * Multiple workflows independently `npm install -g okf-kit@<version>`:
 * `.github/workflows/okf-staleness.yml` (warn-only sources-fresh drift
 * watch) and `.github/workflows/ci.yml` (the `okf-anchor-guard` job's
 * red-on-drift citation guard) both do today; nothing coupled those pins
 * together, or would notice a THIRD workflow gaining its own independent
 * (and possibly diverging) pin later. Bumping one workflow's version
 * string without the others would leave them silently checking the
 * docs/okf bundle against different okf-kit behaviors (e.g. a
 * citation-anchor rule added in one release but not the other) with no CI
 * signal that they had drifted apart. This mirrors check-pins.js's own
 * reason for existing (internal `@lannguyensi/*` version pins can drift
 * the same silent way), just for an external tool pin instead of a
 * workspace dependency.
 *
 * This script globs every `.github/workflows/*.yml` file (not a hardcoded
 * two-file list -- a future third workflow that starts pinning okf-kit is
 * automatically in scope), reads out EVERY `npm install -g okf-kit@X.Y.Z`
 * line in each (plain regex, not a YAML parser -- see
 * check-okf-test-citation-shape.js's docblock for why this repo avoids the
 * js-yaml dependency in a check that should run without `npm ci`; a
 * workflow could in principle carry more than one such line, e.g. a matrix
 * job or a duplicated step, so this checks EVERY occurrence, not just the
 * first), and asserts every occurrence found, across every file, pins the
 * identical version -- including two differing occurrences inside the SAME
 * file, not just across files.
 */
const fs = require('fs');
const path = require('path');

const WORKFLOWS_DIR = '.github/workflows';
// Requires a real semver-shaped version (digits.digits.digits, optional
// prerelease/build suffix) immediately after `okf-kit@`, not a bare `\S+` --
// a bare `\S+` would also match this SCRIPT's own descriptive comments that
// mention the literal string `okf-kit@...` (e.g. this file's header, or a
// workflow comment describing what this check does) as if they were real
// pin lines. Anchored so it only matches inside an actual `npm install`
// invocation, not an arbitrary mention of the package name elsewhere.
const PIN_RE = /npm install -g okf-kit@(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/g;

/** Every `.github/workflows/*.yml` file under `rootDir`, repo-relative,
 * sorted. Fails loud (throws) if the directory itself doesn't exist --
 * mirrors check-deps.js's "fail loud, not vacuously green" stance for a
 * renamed/missing workflows dir; `run()` below turns that into a
 * violation rather than an uncaught exception. */
function listWorkflowFiles(rootDir) {
  const dir = path.join(rootDir, WORKFLOWS_DIR);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .sort()
    .map((f) => path.join(WORKFLOWS_DIR, f));
}

/** Reads `relPath` under `rootDir` and returns `{ ok: true, content }` or
 * `{ ok: false, code }` -- readFileSync's own thrown error is caught here
 * (not left to crash the whole check) so an unreadable file (permissions,
 * a race with something deleting it, a symlink loop) becomes a named
 * violation instead of an uncaught exception. */
function readWorkflowFile(rootDir, relPath) {
  try {
    return { ok: true, content: fs.readFileSync(path.join(rootDir, relPath), 'utf8') };
  } catch (err) {
    return { ok: false, code: err.code ?? String(err) };
  }
}

/** Every `npm install -g okf-kit@X.Y.Z` version string found in `content`,
 * in the order they appear (0, 1, or more per file). */
function extractPins(content) {
  const versions = [];
  const re = new RegExp(PIN_RE.source, 'g');
  let m;
  while ((m = re.exec(content)) !== null) versions.push(m[1]);
  return versions;
}

/** Pure core: given `occurrences` (a flat list of `{ file, version }`, one
 * per `npm install -g okf-kit@...` line found across every workflow file,
 * possibly several per file) and `unreadable` (a list of `{ file, code }`
 * for any workflow file that could not be read), returns a violations
 * array. Empty means every occurrence found pins the identical version and
 * no file was unreadable. */
function collectPinCouplingViolations(occurrences, unreadable = []) {
  const violations = [];
  for (const u of unreadable) {
    violations.push({ reason: 'unreadable-file', file: u.file, code: u.code });
  }
  if (occurrences.length === 0) {
    // Fail loud rather than vacuously pass: if NOTHING pins okf-kit
    // anywhere (every workflow file renamed/rewritten away from it), this
    // check would otherwise silently stop checking anything at all.
    violations.push({ reason: 'zero-pins-found' });
    return violations;
  }
  const distinct = [...new Set(occurrences.map((o) => o.version))];
  if (distinct.length > 1) {
    violations.push({ reason: 'version-mismatch', occurrences });
  }
  return violations;
}

function formatViolation(v) {
  if (v.reason === 'unreadable-file') {
    return `  - ${v.file} could not be read (${v.code}).`;
  }
  if (v.reason === 'zero-pins-found') {
    return (
      '  - 0 "npm install -g okf-kit@X.Y.Z" lines found across any .github/workflows/*.yml file. ' +
      'Expected at least one (okf-staleness.yml and ci.yml both pin it today).'
    );
  }
  const list = v.occurrences.map((o) => `${o.file}=${o.version}`).join(', ');
  return `  - okf-kit pin mismatch: ${list}. Keep every "npm install -g okf-kit@..." pin identical, including within the same file.`;
}

function run(rootDir = path.join(__dirname, '..')) {
  let files;
  try {
    files = listWorkflowFiles(rootDir);
  } catch (err) {
    console.error(
      `okf-kit pin-coupling check failed: could not list ${WORKFLOWS_DIR}/ (${err.code ?? err}).`,
    );
    return 1;
  }

  const occurrences = [];
  const unreadable = [];
  for (const file of files) {
    const read = readWorkflowFile(rootDir, file);
    if (!read.ok) {
      unreadable.push({ file, code: read.code });
      continue;
    }
    for (const version of extractPins(read.content)) {
      occurrences.push({ file, version });
    }
  }

  const violations = collectPinCouplingViolations(occurrences, unreadable);

  if (violations.length > 0) {
    console.error(`okf-kit pin-coupling check failed (${violations.length} violation(s)):\n`);
    for (const v of violations) console.error(formatViolation(v));
    return 1;
  }

  console.log(
    `okf-kit pin-coupling check passed: ${occurrences.length} pin occurrence(s) across ` +
      `${files.length} workflow file(s), all okf-kit@${occurrences[0].version}.`,
  );
  return 0;
}

function main() {
  process.exitCode = run();
}

module.exports = {
  WORKFLOWS_DIR,
  PIN_RE,
  listWorkflowFiles,
  readWorkflowFile,
  extractPins,
  collectPinCouplingViolations,
  run,
};

if (require.main === module) {
  main();
}
