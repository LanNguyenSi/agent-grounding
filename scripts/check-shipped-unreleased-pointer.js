#!/usr/bin/env node
/**
 * Shipped `[Unreleased]` pointer check.
 *
 * A release cut moves the `## [Unreleased]` section's notes under a new
 * dated heading and leaves `## [Unreleased]` empty. Any file that SHIPS in
 * the package's npm tarball and still says something like "see CHANGELOG
 * [Unreleased]" now points at nothing. Task d51ae64b found this several
 * ways across one cut and this check's own build-out: the README, a
 * comment in `dist/ow-run-completeness.js` (carried over from a source
 * comment -- tsc keeps comments in emitted JS/d.ts), and a package's
 * ROADMAP.md that shipped alongside its README and CHANGELOG. Chasing
 * each kind one at a time (README, then dist/*.js and dist/*.d.ts, then
 * more dist extensions) kept missing the next one -- a shipped file of
 * yet another kind (ROADMAP.md, a shipped docs/*.md, ...) always stayed
 * invisible to a per-kind allowlist -- so this check drops the per-kind
 * allowlist entirely: it now scans every shipped TEXT file, so a new file
 * kind cannot silently opt out of scanning by not yet being named here.
 *
 * For every publishable (`private` !== true) `packages/*` workspace member:
 *
 *   1. Decide whether the package's `[Unreleased]` state counts as
 *      "effectively empty": true when there is no `CHANGELOG.md` at all,
 *      when it has no `## [Unreleased]` heading at all (bracketless
 *      `## Unreleased` counts as the same heading, case-insensitively), or
 *      when the heading exists but its body -- after stripping `### <Kind>`
 *      sub-headings and HTML comments, which carry no release notes of
 *      their own -- is blank. A package whose section genuinely has content
 *      is skipped entirely: a pointer into it is not dangling, and its
 *      shipped file set is never even resolved (no `npm pack` call for it).
 *   2. Otherwise, resolve the package's SHIPPED file set the same way `npm
 *      publish` would, via `npm pack --dry-run --json -w <name>` (never a
 *      hard-coded list, and never a naive read of `package.json`'s `files`
 *      field by hand): this follows npm's own README always-included rule,
 *      globs, and negations. The pack lister is injectable (`packFn`) so
 *      unit tests do not need a real `npm pack` for every case. The pack
 *      result is held to a COVERAGE INVARIANT before it is trusted (see
 *      `loadPackedFileList`): an empty result, a result missing
 *      `package.json` or `README.md`, packFn throwing, or packFn returning
 *      something that is not a file-path array all fail the check loudly
 *      and by name, rather than being silently treated as "nothing to
 *      scan" (a coverage-shrinkage bug an earlier build-out of this check
 *      had: a malformed/empty pack result passed vacuously).
 *   3. Within that shipped set, scan every file EXCEPT `package.json`,
 *      `LICENSE*`/`LICENCE*`, and a fixed, explicit list of binary
 *      extensions (images, fonts, archives, `.node`, `.wasm` -- see
 *      `BINARY_EXTENSIONS`): so a shipped README, CHANGELOG, ROADMAP, any
 *      other shipped `*.md`, and every shipped `dist/**` file (`.js`,
 *      `.d.ts`, `.mjs`, `.cjs`, whatever a build emits) are all scanned by
 *      default, not by an allowlist of kinds this check happened to have
 *      already seen. `CHANGELOG.md` alone additionally gets two
 *      CHANGELOG-specific exclusions applied before the text is searched
 *      (see `findPointerHit`): its own `[Unreleased]` heading line (always
 *      present, even while the section is empty -- not a dangling pointer
 *      into itself) and a genuine keep-a-changelog link-reference line
 *      (`[Unreleased]: <url>`). Neither exclusion applies to any other
 *      shipped file kind: a README or ROADMAP line that merely LOOKS like a
 *      changelog link reference (no URL) is prose, and is scanned like any
 *      other line.
 *      Any hit -- the literal substring `[Unreleased]` or the bracketless,
 *      capitalised, word-bounded label `Unreleased` (e.g. "(Unreleased)",
 *      "see the Unreleased section") -- is a violation: a pointer into a
 *      section that ships empty.
 *
 * Usage: `node scripts/check-shipped-unreleased-pointer.js` (wired as
 * `check:shipped-unreleased-pointer`). Exits non-zero and prints one line
 * per offending package + file on failure, or one named coverage-invariant
 * error. Also exits non-zero if zero publishable workspace packages are
 * found (mirrors check-package-license.js's zero-workspace guard: a
 * renamed/emptied packages/ must not silently pass).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const UNRELEASED_HEADING_RE = /^##\s*\[?unreleased\]?\s*$/i;
const NEXT_HEADING_RE = /^##\s/;
const SUBSECTION_HEADING_RE = /^###\s/;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
// Requires an actual URL (or an absolute/relative path) after the colon, so
// a prose line that merely LOOKS like a keep-a-changelog link reference
// (e.g. "[Unreleased]: see the next release") is NOT excluded from the
// pointer scan: an earlier, URL-less shape excluded it, producing a false
// negative (task d51ae64b).
const LINK_REF_RE = /^\[Unreleased\]:\s*(https?:\/\/|\.{0,2}\/)\S*/i;
const BRACKETED_POINTER_RE = /\[Unreleased\]/;
const BAREWORD_POINTER_RE = /\bUnreleased\b/;

// Explicit, small binary-extension exclusion (task d51ae64b):
// everything else shipped is treated as scannable text.
// Kept deliberately short -- this repo's packages ship JS/TS build output
// and docs, not media -- rather than trying to be an exhaustive MIME table.
const BINARY_EXTENSIONS = new Set([
  // images
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.avif', '.svg',
  // fonts
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  // archives
  '.zip', '.tar', '.gz', '.tgz', '.br', '.7z', '.rar',
  // native/compiled build artifacts
  '.node', '.wasm',
]);

class CoverageInvariantError extends Error {}

/** Reads every `packages/*\/package.json` under `rootDir` and returns
 * `{ name, dir, private }` entries. Skips a workspace dir with no
 * package.json. */
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
    });
  }
  return workspaces;
}

function isPublishable(pkg) {
  return !pkg.private;
}

/** Strips HTML comments (including multi-line ones) and `### <Kind>`
 * sub-heading lines out of a section body: neither carries release-note
 * content of its own, so a body left with only those is still empty. */
function stripNonContentNoise(bodyText) {
  const withoutComments = bodyText.replace(HTML_COMMENT_RE, '');
  return withoutComments
    .split('\n')
    .filter((line) => !SUBSECTION_HEADING_RE.test(line))
    .join('\n');
}

/** Returns `{ present, empty }` for a CHANGELOG.md's own `[Unreleased]`
 * section: `present` is false when no such heading exists at all (matched
 * case-insensitively, brackets optional: `## Unreleased` and `## unreleased`
 * both count); `empty` is true when the heading exists and its body, once
 * `### <Kind>` sub-headings and HTML comments are stripped out, is blank
 * up to the next `## ` heading (or EOF). */
function readUnreleasedSectionState(changelogText) {
  const lines = changelogText.split('\n');
  let idx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (UNRELEASED_HEADING_RE.test(lines[i])) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return { present: false, empty: false };
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i += 1) {
    if (NEXT_HEADING_RE.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines.slice(idx + 1, end).join('\n');
  const meaningful = stripNonContentNoise(body);
  return { present: true, empty: meaningful.trim().length === 0 };
}

/** True when the package's `[Unreleased]` state should be treated like an
 * empty section for this check's purposes: no CHANGELOG.md at all, no
 * `[Unreleased]` heading in it, or a heading whose body is blank (see
 * `readUnreleasedSectionState`). This is deliberately broader than "the
 * heading exists and is empty": a package that ships a pointer with
 * nothing backing it (no CHANGELOG, or no heading at all) is just as
 * dangling as one whose section was emptied by a release cut. */
function isUnreleasedEffectivelyEmpty(changelogPath) {
  if (!fs.existsSync(changelogPath)) return true;
  const state = readUnreleasedSectionState(fs.readFileSync(changelogPath, 'utf8'));
  if (!state.present) return true;
  return state.empty;
}

/** Real `packFn`: runs `npm pack --dry-run --json -w <name>` from
 * `rootDir` and returns the packed tarball's entry paths (relative to the
 * package root), the same list `npm publish` would actually ship --
 * README always included, `files` globs and `.npmignore`/`!` negations
 * already resolved by npm itself. Lets a JSON-parse failure or a missing
 * result propagate as a thrown error: `loadPackedFileList` turns that into
 * a named coverage-invariant failure rather than a raw stack trace. */
function runNpmPackDryRun(pkgName, rootDir) {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '-w', pkgName], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(output);
  const result = parsed[0];
  if (!result || !Array.isArray(result.files)) {
    throw new Error('npm pack --dry-run --json returned no parseable file list');
  }
  return result.files.map((f) => f.path);
}

/** Reads the literal (non-glob, non-negated) entries of `pkg`'s own
 * package.json `files` field: no `*`, `?`, `[`, `{` glob characters, and
 * not prefixed with `!` (a negation narrows what a glob already selected,
 * it is not a coverage requirement of its own). Returns `[]` -- meaning
 * "nothing more to require" -- when `pkg.dir` is unset, its package.json
 * cannot be read or parsed, or it has no `files` field at all: this
 * function only ever ADDS a stricter coverage check on top of the
 * package.json/README.md check above, never replaces it. */
function readLiteralFilesFieldEntries(pkg) {
  if (!pkg || !pkg.dir) return [];
  let raw;
  try {
    raw = fs.readFileSync(path.join(pkg.dir, 'package.json'), 'utf8');
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const files = Array.isArray(parsed.files) ? parsed.files : [];
  return files.filter(
    (entry) => typeof entry === 'string' && !entry.startsWith('!') && !/[*?[{]/.test(entry),
  );
}

/** Resolves and validates `pkg`'s packed file-path list via `packFn`
 * (default: real `npm pack --dry-run --json`, injectable for tests).
 * Enforces the coverage invariant: a publishable
 * package's shipped-file scan must never silently shrink to "nothing to
 * check". Throws `CoverageInvariantError` (message has no stack trace
 * attached by the caller) when `packFn` throws, returns something that is
 * not an array of paths, returns an empty array, or returns a list missing
 * `package.json` or `README.md` -- every real npm-published package ships
 * both, so their absence means the pack listing itself cannot be trusted. */
function loadPackedFileList(pkg, rootDir, packFn) {
  let relPaths;
  try {
    relPaths = packFn(pkg.name, rootDir);
  } catch (err) {
    throw new CoverageInvariantError(
      `pack listing for ${pkg.name} threw (${err.message}); cannot verify its shipped file set`,
    );
  }
  if (!Array.isArray(relPaths)) {
    throw new CoverageInvariantError(
      `pack listing for ${pkg.name} returned unparsable output (expected an array of file paths, got ${typeof relPaths})`,
    );
  }
  if (relPaths.length === 0) {
    throw new CoverageInvariantError(
      `pack listing for ${pkg.name} is empty; a publishable package must ship at least package.json and README.md`,
    );
  }
  if (!relPaths.includes('package.json')) {
    throw new CoverageInvariantError(`pack listing for ${pkg.name} does not include package.json`);
  }
  if (!relPaths.includes('README.md')) {
    throw new CoverageInvariantError(`pack listing for ${pkg.name} does not include README.md`);
  }
  for (const entry of readLiteralFilesFieldEntries(pkg)) {
    const normalized = entry.replace(/\/+$/, '');
    const matched = relPaths.some((p) => p === normalized || p.startsWith(`${normalized}/`));
    if (!matched) {
      throw new CoverageInvariantError(
        `pack listing for ${pkg.name} does not include its package.json "files" entry "${entry}" ` +
          `(expected "${normalized}" or "${normalized}/..."); build the package before running this check`,
      );
    }
  }
  return relPaths;
}

/** Resolves the package's shipped file set (absolute paths, files only),
 * via `loadPackedFileList`. A relative path `npm pack` reports that no
 * longer exists on disk is skipped rather than erroring: `npm pack
 * --dry-run` reflects the working tree, so this should not normally
 * happen, but a stale report must not crash the check. */
function resolveShippedFiles(pkg, rootDir, packFn = runNpmPackDryRun) {
  const relPaths = loadPackedFileList(pkg, rootDir, packFn);
  const out = [];
  for (const rel of relPaths) {
    const abs = path.join(pkg.dir, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) out.push(abs);
  }
  return out;
}

// Exact license filenames (any casing, US/UK spelling, .md/.txt or bare):
// LICENSE, LICENCE, LICENSE.md, LICENSE.txt, and so on.
const LICENSE_FILE_RE = /^licen[cs]e(\.(md|txt))?$/i;
// LICENSE-MIT / LICENSE.MIT style variants: a license basename followed by a
// `-` or `.` separator and more characters. This alone is too broad -- it
// would also match a real shipped script like `license-policy.js` -- so it
// only counts as a license file below when its extension is not one of the
// code extensions this check actually cares about scanning.
const LICENSE_VARIANT_RE = /^licen[cs]e[-.][a-z0-9.-]*$/i;
const CODE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx']);

/** True when `basename` is a real license file: an exact LICENSE/LICENCE
 * name (optionally `.md`/`.txt`), or a LICENSE-MIT-style variant whose
 * extension is not a code extension. A basename like `license-policy.js`
 * is NOT a license file by this rule -- it is a real shipped script that
 * merely starts with the word "license" -- and IS still scanned. */
function isLicenseFile(basename) {
  if (LICENSE_FILE_RE.test(basename)) return true;
  if (LICENSE_VARIANT_RE.test(basename)) {
    const ext = path.extname(basename).toLowerCase();
    if (!CODE_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

/** True when `absPath` is excluded from the shipped-text scan:
 * `package.json`, a real license file (see `isLicenseFile`), or a binary
 * extension (see `BINARY_EXTENSIONS`). Everything else shipped is
 * scanned -- this is deliberately NOT an allowlist of known-good kinds
 * (see this file's docblock). */
function isExcludedShippedFile(absPath) {
  const basename = path.basename(absPath);
  if (basename === 'package.json') return true;
  if (isLicenseFile(basename)) return true;
  const ext = path.extname(absPath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/** Scans one shipped file's text for a dangling `[Unreleased]` pointer,
 * either the bracketed literal or the bracketless, capitalised,
 * word-bounded label. For `CHANGELOG.md` ONLY, two lines are stripped
 * first, since neither is a dangling pointer into the section: the
 * `[Unreleased]` heading line itself (expected, even while the section is
 * empty), and a genuine keep-a-changelog link-reference line
 * (`[Unreleased]: <url>`, matched only when it actually looks like a URL
 * or path -- see `LINK_REF_RE`). Neither exclusion is applied to any other
 * shipped file: a README/ROADMAP/other file's own heading- or
 * link-reference-shaped line is prose, not a changelog convention, and is
 * scanned like any other line in that file. */
function findPointerHit(absPath) {
  const isChangelog = path.basename(absPath) === 'CHANGELOG.md';
  const text = fs
    .readFileSync(absPath, 'utf8')
    .split('\n')
    .filter((line) => {
      if (!isChangelog) return true;
      if (UNRELEASED_HEADING_RE.test(line)) return false;
      if (LINK_REF_RE.test(line.trim())) return false;
      return true;
    })
    .join('\n');
  return BRACKETED_POINTER_RE.test(text) || BAREWORD_POINTER_RE.test(text);
}

/** Full check for one package. Returns `{ violations, scannedCount }`:
 * `violations` is `{ consumer, file }[]` (empty when clean or not
 * applicable -- the package's Unreleased section is not effectively
 * empty, in which case `packFn` is never called for it at all);
 * `scannedCount` is how many shipped files were actually text-scanned
 * (0 when the package was skipped). Throws `CoverageInvariantError` (see
 * `loadPackedFileList`) when the package needs scanning but its pack
 * listing cannot be trusted. */
function collectPackageViolations(pkg, rootDir, packFn) {
  const changelogPath = path.join(pkg.dir, 'CHANGELOG.md');
  if (!isUnreleasedEffectivelyEmpty(changelogPath)) return { violations: [], scannedCount: 0 };

  const violations = [];
  let scannedCount = 0;
  for (const absPath of resolveShippedFiles(pkg, rootDir, packFn)) {
    if (isExcludedShippedFile(absPath)) continue;
    scannedCount += 1;
    if (findPointerHit(absPath)) {
      violations.push({ consumer: pkg.name, file: path.relative(pkg.dir, absPath) });
    }
  }
  return { violations, scannedCount };
}

function run(rootDir = path.join(__dirname, '..'), packFn = runNpmPackDryRun) {
  let workspaces;
  try {
    workspaces = loadWorkspacePackages(rootDir);
  } catch (err) {
    console.error(
      `Shipped-[Unreleased]-pointer check failed: could not read packages/ under ${rootDir} (${err.message}).`,
    );
    return 1;
  }
  const publishable = workspaces.filter(isPublishable);
  if (publishable.length === 0) {
    console.error(
      'Shipped-[Unreleased]-pointer check failed: found 0 publishable (private !== true) workspace packages ' +
        'under packages/. Expected at least one.',
    );
    return 1;
  }

  const violations = [];
  const scannedCounts = [];
  for (const pkg of publishable) {
    let result;
    try {
      result = collectPackageViolations(pkg, rootDir, packFn);
    } catch (err) {
      if (err instanceof CoverageInvariantError) {
        console.error(`Shipped-[Unreleased]-pointer check failed: coverage invariant violated: ${err.message}.`);
        return 1;
      }
      throw err;
    }
    violations.push(...result.violations);
    if (result.scannedCount > 0) scannedCounts.push({ name: pkg.name, count: result.scannedCount });
  }

  if (violations.length > 0) {
    console.error(`Shipped-[Unreleased]-pointer check failed (${violations.length} violation(s)):\n`);
    for (const v of violations) {
      console.error(`  - ${v.consumer}: ${v.file} points at CHANGELOG.md's [Unreleased] section, which is empty.`);
    }
    console.error(
      '\nEither give the [Unreleased] section content, or remove/update the dangling pointer in the shipped file.',
    );
    return 1;
  }

  const countsSummary = scannedCounts.length > 0
    ? ` (${scannedCounts.map((s) => `${s.name}: ${s.count} file(s) scanned`).join(', ')})`
    : ' (none needed scanning: every Unreleased section already has content)';
  console.log(
    `Shipped-[Unreleased]-pointer check passed: ${publishable.length} publishable workspace package(s) checked${countsSummary}; ` +
      'no dangling [Unreleased] pointer found in a shipped file while its CHANGELOG.md Unreleased section is empty.',
  );
  return 0;
}

function main() {
  process.exitCode = run();
}

module.exports = {
  CoverageInvariantError,
  loadWorkspacePackages,
  isPublishable,
  readUnreleasedSectionState,
  isUnreleasedEffectivelyEmpty,
  runNpmPackDryRun,
  readLiteralFilesFieldEntries,
  loadPackedFileList,
  resolveShippedFiles,
  isExcludedShippedFile,
  findPointerHit,
  collectPackageViolations,
  run,
};

if (require.main === module) {
  main();
}
