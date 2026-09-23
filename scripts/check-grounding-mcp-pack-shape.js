#!/usr/bin/env node
/**
 * grounding-mcp packed-tarball entry-SHAPE check.
 *
 * Sibling to `check-grounding-mcp-pack.js` (which asserts the packed
 * tarball's served `--version` output matches its own package.json -- a
 * behavioral check). This one asserts a purely structural property of the
 * SAME tarball: it ships exactly `package.json`, `README.md`,
 * `CHANGELOG.md`, optionally `LICENSE`, and its built `dist/` output (at
 * least one entry required), and nothing else at the top level, nothing
 * under `src/`, and no test file (a name containing `.test.` or `.spec.`,
 * living under a `test/`/`tests/`/`__tests__/` directory). Nothing
 * previously asserted this: a `files` regression (e.g. accidentally adding
 * `"src"`, or a build that silently stopped emitting `dist/`) would ship
 * the wrong tarball unnoticed.
 *
 * Uses `npm pack --dry-run --json -w @lannguyensi/grounding-mcp` (like
 * `check-package-license.js`'s pack-entry guard): reports the real file
 * list a publish would ship, without leaving a tarball on disk. This CLI
 * call itself does not require a prior build (`npm pack --dry-run` reports
 * whatever `dist/` currently contains, including nothing), but the shape
 * assertions below DO require one: the "at least one dist/ entry" check
 * fails red when `dist/` is empty or missing, which is why this check runs
 * after the CI job's Build step (see its own ci.yml step comment).
 *
 * Usage: `node scripts/check-grounding-mcp-pack-shape.js` (wired as
 * `check:grounding-mcp-pack-shape`). Exits non-zero and prints the
 * offending entries on failure.
 */
'use strict';

const { execFileSync } = require('child_process');

const PACKAGE_NAME = '@lannguyensi/grounding-mcp';
const REQUIRED_ENTRIES = ['package.json', 'README.md', 'CHANGELOG.md'];
// Top-level entries this tarball is allowed to ship, beyond `dist/**`
// (checked separately: at least one dist/ entry is required below).
const ALLOWED_TOP_LEVEL_ENTRIES = ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE'];

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
  if (segments.includes('test') || segments.includes('tests') || segments.includes('__tests__')) return true;
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
  let hasDistEntry = false;
  for (const entryPath of paths) {
    const isSrc = entryPath === 'src' || entryPath.startsWith('src/');
    const isDist = entryPath === 'dist' || entryPath.startsWith('dist/');
    if (isSrc) {
      violations.push(`ships source entry "${entryPath}" (src/ must not be published)`);
    }
    if (isTestFilePath(entryPath)) {
      violations.push(`ships test entry "${entryPath}"`);
    }
    if (isDist) {
      hasDistEntry = true;
    } else if (!isSrc && !ALLOWED_TOP_LEVEL_ENTRIES.includes(entryPath)) {
      violations.push(
        `ships unexpected top-level entry "${entryPath}" (allowed: ${ALLOWED_TOP_LEVEL_ENTRIES.join(', ')}, dist/**)`,
      );
    }
  }
  if (!hasDistEntry) {
    violations.push('ships no dist/ entry (built output missing: run the build before packing)');
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
