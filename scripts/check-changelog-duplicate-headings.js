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
 * date-heading shape; a plain `## [Unreleased]` heading is not dated and is
 * not scanned), collects every `### <Kind>` heading's exact trimmed text and
 * flags any kind that occurs more than once, UNLESS that exact
 * `{ file, version, kind }` triple is listed in `ALLOWLIST` below with a
 * reason (for a pre-existing violation this check should not force a
 * rewrite of old prose for -- see CONTRIBUTING.md and the task notes: none
 * exist in this repo as of this check's introduction, so the allowlist
 * starts empty).
 *
 * Usage: `node scripts/check-changelog-duplicate-headings.js` (wired as
 * `check:changelog-duplicate-headings`). Exits non-zero and prints one line
 * per offending `{ file, version, kind }` on failure.
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Matches "## 0.2.2, 2026-05-03" and "## [0.2.2] - 2026-05-03" shapes.
const DATED_HEADING_RE = /^##\s+\[?([^\],]+?)\]?[, ]+-?\s*(\d{4}-\d{2}-\d{2})\s*$/;
const SUBSECTION_HEADING_RE = /^###\s+(.+?)\s*$/;
const ANY_TOP_HEADING_RE = /^##\s/;

/**
 * Pre-existing violations this check does not force a rewrite of.
 * `{ file: repo-relative path, version: the dated heading's version token
 * as captured by DATED_HEADING_RE, kind: the exact trimmed ### heading
 * text, reason: string }`. Empty today: no known pre-existing duplicate
 * survives in this repo (verified when this check was introduced, task
 * d51ae64b).
 */
const ALLOWLIST = [];

function isAllowlisted(file, version, kind) {
  return ALLOWLIST.some((e) => e.file === file && e.version === version && e.kind === kind);
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

/** Full check for one CHANGELOG.md file (given its repo-relative path and
 * raw text). Returns violations not covered by ALLOWLIST. */
function collectFileViolations(relPath, text) {
  const sections = parseDatedSections(text);
  const dupes = findDuplicateKinds(sections);
  return dupes
    .filter((d) => !isAllowlisted(relPath, d.version, d.kind))
    .map((d) => ({ file: relPath, version: d.version, kind: d.kind, count: d.count }));
}

function run(rootDir = path.join(__dirname, '..')) {
  const relPaths = findChangelogPaths(rootDir);
  if (relPaths.length === 0) {
    console.error(`CHANGELOG duplicate-heading check failed: found 0 CHANGELOG.md files under ${rootDir}.`);
    return 1;
  }

  const violations = [];
  for (const relPath of relPaths) {
    const text = fs.readFileSync(path.join(rootDir, relPath), 'utf8');
    violations.push(...collectFileViolations(relPath, text));
  }

  if (violations.length > 0) {
    console.error(`CHANGELOG duplicate-heading check failed (${violations.length} violation(s)):\n`);
    for (const v of violations) {
      console.error(`  - ${v.file}: dated section "${v.version}" has ${v.count} "### ${v.kind}" headings.`);
    }
    console.error(
      '\nMerge the duplicate ### sections into one, or add the { file, version, kind } triple to ALLOWLIST in ' +
        'scripts/check-changelog-duplicate-headings.js with a reason.',
    );
    return 1;
  }

  console.log(
    `CHANGELOG duplicate-heading check passed: ${relPaths.length} CHANGELOG.md file(s) carry no duplicate ` +
      '### <Kind> heading within a single dated section (outside ALLOWLIST).',
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
  collectFileViolations,
  run,
};

if (require.main === module) {
  main();
}
