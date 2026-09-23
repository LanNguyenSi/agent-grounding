#!/usr/bin/env node
/**
 * Shipped `[Unreleased]` pointer check.
 *
 * A release cut moves the `## [Unreleased]` section's notes under a new
 * dated heading and leaves `## [Unreleased]` empty. Any file that SHIPS in
 * the package's npm tarball and still says something like "see CHANGELOG
 * [Unreleased]" now points at nothing: the README, and any dist comment
 * carried over from a source comment (tsc keeps comments in emitted JS/d.ts),
 * are the two kinds task d51ae64b actually found (the grounding-mcp 0.11.0
 * README, and a comment in `dist/ow-run-completeness.js` compiled from
 * `src/ow-run-completeness.ts`). Nothing mechanical caught either before
 * this check.
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
 *      is skipped: a pointer into it is not dangling.
 *   2. Otherwise, resolve the package's SHIPPED file set the same way `npm
 *      publish` would, via `npm pack --dry-run --json -w <name>` (never a
 *      hard-coded list, and never a naive read of `package.json`'s `files`
 *      field by hand): this follows npm's own README always-included rule,
 *      globs, and negations. The pack lister is injectable (`packFn`) so
 *      unit tests do not need a real `npm pack` for every case.
 *   3. Within that shipped set, scan: `README.md`, `CHANGELOG.md` (prose
 *      only -- the `[Unreleased]` heading line itself is expected and
 *      excluded, as is any keep-a-changelog link-reference line like
 *      `[Unreleased]: https://...`), and every shipped `dist/**` file whose
 *      extension is one tsc/build tooling actually emits comments into
 *      (`.js`, `.d.ts`, `.mjs`, `.cjs`, `.d.mts`, `.d.cts`), for either the
 *      literal substring `[Unreleased]` or the bracketless, capitalised,
 *      word-bounded label `Unreleased` (e.g. "(Unreleased)", "see the
 *      Unreleased section"). Any hit is a violation: a pointer into a
 *      section that ships empty.
 *
 * Usage: `node scripts/check-shipped-unreleased-pointer.js` (wired as
 * `check:shipped-unreleased-pointer`). Exits non-zero and prints one line
 * per offending package + file on failure. Also exits non-zero if zero
 * publishable workspace packages are found (mirrors check-package-license.js's
 * zero-workspace guard: a renamed/emptied packages/ must not silently pass).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const UNRELEASED_HEADING_RE = /^##\s*\[?unreleased\]?\s*$/i;
const NEXT_HEADING_RE = /^##\s/;
const SUBSECTION_HEADING_RE = /^###\s/;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const LINK_REF_RE = /^\[Unreleased\]:\s*\S+/i;
const BRACKETED_POINTER_RE = /\[Unreleased\]/;
const BAREWORD_POINTER_RE = /\bUnreleased\b/;
const DIST_SCANNED_EXTENSIONS = ['.d.mts', '.d.cts', '.d.ts', '.mjs', '.cjs', '.js'];

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
 * already resolved by npm itself. */
function runNpmPackDryRun(pkgName, rootDir) {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '-w', pkgName], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(output);
  const result = parsed[0];
  return (result && Array.isArray(result.files) ? result.files : []).map((f) => f.path);
}

/** Resolves the package's shipped file set (absolute paths, files only) via
 * `packFn` (default: real `npm pack --dry-run --json`, injectable for
 * tests). A relative path `npm pack` reports that no longer exists on disk
 * is skipped rather than erroring: `npm pack --dry-run` reflects the
 * working tree, so this should not normally happen, but a stale report
 * must not crash the check. */
function resolveShippedFiles(pkg, rootDir, packFn = runNpmPackDryRun) {
  const relPaths = packFn(pkg.name, rootDir);
  const out = [];
  for (const rel of relPaths) {
    const abs = path.join(pkg.dir, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) out.push(abs);
  }
  return out;
}

/** True when `absPath` is one of the file kinds this check scans:
 * README.md, CHANGELOG.md, or a `dist/**` file whose extension is one a
 * build carries source comments into (`.js`, `.d.ts`, `.mjs`, `.cjs`,
 * `.d.mts`, `.d.cts`). */
function isScannedKind(absPath, pkgDir) {
  const rel = path.relative(pkgDir, absPath);
  const basename = path.basename(absPath);
  if (basename === 'README.md' || basename === 'CHANGELOG.md') return true;
  if (rel.split(path.sep)[0] !== 'dist') return false;
  return DIST_SCANNED_EXTENSIONS.some((ext) => absPath.endsWith(ext));
}

/** Scans one shipped file's text for a dangling `[Unreleased]` pointer,
 * either the bracketed literal or the bracketless, capitalised,
 * word-bounded label. For `CHANGELOG.md`, the `[Unreleased]` heading line
 * itself and any keep-a-changelog `[Unreleased]: <url>` link-reference
 * line are stripped first: both are expected, even while the section is
 * empty, and neither is a dangling pointer into it. */
function findPointerHit(absPath) {
  const isChangelog = path.basename(absPath) === 'CHANGELOG.md';
  const text = fs
    .readFileSync(absPath, 'utf8')
    .split('\n')
    .filter((line) => {
      if (isChangelog && UNRELEASED_HEADING_RE.test(line)) return false;
      if (LINK_REF_RE.test(line.trim())) return false;
      return true;
    })
    .join('\n');
  return BRACKETED_POINTER_RE.test(text) || BAREWORD_POINTER_RE.test(text);
}

/** Full check for one package. Returns an array of violation objects
 * `{ consumer, file }` (empty when clean or not applicable). */
function collectPackageViolations(pkg, rootDir, packFn) {
  const changelogPath = path.join(pkg.dir, 'CHANGELOG.md');
  if (!isUnreleasedEffectivelyEmpty(changelogPath)) return [];

  const violations = [];
  for (const absPath of resolveShippedFiles(pkg, rootDir, packFn)) {
    if (!isScannedKind(absPath, pkg.dir)) continue;
    if (findPointerHit(absPath)) {
      violations.push({ consumer: pkg.name, file: path.relative(pkg.dir, absPath) });
    }
  }
  return violations;
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
  for (const pkg of publishable) {
    violations.push(...collectPackageViolations(pkg, rootDir, packFn));
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

  console.log(
    `Shipped-[Unreleased]-pointer check passed: ${publishable.length} publishable workspace package(s) carry ` +
      'no dangling [Unreleased] pointer in a shipped file while their CHANGELOG.md Unreleased section is empty.',
  );
  return 0;
}

function main() {
  process.exitCode = run();
}

module.exports = {
  loadWorkspacePackages,
  isPublishable,
  readUnreleasedSectionState,
  isUnreleasedEffectivelyEmpty,
  runNpmPackDryRun,
  resolveShippedFiles,
  isScannedKind,
  findPointerHit,
  collectPackageViolations,
  run,
};

if (require.main === module) {
  main();
}
