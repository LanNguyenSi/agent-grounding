#!/usr/bin/env node
/**
 * OKF test-citation-shape check.
 *
 * Replaces most of the former check-okf-anchors.js: as of okf-kit@0.8.0,
 * `--require-anchors` (`anchor-required`, `anchor-not-on-last-line`,
 * `anchor-not-unique-in-range`, `test-range-straddles-block`) covers
 * everything that script used to enforce by hand, EXCEPT one shape rule
 * okf-kit has no equivalent for: a full citation into a `*.test.ts` file
 * must span exactly one test, range start on the `describe(`/`it(`/`test(`
 * head of the test the citing sentence names, range end on that test's own
 * closing `});`. okf-kit's own `test-range-straddles-block` only checks
 * that the range does not straddle into a SIBLING or OUTER block; it does
 * not require the range to start on a head line or end on the test's own
 * close, so a range that starts and ends mid-body (never touching a block
 * boundary at all) straddles nothing and would pass okf-kit clean while
 * still failing this shape rule. Kept as its own small, additive check
 * rather than folded into okf-kit or dropped, since (a) it is a real,
 * narrow gap and (b) the fix is a handful of lines, not a whole rule.
 *
 * Path resolution below is copied, trimmed to only what a `.test.ts`
 * citation needs, from the former check-okf-anchors.js (see docs/okf/log.md
 * for that script's own history). Pure Node core, no okf-kit dependency,
 * matching that script's own reasoning for avoiding js-yaml: this check
 * must run before `npm ci`.
 */
const fs = require('fs');
const path = require('path');

const CITATION_RE =
  /([\w./-]+\.(?:ts|js|mjs|md|yml|yaml|json)):(\d+)(?:-(\d+))?(?:#(\[?\w(?:[\w.-]*\w)?\]?|"[^"\n`]*"))?/g;

const BUNDLE_DIR = 'docs/okf';
const RESERVED_DOCS = new Set(['log.md']);
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

const TEST_HEAD_RE = /^\s*(?:describe|it|test)(?:\.\w+)?\s*\(/;
const TEST_CLOSE_RE = /^\s*\}\)\s*;?\s*$/;

function listBundleFiles(rootDir) {
  const dir = path.join(rootDir, BUNDLE_DIR);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !RESERVED_DOCS.has(f))
    .sort();
}

/** Every full citation into a `*.test.ts` target in `content`, with its
 * 1-based line number in the citing doc. */
function collectTestCitations(content) {
  const out = [];
  const re = new RegExp(CITATION_RE.source, 'g');
  let m;
  while ((m = re.exec(content)) !== null) {
    if (!m[1].endsWith('.test.ts')) continue;
    const before = content.slice(0, m.index);
    out.push({
      raw: m[0],
      citedPath: m[1],
      startLine: Number(m[2]),
      endLine: m[3] ? Number(m[3]) : Number(m[2]),
      docLine: before.split('\n').length,
    });
  }
  return out;
}

function parseSourcesFrontmatter(content) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return [];
  const lines = fmMatch[1].split('\n');
  const sources = [];
  let inSources = false;
  for (const line of lines) {
    if (/^sources:\s*$/.test(line)) {
      inSources = true;
      continue;
    }
    if (inSources) {
      const m = line.match(/^\s*-\s*(\S+)\s*$/);
      if (m) {
        sources.push(m[1]);
        continue;
      }
      if (/^\S/.test(line)) inSources = false;
    }
  }
  return sources;
}

function hasParentSegment(citedPath) {
  return citedPath.split('/').includes('..');
}

/** Resolves `citedPath` against `docSources` (the citing doc's own
 * frontmatter `sources:` list) or the repo root / doc-relative fallback.
 * Trimmed from check-okf-anchors.js's `resolveCitedPath`: no ancestor
 * climb, no repo-wide basename search, no prior-qualified-citation lookup
 * -- every `*.test.ts` citation in this bundle today names its source in
 * frontmatter or as a root/doc-relative path, and adding those extra
 * fallbacks back is a one-line change if a future citation needs them. */
function resolveTestCitedPath(rootDir, docAbsPath, docSources, citedPath) {
  if (hasParentSegment(citedPath)) return { skipped: 'path-traversal-rejected' };
  const sourceMatches = docSources.filter((s) => s === citedPath || s.endsWith('/' + citedPath));
  if (sourceMatches.length === 1) {
    const candidate = path.resolve(rootDir, sourceMatches[0]);
    if (fs.existsSync(candidate)) return { resolved: candidate };
  }
  const rootRel = path.join(rootDir, citedPath);
  if (fs.existsSync(rootRel)) return { resolved: rootRel };
  const docRel = path.join(path.dirname(docAbsPath), citedPath);
  if (fs.existsSync(docRel)) return { resolved: docRel };
  return { skipped: 'unresolved' };
}

function run(rootDir = path.join(__dirname, '..')) {
  const bundleAbsDir = path.join(rootDir, BUNDLE_DIR);
  const files = listBundleFiles(rootDir);
  if (files.length === 0) {
    console.error(
      `OKF test-citation-shape check failed: found 0 doc(s) under ${BUNDLE_DIR}/ (excluding log.md).`,
    );
    return { exitCode: 1, summary: null, violations: [] };
  }

  const violations = [];
  let checked = 0;
  let skipped = 0;

  for (const file of files) {
    const docAbsPath = path.join(bundleAbsDir, file);
    const content = fs.readFileSync(docAbsPath, 'utf8');
    const docSources = parseSourcesFrontmatter(content);
    for (const citation of collectTestCitations(content)) {
      const citationLabel = `${file}:${citation.docLine} \`${citation.citedPath}:${citation.startLine}${
        citation.endLine !== citation.startLine ? `-${citation.endLine}` : ''
      }\``;

      const resolution = resolveTestCitedPath(rootDir, docAbsPath, docSources, citation.citedPath);
      if (resolution.skipped) {
        skipped++;
        continue;
      }

      checked++;
      const targetLines = fs.readFileSync(resolution.resolved, 'utf8').split('\n');
      const startIdx = citation.startLine - 1;
      const endIdx = citation.endLine - 1;
      const headOk = TEST_HEAD_RE.test(targetLines[startIdx] ?? '');
      const closeOk = TEST_CLOSE_RE.test(targetLines[endIdx] ?? '');
      if (!headOk || !closeOk) {
        violations.push({
          rule: 'test-citation-shape',
          citation: citationLabel,
          message:
            `${citationLabel} cites a *.test.ts target but its range does not start on a ` +
            `describe(/it(/test( head and end on that test's closing });`,
        });
      }
    }
  }

  const summary = { filesChecked: files.length, testCitationsChecked: checked, skipped, violations: violations.length };

  if (violations.length > 0) {
    console.error(`OKF test-citation-shape check failed (${violations.length} violation(s)):\n`);
    for (const v of violations) console.error(`  - [${v.rule}] ${v.message}`);
    return { exitCode: 1, summary, violations };
  }

  console.log(
    `OKF test-citation-shape check passed: ${checked} *.test.ts citation(s) across ${files.length} doc(s) ` +
      `(log.md excluded), all head-to-close shaped, ${skipped} unresolved/skipped.`,
  );
  return { exitCode: 0, summary, violations: [] };
}

function main() {
  process.exitCode = run().exitCode;
}

module.exports = {
  CITATION_RE,
  collectTestCitations,
  parseSourcesFrontmatter,
  hasParentSegment,
  resolveTestCitedPath,
  run,
  TEST_HEAD_RE,
  TEST_CLOSE_RE,
};

if (require.main === module) {
  main();
}
