#!/usr/bin/env node
/**
 * Release-exception classifier.
 *
 * `.github/workflows/merge-approval.yml` normally requires four of its five
 * `review:*` labels (plus `review:evidence-logged` or a committed evidence
 * file) before the `merge-approval` Check-Run flips to ALLOWED. A pure
 * version-bump release PR (only `package.json` / `package-lock.json` /
 * `CHANGELOG.md` change) still has to go through a full label round even
 * though there is nothing in it a human reviewer meaningfully checks beyond
 * "is this really just the version bump". This script gives the workflow a
 * narrow, data-driven way to answer that question from the PR's REAL changed
 * -file list, so it can OR a `pure_release` signal into the five booleans
 * instead of widening what the labels mean.
 *
 * This module is intentionally dependency-free (house style: see
 * check-pins.js / check-deps.js / check-lockfile-integrity.js) and exports a
 * pure `classify(files)` function so the workflow's `actions/github-script`
 * step and this file's own unit tests exercise exactly the same code path,
 * `require()`d directly by the workflow step via an absolute path built from
 * `GITHUB_WORKSPACE`, not shelled out to.
 *
 * ── The allowlist is DATA, not a heuristic ─────────────────────────────
 *
 * Exactly five path *shapes* count as "release-only":
 *
 *   - `package.json`               (root)
 *   - `package-lock.json`          (root)
 *   - `CHANGELOG.md`               (root)
 *   - `packages/<one segment>/package.json`
 *   - `packages/<one segment>/CHANGELOG.md`
 *
 * Nothing else. In particular this deliberately does NOT allow `src/**`,
 * `docs/okf/**`, `README.md`, or any workflow file: a release PR that also
 * touches a version constant in source (e.g. `packages/grounding-mcp/
 * src/server.ts`, see PR #215) or re-stamps an OKF doc's `timestamp:`
 * front-matter is disqualified on purpose and falls back to the normal
 * label path; see CONTRIBUTING.md's "Cutting a release" section for why
 * those two cases in particular are common and are NOT bugs in this
 * allowlist.
 *
 * A nested package path (`packages/a/b/package.json`) does not match: only
 * exactly one path segment is allowed between `packages/` and the file
 * name, matching this repo's actual `packages/*` layout (no nested
 * sub-packages exist or are supported by the workspace glob in the root
 * `package.json`).
 *
 * An empty file list is NOT pure: there is nothing to look at, so there is
 * nothing to have verified. See CONTRIBUTING.md's "Cutting a release"
 * section and docs/okf/merge-approval-gate-mechanics.md.
 *
 * ── Path safety ─────────────────────────────────────────────────────────
 *
 * Any path that is absolute (starts with `/`) or contains a `..` segment is
 * rejected outright: it can never be one of the five allowed shapes above,
 * and treating it as such would be a mistake regardless of the exact
 * string. GitHub's PR "changed files" API only ever returns repo-relative
 * paths with no `..`, but a defensive check costs nothing and covers a
 * malformed/adversarial caller.
 *
 * ── CLI ─────────────────────────────────────────────────────────────────
 *
 * Two equivalent input styles, matching house style: either pass the file
 * paths as argv positionals, or (when no positionals are given) pipe a JSON
 * array of strings on stdin. The verdict is always printed as one JSON line
 * on stdout and the process exits 0: the verdict IS the answer, both
 * "pure" and "not pure" are successful classifications, not failures. The
 * process exits non-zero (1) only when the input itself could not be
 * parsed as a file list at all (invalid JSON, or JSON that is not an array
 * of strings); that is a caller bug, not a finding about the PR.
 */

'use strict';

const path = require('node:path');

const ROOT_ALLOWLIST = Object.freeze([
  'package.json',
  'package-lock.json',
  'CHANGELOG.md',
]);

// Exactly one path segment between `packages/` and the file name.
const PACKAGE_ALLOWLIST_PATTERN = /^packages\/[^/]+\/(package\.json|CHANGELOG\.md)$/;

/**
 * True when `file` is an absolute path or contains a `..` traversal
 * segment. Such a path is always rejected regardless of the allowlist.
 */
function isUnsafePath(file) {
  if (typeof file !== 'string' || file.length === 0) return true;
  if (file.startsWith('/')) return true;
  if (path.posix.isAbsolute(file)) return true;
  return file.split('/').includes('..');
}

/**
 * True when `file` is exactly one of the release-only path shapes.
 * Callers should check `isUnsafePath` first; this function does not
 * re-derive path safety beyond what the regex/equality checks imply.
 */
function isAllowedReleasePath(file) {
  if (ROOT_ALLOWLIST.includes(file)) return true;
  return PACKAGE_ALLOWLIST_PATTERN.test(file);
}

/**
 * Classify a list of changed file paths as a pure release commit or not.
 *
 * @param {unknown} files - expected: array of repo-relative path strings.
 * @returns {{ pure_release: boolean, allowed: string[], rejected: string[] }}
 */
function classify(files) {
  if (!Array.isArray(files)) {
    throw new TypeError('classify(files): files must be an array of strings');
  }

  const allowed = [];
  const rejected = [];

  for (const file of files) {
    if (isUnsafePath(file) || !isAllowedReleasePath(file)) {
      rejected.push(file);
    } else {
      allowed.push(file);
    }
  }

  const pure_release = files.length > 0 && rejected.length === 0;

  return { pure_release, allowed, rejected };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const argv = process.argv.slice(2);
  let files;

  if (argv.length > 0) {
    files = argv;
  } else {
    const raw = (await readStdin()).trim();
    if (raw === '') {
      files = [];
    } else {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        process.stderr.write(
          `release-exception: malformed input on stdin, expected a JSON array of file path strings: ${err.message}\n`,
        );
        process.exitCode = 1;
        return;
      }
      if (!Array.isArray(parsed) || !parsed.every((p) => typeof p === 'string')) {
        process.stderr.write(
          'release-exception: malformed input on stdin, expected a JSON array of strings\n',
        );
        process.exitCode = 1;
        return;
      }
      files = parsed;
    }
  }

  const verdict = classify(files);
  process.stdout.write(`${JSON.stringify(verdict)}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`release-exception: unexpected error: ${err.stack || err}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  classify,
  isUnsafePath,
  isAllowedReleasePath,
  ROOT_ALLOWLIST,
  PACKAGE_ALLOWLIST_PATTERN,
};
