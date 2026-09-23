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
 *   1. Parse `CHANGELOG.md`'s `## [Unreleased]` section. If the heading is
 *      missing entirely, the package is skipped (nothing to check: there is
 *      no unreleased section to have gone stale). If the section has any
 *      non-blank content, the package is skipped: a pointer to a
 *      non-empty `[Unreleased]` section is not dangling.
 *   2. Otherwise (the section exists and is empty), resolve the package's
 *      SHIPPED file set from its own `package.json` `files` array --
 *      never a hard-coded list -- expanding any directory entry
 *      (e.g. `dist`) to every file under it. A package with no `files`
 *      field ships everything not excluded by `.npmignore`; this check
 *      only scans the package's known kinds in that case (README.md,
 *      CHANGELOG.md, and any `dist/` directory that exists on disk), since
 *      walking the whole package tree would over-scan.
 *   3. Within that shipped set, scan: `README.md`, `CHANGELOG.md` (prose
 *      only -- the `## [Unreleased]` heading line itself is expected and
 *      excluded), and every `dist/**\/*.js` / `dist/**\/*.d.ts` file, for the
 *      literal substring `[Unreleased]`. Any hit is a violation: a pointer
 *      into a section that ships empty.
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

const UNRELEASED_HEADING_RE = /^##\s*\[Unreleased\]\s*$/;
const NEXT_HEADING_RE = /^##\s/;
const POINTER_TEXT = '[Unreleased]';

/** Reads every `packages/*\/package.json` under `rootDir` and returns
 * `{ name, dir, private, files }` entries. Skips a workspace dir with no
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
      files: Array.isArray(pkg.files) ? pkg.files : null,
    });
  }
  return workspaces;
}

function isPublishable(pkg) {
  return !pkg.private;
}

/** Returns `{ present, empty }` for a CHANGELOG.md's own `## [Unreleased]`
 * section: `present` is false when no such heading exists at all;
 * `empty` is true when the heading exists and every line up to the next
 * `## ` heading (or EOF) is blank. */
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
  return { present: true, empty: body.trim().length === 0 };
}

/** Recursively lists every file under `dir` (absolute paths), skipping
 * nothing (a package's `dist/` is not expected to carry symlinks or
 * ignorable junk). Returns `[]` when `dir` does not exist. */
function listFilesRecursive(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) stack.push(path.join(current, entry));
    } else if (stat.isFile()) {
      out.push(current);
    }
  }
  return out;
}

/** Resolves the package's shipped file set from its `package.json` `files`
 * array (each entry expanded to every file under it, if it's a directory,
 * or itself, if it's a file that exists) as absolute paths. When `files`
 * is null, falls back to the package's own README.md/CHANGELOG.md plus
 * any on-disk `dist/` directory. */
function resolveShippedFiles(pkg) {
  const entries = pkg.files ?? ['README.md', 'CHANGELOG.md', 'dist'];
  const out = [];
  for (const entry of entries) {
    const abs = path.join(pkg.dir, entry);
    if (!fs.existsSync(abs)) continue;
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      out.push(...listFilesRecursive(abs));
    } else if (stat.isFile()) {
      out.push(abs);
    }
  }
  return out;
}

/** True when `absPath` is one of the file kinds this check scans:
 * README.md, CHANGELOG.md, or a `dist/**\/*.js`|`*.d.ts` file. */
function isScannedKind(absPath, pkgDir) {
  const rel = path.relative(pkgDir, absPath);
  const basename = path.basename(absPath);
  if (basename === 'README.md' || basename === 'CHANGELOG.md') return true;
  if (rel.split(path.sep)[0] === 'dist' && (absPath.endsWith('.js') || absPath.endsWith('.d.ts'))) return true;
  return false;
}

/** Scans one shipped file's text for a dangling `[Unreleased]` pointer.
 * For `CHANGELOG.md`, the `## [Unreleased]` heading line itself is
 * stripped first (it is expected, even while the section is empty). */
function findPointerHit(absPath) {
  let text = fs.readFileSync(absPath, 'utf8');
  if (path.basename(absPath) === 'CHANGELOG.md') {
    text = text
      .split('\n')
      .filter((line) => !UNRELEASED_HEADING_RE.test(line))
      .join('\n');
  }
  return text.includes(POINTER_TEXT);
}

/** Full check for one package. Returns an array of violation objects
 * `{ consumer, file }` (empty when clean or not applicable). */
function collectPackageViolations(pkg) {
  const changelogPath = path.join(pkg.dir, 'CHANGELOG.md');
  if (!fs.existsSync(changelogPath)) return [];
  const state = readUnreleasedSectionState(fs.readFileSync(changelogPath, 'utf8'));
  if (!state.present || !state.empty) return [];

  const violations = [];
  for (const absPath of resolveShippedFiles(pkg)) {
    if (!isScannedKind(absPath, pkg.dir)) continue;
    if (findPointerHit(absPath)) {
      violations.push({ consumer: pkg.name, file: path.relative(pkg.dir, absPath) });
    }
  }
  return violations;
}

function run(rootDir = path.join(__dirname, '..')) {
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
    violations.push(...collectPackageViolations(pkg));
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
  listFilesRecursive,
  resolveShippedFiles,
  isScannedKind,
  findPointerHit,
  collectPackageViolations,
  run,
};

if (require.main === module) {
  main();
}
