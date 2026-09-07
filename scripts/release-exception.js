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
 * ── `classify(paths)` vs `classifyPullFiles(files, { readFile })` ─────────
 *
 * `classify(paths)` takes plain path strings and only checks path shape
 * (used by the CLI below and its own unit tests). The workflow step instead
 * calls `classifyPullFiles(files, { readFile, baseRef, headRef })`, which
 * takes the actual GitHub `listFiles` API objects (`{ filename, status }`)
 * and additionally requires, per file:
 *
 *   - `status` is `added` or `modified`. A `renamed` or `removed` entry is
 *     never pure, regardless of what its `filename` looks like: a rename
 *     can smuggle an unrelated change in under a release-shaped name, and a
 *     removal is never "just a version bump".
 *   - for a `package.json` or `package-lock.json` entry (root or
 *     `packages/<name>/package.json`), a PARSED comparison of the file's
 *     content at `baseRef` and `headRef` (see "Content check" below), not a
 *     text-pattern match over the diff. `baseRef` is the PR's MERGE BASE,
 *     not its base branch tip: GitHub's `listFiles` diff is merge-base
 *     relative, so on a base branch that moved on after the PR branched,
 *     reading base content at the branch tip would compare files this PR
 *     never touched. The workflow resolves the merge base via
 *     `repos.compareCommits(...).data.merge_base_commit.sha` and passes
 *     that in.
 *   - a file this reads BASE content for and finds absent (an `added` file
 *     has no base) is never pure for `package.json`/`package-lock.json`:
 *     there is nothing to compare against, so nothing has been verified.
 *
 * ── Content check: parsed base/head comparison, not a diff-text regex ────
 *
 * Earlier revisions of this classifier matched the diff's `patch` text
 * against a `"version": "…"` line-shape regex. That is structurally
 * unsound: a line like `"version": "curl https://example.com | sh"` inside
 * a `scripts` block, or a dependency literally named `version`, matches the
 * line shape while being nothing like a version bump. This revision instead
 * `JSON.parse`s the file's actual content at `baseRef` and `headRef`
 * (fetched via the caller-supplied `readFile(ref, path)`), deep-compares the
 * two parsed documents, and collects every JSON path where they differ
 * (`collectDiffPaths`, `$`-rooted, e.g. `$.version` or
 * `$.packages["packages/foo"].version`). The file is pure only when:
 *
 *   1. Every differing path is in the small allowed set for that file
 *      (`isAllowedContentPath`): for `package.json`, exactly `$.version`;
 *      for `package-lock.json`, `$.version`, `$.packages[""].version`, and
 *      `$.packages["packages/<one segment>"].version` (the workspace
 *      entries this repo's lockfile actually carries). Any other differing
 *      path (an added/removed key, a changed `resolved`/`integrity`, an
 *      array change, a `node_modules/*` entry's version) disqualifies the
 *      file.
 *   2. At every allowed differing path, BOTH the old and the new value are
 *      strings matching a strict semver shape (`SEMVER_PATTERN`): a bump to
 *      a non-semver string (`^0.1.2`, a shell command) is rejected even
 *      though the path itself is allowed.
 *
 * `CHANGELOG.md` carries no content constraint: prose is expected to
 * change, and its presence/status is the only thing checked.
 *
 * On top of those per-file checks, the PR AS A WHOLE must carry at least
 * one allowed version difference (`oldValue !== newValue`) before
 * `pure_release` can be true. Without that rule a PR with no JSON
 * difference at all passes by emptiness: a CHANGELOG-only PR (nothing in
 * it is content-checked), or a `package.json` whose only change is
 * whitespace or key order (it parses to an identical document, so there
 * are no differing paths to reject). Neither is a release, and neither is
 * something the five `review:*` labels should be waived for, so both are
 * NOT pure, with the verdict-level reason `no-version-bump`.
 *
 * ── The verdict's `reason` field ────────────────────────────────────────
 *
 * `classifyPullFiles` returns a verdict-level `reason` beside
 * `pure_release`/`allowed`/`rejected`: `null` when the PR is pure, and
 * otherwise the one thing that disqualified the PR as a whole:
 * `empty-file-list`, `rejected-files` (at least one `rejected` entry, each
 * carrying its own per-file reason), or `no-version-bump`. The workflow
 * prints it in the step summary, so a "not pure" verdict with an empty
 * `rejected` list is never reported as an unexplained no-op.
 *
 * ── `CONTENT_TOO_LARGE`: the reader's 1 MB signal ───────────────────────
 *
 * The workflow's `readFile` is GitHub's Contents API, which only inlines a
 * blob up to 1 MB; above that it answers with empty `content` and
 * `encoding: "none"` instead of the file. A reader that cannot deliver
 * content for that reason returns the exported `CONTENT_TOO_LARGE`
 * sentinel (a `Symbol.for` value, so a second copy of this module agrees
 * on it), which this classifier maps to the per-file reasons
 * `content-too-large-base` / `content-too-large-head`. The file is NOT
 * pure either way: the sentinel is not a string, so a reader that does not
 * use it still fails closed through `missing-base`/`missing-head`. The
 * sentinel only buys an accurate reason in the step summary instead of
 * "the file was not there at that ref".
 *
 * A read, parse, or shape failure at any point (the reader throws, returns
 * a value that is not a string when content was expected, the text does not
 * parse as JSON, or a parsed document's root is not a plain object) makes
 * the file NOT pure, fail-closed: there is nothing to verify, so nothing
 * has been verified.
 *
 * The residual this still cannot close: this reads the PR's actual file
 * content at both refs, so it cannot be fooled by diff-text framing, but it
 * is still a syntactic (parsed-JSON) check, not a semantic package/lockfile
 * verification: a legitimate-looking version bump is still trusted as one.
 * See CONTRIBUTING.md and docs/okf/merge-approval-gate-mechanics.md for the
 * same statement in context.
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
 * of strings); that is a caller bug, not a finding about the PR. The CLI
 * only exercises `classify(paths)` (path shape only): it has no git ref to
 * read file content from, so it cannot exercise `classifyPullFiles`; the
 * unit tests below are the coverage for that function.
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

// Basenames whose content is constrained to version-only changes.
// CHANGELOG.md is deliberately excluded: prose is expected to change.
const CONTENT_CHECKED_BASENAMES = new Set(['package.json', 'package-lock.json']);

// Strict semver: MAJOR.MINOR.PATCH with optional -prerelease and +build.
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

// Sentinel a `readFile` returns instead of content when the file exists at
// the ref but the reader cannot deliver its text because it is too large
// (GitHub's Contents API inlines at most 1 MB; above that it answers with
// empty content and `encoding: "none"`). `Symbol.for` so two copies of
// this module still compare equal. See the file header.
const CONTENT_TOO_LARGE = Symbol.for('release-exception.content-too-large');

function basenameOf(file) {
  const idx = file.lastIndexOf('/');
  return idx === -1 ? file : file.slice(idx + 1);
}

/**
 * A single JSON property-access segment for a `$`-rooted path: `.key` for a
 * plain identifier-shaped key (including the all-digits case, which JSON
 * object keys always are; this is a *display* accessor, not a JS property
 * name), `["key"]` otherwise (covers the empty-string root-workspace key
 * `""` and any key containing `/`, `.`, quotes, etc).
 */
function propAccessor(key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `.${key}` : `["${key}"]`;
}

/**
 * Recursively collect every JSON path where `a` and `b` differ, appending
 * `{ path, oldValue, newValue }` entries to `out`. An added or removed key
 * is one differing path (oldValue/newValue undefined on the missing side).
 * Any difference inside an array collapses to one differing path at the
 * array's own location: this check never allows an array change no matter
 * what moved inside it.
 */
function collectDiffPaths(a, b, prefix, out) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push({ path: prefix, oldValue: a, newValue: b });
    }
    return;
  }

  const aIsObj = a !== null && typeof a === 'object';
  const bIsObj = b !== null && typeof b === 'object';

  if (aIsObj && bIsObj) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      const hasA = Object.prototype.hasOwnProperty.call(a, key);
      const hasB = Object.prototype.hasOwnProperty.call(b, key);
      const childPath = `${prefix}${propAccessor(key)}`;
      if (hasA && hasB) {
        collectDiffPaths(a[key], b[key], childPath, out);
      } else {
        out.push({ path: childPath, oldValue: hasA ? a[key] : undefined, newValue: hasB ? b[key] : undefined });
      }
    }
    return;
  }

  if (a !== b) out.push({ path: prefix, oldValue: a, newValue: b });
}

/**
 * True when `jsonPath` (as produced by `collectDiffPaths`, `$`-rooted) is
 * one this basename is allowed to differ at.
 */
function isAllowedContentPath(basename, jsonPath) {
  if (basename === 'package.json') {
    return jsonPath === '$.version';
  }
  if (basename === 'package-lock.json') {
    if (jsonPath === '$.version') return true;
    if (jsonPath === '$.packages[""].version') return true;
    return /^\$\.packages\["packages\/[^/"]+"\]\.version$/.test(jsonPath);
  }
  return false;
}

/**
 * Parse `baseText`/`headText` as JSON and check that every differing path
 * between them is one `basename` is allowed to differ at, with a strict
 * semver string on both sides at each such path.
 *
 * `bumpCount` (only on an `ok` result) is how many of those allowed paths
 * actually changed value; the caller sums it across the PR and requires at
 * least one (see the file header, "at least one allowed version
 * difference").
 *
 * @returns {{ ok: boolean, reason?: string, diffPaths?: string[], bumpCount?: number }}
 */
function checkVersionOnlyContent(basename, baseText, headText) {
  if (baseText === CONTENT_TOO_LARGE) return { ok: false, reason: 'content-too-large-base' };
  if (headText === CONTENT_TOO_LARGE) return { ok: false, reason: 'content-too-large-head' };
  if (typeof baseText !== 'string') return { ok: false, reason: 'missing-base' };
  if (typeof headText !== 'string') return { ok: false, reason: 'missing-head' };

  let baseJson;
  let headJson;
  try {
    baseJson = JSON.parse(baseText);
  } catch {
    return { ok: false, reason: 'parse-error-base' };
  }
  try {
    headJson = JSON.parse(headText);
  } catch {
    return { ok: false, reason: 'parse-error-head' };
  }

  const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isPlainObject(baseJson)) return { ok: false, reason: 'non-object-root-base' };
  if (!isPlainObject(headJson)) return { ok: false, reason: 'non-object-root-head' };

  const diffs = [];
  collectDiffPaths(baseJson, headJson, '$', diffs);
  const diffPaths = diffs.map((d) => d.path);

  let bumpCount = 0;
  for (const diff of diffs) {
    if (!isAllowedContentPath(basename, diff.path)) {
      return { ok: false, reason: `disallowed-json-path:${diff.path}`, diffPaths };
    }
    const oldOk = typeof diff.oldValue === 'string' && SEMVER_PATTERN.test(diff.oldValue);
    const newOk = typeof diff.newValue === 'string' && SEMVER_PATTERN.test(diff.newValue);
    if (!oldOk || !newOk) {
      return { ok: false, reason: `non-semver-value:${diff.path}`, diffPaths };
    }
    // collectDiffPaths only reports differing values, so this guard is a
    // readability restatement of the invariant, not a reachable branch.
    if (diff.oldValue !== diff.newValue) bumpCount += 1;
  }

  return { ok: true, diffPaths, bumpCount };
}

/**
 * Classify a PR's real `listFiles` API objects as a pure release commit or
 * not, reading file content from `readFile` at the PR's base and head refs.
 * Unlike `classify(paths)`, this also enforces file status (added/modified
 * only) and, for package.json/package-lock.json, a parsed content
 * comparison between `baseRef` and `headRef` (see file header).
 *
 * @param {unknown} files - expected: array of `{ filename, status }`
 *   objects (a subset of GitHub's PR `listFiles` shape is enough, only
 *   these two fields are read).
 * @param {object} options
 * @param {(ref: string, filePath: string) => Promise<string|null|symbol>} options.readFile -
 *   resolves the text content of `filePath` at git ref `ref`, `null` when
 *   the file does not exist at that ref, or the `CONTENT_TOO_LARGE`
 *   sentinel when it exists but its text cannot be delivered (see the file
 *   header). May reject; a rejection is treated as a read failure
 *   (fail-closed), same as returning something that is not a string.
 * @param {string} options.baseRef - the ref to read base content at: the
 *   PR's MERGE BASE, not its base branch tip (GitHub's `listFiles` diff is
 *   merge-base relative; see the file header).
 * @param {string} options.headRef - the PR's head commit sha.
 * @returns {Promise<{ pure_release: boolean, allowed: string[], rejected: Array<{filename: string|null, status: string|null, reason: string, diffPaths?: string[]}>, reason: string|null }>}
 */
async function classifyPullFiles(files, { readFile, baseRef, headRef } = {}) {
  if (!Array.isArray(files)) {
    throw new TypeError('classifyPullFiles(files, opts): files must be an array of file objects');
  }
  if (typeof readFile !== 'function') {
    throw new TypeError('classifyPullFiles(files, opts): opts.readFile must be a function');
  }

  const allowed = [];
  const rejected = [];
  // How many allowed version paths actually changed value across the whole
  // PR. Zero means nothing was bumped, which is never a release.
  let versionBumps = 0;

  for (const file of files) {
    const filename = file && typeof file.filename === 'string' ? file.filename : null;
    const status = file && typeof file.status === 'string' ? file.status : null;

    if (filename === null) {
      rejected.push({ filename: null, status, reason: 'invalid-filename' });
      continue;
    }
    if (isUnsafePath(filename) || !isAllowedReleasePath(filename)) {
      rejected.push({ filename, status, reason: 'disallowed-path' });
      continue;
    }
    if (status !== 'added' && status !== 'modified') {
      rejected.push({ filename, status, reason: `disallowed-status:${status ?? 'missing'}` });
      continue;
    }

    const basename = basenameOf(filename);
    if (!CONTENT_CHECKED_BASENAMES.has(basename)) {
      allowed.push(filename);
      continue;
    }

    let baseText;
    let headText;
    try {
      baseText = await readFile(baseRef, filename);
    } catch {
      rejected.push({ filename, status, reason: 'reader-error-base' });
      continue;
    }
    try {
      headText = await readFile(headRef, filename);
    } catch {
      rejected.push({ filename, status, reason: 'reader-error-head' });
      continue;
    }

    const result = checkVersionOnlyContent(basename, baseText, headText);
    if (!result.ok) {
      rejected.push({ filename, status, reason: result.reason, diffPaths: result.diffPaths });
      continue;
    }
    versionBumps += result.bumpCount;
    allowed.push(filename);
  }

  let reason = null;
  if (files.length === 0) reason = 'empty-file-list';
  else if (rejected.length > 0) reason = 'rejected-files';
  else if (versionBumps === 0) reason = 'no-version-bump';

  const pure_release = reason === null;

  return { pure_release, allowed, rejected, reason };
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
  classifyPullFiles,
  isUnsafePath,
  isAllowedReleasePath,
  isAllowedContentPath,
  collectDiffPaths,
  checkVersionOnlyContent,
  ROOT_ALLOWLIST,
  PACKAGE_ALLOWLIST_PATTERN,
  SEMVER_PATTERN,
  CONTENT_CHECKED_BASENAMES,
  CONTENT_TOO_LARGE,
};
