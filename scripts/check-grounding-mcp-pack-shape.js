#!/usr/bin/env node
/**
 * grounding-mcp packed-tarball entry-SHAPE check.
 *
 * Sibling to `check-grounding-mcp-pack.js` (which asserts the packed
 * tarball's served `--version` output matches its own package.json -- a
 * behavioral check). This one asserts a purely structural property of the
 * SAME tarball: it ships exactly `package.json`, `README.md`,
 * `CHANGELOG.md`, and its built `dist/` output, and nothing under `src/`
 * and no test file (a name containing `.test.` or `.spec.`, or living under
 * a `test/`/`tests/` directory). Nothing previously asserted this: a
 * `files` regression (e.g. accidentally adding `"src"`) would ship the
 * package's TypeScript sources in the published npm tarball unnoticed.
 *
 * Uses `npm pack --dry-run --json -w @lannguyensi/grounding-mcp` (like
 * `check-package-license.js`'s pack-entry guard): reports the real file
 * list a publish would ship, without requiring a build or leaving a
 * tarball on disk.
 *
 * Usage: `node scripts/check-grounding-mcp-pack-shape.js` (wired as
 * `check:grounding-mcp-pack-shape`). Exits non-zero and prints the
 * offending entries on failure.
 */
'use strict';

const { execFileSync } = require('child_process');

const PACKAGE_NAME = '@lannguyensi/grounding-mcp';
const REQUIRED_ENTRIES = ['package.json', 'README.md', 'CHANGELOG.md'];

/** Real `packFn`: runs `npm pack --dry-run --json -w <name>` from
 * `rootDir` and returns the parsed single-package result object. */
function runNpmPackDryRun(pkgName, rootDir) {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '-w', pkgName], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(output);
  return parsed[0];
}

/** True when `entryPath` (a pack-reported relative file path) is a test
 * file: `.test.` or `.spec.` in the basename, or living under a
 * `test/`/`tests/` directory anywhere in the path. */
function isTestFilePath(entryPath) {
  const segments = entryPath.split('/');
  if (segments.includes('test') || segments.includes('tests')) return true;
  const basename = segments[segments.length - 1];
  return /\.(test|spec)\./.test(basename);
}

/**
 * Evaluates one pack result's `files` array (`[{ path }]` entries, as
 * `npm pack --json` reports them) against the shape requirements. Returns
 * `{ ok, violations }`; `violations` is a list of human-readable strings.
 */
function evaluatePackShape(paths) {
  const violations = [];
  for (const required of REQUIRED_ENTRIES) {
    if (!paths.includes(required)) violations.push(`missing required entry "${required}"`);
  }
  for (const entryPath of paths) {
    if (entryPath === 'src' || entryPath.startsWith('src/')) {
      violations.push(`ships source entry "${entryPath}" (src/ must not be published)`);
    }
    if (isTestFilePath(entryPath)) {
      violations.push(`ships test entry "${entryPath}"`);
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * CLI core. `packFn` is injectable so tests can exercise this against a
 * stub pack result instead of shelling out to real npm.
 */
function run(rootDir = require('path').join(__dirname, '..'), packFn = runNpmPackDryRun) {
  let result;
  try {
    result = packFn(PACKAGE_NAME, rootDir);
  } catch (err) {
    console.error(`grounding-mcp pack-shape check failed: \`npm pack --dry-run\` failed (${err.message}).`);
    return 1;
  }

  const paths = (result && Array.isArray(result.files) ? result.files : []).map((f) => f.path);
  if (paths.length === 0) {
    console.error('grounding-mcp pack-shape check failed: `npm pack --dry-run --json` reported no files.');
    return 1;
  }

  const { ok, violations } = evaluatePackShape(paths);
  if (!ok) {
    console.error(`grounding-mcp pack-shape check failed (${violations.length} violation(s)):\n`);
    for (const v of violations) console.error(`  - ${v}`);
    return 1;
  }

  console.log(
    `grounding-mcp pack-shape check passed: packed tarball ships package.json, README.md, CHANGELOG.md, and ` +
      `${paths.length} total entr${paths.length === 1 ? 'y' : 'ies'}, none under src/ and none a test file.`,
  );
  return 0;
}

function main() {
  process.exitCode = run();
}

module.exports = {
  PACKAGE_NAME,
  REQUIRED_ENTRIES,
  runNpmPackDryRun,
  isTestFilePath,
  evaluatePackShape,
  run,
};

if (require.main === module) {
  main();
}
