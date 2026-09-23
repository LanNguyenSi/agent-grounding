#!/usr/bin/env node
/**
 * CHANGELOG duplicate-subsection-heading check.
 *
 * A dated CHANGELOG section (`## <version>, <date>` or
 * `## [<version>] - <date>`) is supposed to carry each `### <Kind>` heading
 * (`### Added`, `### Changed`, `### Fixed`, ...) at most once: two separate
 * `### Added` blocks in the same dated section (grounding-mcp's 0.12.0 cut
 * did this for `### Added` and `### Changed`) means notes were split across
 * two places under the same heading, easy to miss when skimming a release.
 *
 * Scans every `CHANGELOG.md` under the repo root and each `packages/*`
 * workspace directory. Within each dated section (`## ...` matching either
 * date-heading shape, tolerating an en/em dash separator; a plain
 * `## [Unreleased]` heading is not dated and is not scanned), collects
 * every `### <Kind>` heading's exact trimmed text and flags any kind that
 * occurs more than once, UNLESS that exact `{ file, version, kind }` triple
 * is listed in `ALLOWLIST` below (or an injected allowlist, for tests) with
 * a reason (for a pre-existing violation this check should not force a
 * rewrite of old prose for -- see CONTRIBUTING.md and the task notes: none
 * exist in this repo as of this check's introduction, so the allowlist
 * starts empty).
 *
 * Also flags, separately and NOT allowlist-suppressible, any "## " heading
 * that looks version-shaped (a semver-like `X.Y.Z` token) but matches
 * neither the dated-section shape above nor the Unreleased heading (task
 * d51ae64b): leaving such a heading silently unscanned would let a real
 * duplicate ### heading inside it hide forever. See DATED_HEADING_RE's
 * docblock for which shapes are recognised vs. rejected.
 *
 * Usage: `node scripts/check-changelog-duplicate-headings.js` (wired as
 * `check:changelog-duplicate-headings`). Exits non-zero and prints one line
 * per offending `{ file, version, kind }` duplicate or ambiguous heading on
 * failure.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Matches "## 0.2.2, 2026-05-03", "## [0.2.2] - 2026-05-03", and the same
// two shapes with an en dash (\u2013) or em dash (\u2014) in place of the
// separator comma/hyphen (task d51ae64b). The plain ASCII hyphen was
// already matched as a separator before this check widened the class;
// en dash (\u2013) and em dash (\u2014) were not, so the lazy
// version-capture group ([^\],]+?) did not stop before one and absorbed
// it into the version key instead, e.g. "0.2.0" followed by the dash
// glyph rather than a clean "0.2.0" -- this broke ALLOWLIST version-key
// comparisons for the real packages/understanding-gate/CHANGELOG.md
// heading "## 0.2.0 \u2014 2026-05-02". Widening the separator character
// class to explicitly include \u2013/\u2014 lets the version capture stop
// cleanly before the dash glyph, so the version key comes out clean
// ("0.2.0").
const DATED_HEADING_RE = /^##\s+\[?([^\],]+?)\]?[,\s\u2013\u2014-]+\s*(\d{4}-\d{2}-\d{2})\s*$/;
const SUBSECTION_HEADING_RE = /^###\s+(.+?)\s*$/;
const ANY_TOP_HEADING_RE = /^##\s/;
const UNRELEASED_HEADING_RE = /^##\s*\[?unreleased\]?\s*$/i;
// A "## " heading that contains a semver-shaped token (e.g. "0.13.0") but
// matches neither DATED_HEADING_RE nor the Unreleased heading is ambiguous:
// it looks like a release section, but this check cannot tell which
// version/date it names, so any duplicate ### heading inside it would go
// unscanned. Decision (task d51ae64b): fail visibly instead
// of silently skipping it -- a release cut can trivially reformat the
// heading into one of the two supported shapes, whereas a silent skip lets
// a real duplicate hide forever. Only a parenthesised date
// ("## 0.13.0 (2026-10-01)") or a dated heading with trailing prose
// ("## 0.13.0, 2026-10-01 (yanked)") hit this path in practice: both are
// outside CONTRIBUTING.md's two documented shapes, so a human reformats
// the heading rather than this check guessing at its meaning.
const SEMVER_TOKEN_RE = /\d+\.\d+\.\d+/;

/**
 * Pre-existing violations this check does not force a rewrite of.
 * `{ file: repo-relative path, version: the dated heading's version token
 * as captured by DATED_HEADING_RE, kind: the exact trimmed ### heading
 * text, reason: string }`. Empty today: no known pre-existing duplicate
 * survives in this repo (verified when this check was introduced, task
 * d51ae64b).
 */
const ALLOWLIST = [];

/** `allowlist` is injectable (default: the module-level ALLOWLIST above) so
 * tests can prove the suppression path without editing the real list. */
function isAllowlisted(file, version, kind, allowlist = ALLOWLIST) {
  return allowlist.some((e) => e.file === file && e.version === version && e.kind === kind);
}

/** Finds every repo-relative CHANGELOG.md path this check scans: the root
 * one (if present) and every `packages/*\/CHANGELOG.md` (if present). */
function findChangelogPaths(rootDir) {
  const paths = [];
  if (fs.existsSync(path.join(rootDir, 'CHANGELOG.md'))) paths.push('CHANGELOG.md');
  const packagesDir = path.join(rootDir, 'packages');
  if (fs.existsSync(packagesDir)) {
    for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const rel = path.join('packages', entry.name, 'CHANGELOG.md');
      if (fs.existsSync(path.join(rootDir, rel))) paths.push(rel);
    }
  }
  return paths;
}

/**
 * Parses `text` (one CHANGELOG.md's content) and returns every dated
 * section's `{ version, kinds }`, where `kinds` is the ordered list of
 * every `### <Kind>` heading text found before the next `## ` heading.
 */
function parseDatedSections(text) {
  const lines = text.split('\n');
  const sections = [];
  let current = null;
  for (const line of lines) {
    const datedMatch = DATED_HEADING_RE.exec(line);
    if (datedMatch) {
      current = { version: datedMatch[1].trim(), kinds: [] };
      sections.push(current);
      continue;
    }
    if (ANY_TOP_HEADING_RE.test(line)) {
      current = null;
      continue;
    }
    if (current) {
      const subMatch = SUBSECTION_HEADING_RE.exec(line);
      if (subMatch) current.kinds.push(subMatch[1]);
    }
  }
  return sections;
}

/** Returns `[{ version, kind, count }]` for every kind that occurs more
 * than once within a single dated section, across `sections`. */
function findDuplicateKinds(sections) {
  const dupes = [];
  for (const section of sections) {
    const counts = new Map();
    for (const kind of section.kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
    for (const [kind, count] of counts) {
      if (count > 1) dupes.push({ version: section.version, kind, count });
    }
  }
  return dupes;
}

/** Returns the trimmed text of every "## " heading in `text` that looks
 * version-shaped (contains a semver-like `X.Y.Z` token) but is neither the
 * `[Unreleased]` heading nor recognised by DATED_HEADING_RE (see that
 * regex's docblock for why this fails visibly instead of being silently
 * skipped). */
function findAmbiguousHeadings(text) {
  const ambiguous = [];
  for (const line of text.split('\n')) {
    if (!ANY_TOP_HEADING_RE.test(line)) continue;
    if (DATED_HEADING_RE.test(line)) continue;
    if (UNRELEASED_HEADING_RE.test(line)) continue;
    if (SEMVER_TOKEN_RE.test(line)) ambiguous.push(line.trim());
  }
  return ambiguous;
}

/** Full check for one CHANGELOG.md file (given its repo-relative path and
 * raw text). Returns two kinds of violation, both fatal to the check:
 * `{ type: 'duplicate-heading', file, version, kind, count }` for a
 * duplicated ### <Kind> heading not covered by `allowlist` (default: the
 * module-level ALLOWLIST, injectable for tests), and
 * `{ type: 'ambiguous-dated-heading', file, heading }` for a version-shaped
 * "## " heading DATED_HEADING_RE cannot parse (see findAmbiguousHeadings;
 * not allowlist-suppressible, since the fix is to reformat the heading,
 * not to accept an unparseable one). */
function collectFileViolations(relPath, text, allowlist = ALLOWLIST) {
  const violations = [];
  const sections = parseDatedSections(text);
  for (const d of findDuplicateKinds(sections)) {
    if (isAllowlisted(relPath, d.version, d.kind, allowlist)) continue;
    violations.push({ type: 'duplicate-heading', file: relPath, version: d.version, kind: d.kind, count: d.count });
  }
  for (const heading of findAmbiguousHeadings(text)) {
    violations.push({ type: 'ambiguous-dated-heading', file: relPath, heading });
  }
  return violations;
}

function run(rootDir = path.join(__dirname, '..'), allowlist = ALLOWLIST) {
  const relPaths = findChangelogPaths(rootDir);
  if (relPaths.length === 0) {
    console.error(`CHANGELOG duplicate-heading check failed: found 0 CHANGELOG.md files under ${rootDir}.`);
    return 1;
  }

  const violations = [];
  for (const relPath of relPaths) {
    const text = fs.readFileSync(path.join(rootDir, relPath), 'utf8');
    violations.push(...collectFileViolations(relPath, text, allowlist));
  }

  if (violations.length > 0) {
    console.error(`CHANGELOG duplicate-heading check failed (${violations.length} violation(s)):\n`);
    for (const v of violations) {
      if (v.type === 'duplicate-heading') {
        console.error(`  - ${v.file}: dated section "${v.version}" has ${v.count} "### ${v.kind}" headings.`);
      } else {
        console.error(
          `  - ${v.file}: heading "${v.heading}" looks version-shaped but does not match a recognized dated-section ` +
            'format (## <version>, <date> or ## [<version>] - <date>, optionally with an en/em dash separator).',
        );
      }
    }
    console.error(
      '\nFor a duplicate ### <Kind> heading: merge the duplicate ### sections into one, or add the ' +
        '{ file, version, kind } triple to ALLOWLIST in scripts/check-changelog-duplicate-headings.js with a reason. ' +
        'For an ambiguous heading: reformat it to a recognized dated-section shape (not allowlist-suppressible).',
    );
    return 1;
  }

  console.log(
    `CHANGELOG duplicate-heading check passed: ${relPaths.length} CHANGELOG.md file(s) carry no duplicate ` +
      '### <Kind> heading within a single dated section (outside ALLOWLIST), and no version-shaped heading ' +
      'that fails to parse as a dated section.',
  );
  return 0;
}

function main() {
  process.exitCode = run();
}

module.exports = {
  ALLOWLIST,
  isAllowlisted,
  findChangelogPaths,
  parseDatedSections,
  findDuplicateKinds,
  findAmbiguousHeadings,
  collectFileViolations,
  run,
};

if (require.main === module) {
  main();
}
