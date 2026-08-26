#!/usr/bin/env node
/**
 * OKF citation anchor-discipline check.
 *
 * okf-kit@0.6.0's own `citations-resolve` rule validates an anchor IF one is
 * present (does the anchor text occur ANYWHERE in the cited range?), but an
 * anchor is optional syntax in its `CITATION_RE` -- a citation with no
 * anchor at all is not flagged by okf-kit. It also only checks "does the
 * text occur somewhere in the range", not WHERE: an anchor whose text also
 * occurs earlier in the same range still passes okf-kit today, so a future
 * line-shift that only moves the LATER occurrence still leaves an earlier,
 * stale match for `checkAnchor`'s "first line in range wins" scan to find --
 * the check goes green on a citation that has actually drifted (see the
 * docs/okf/log.md entry for this task's round-3 fix round for the concrete
 * anchors this happened to before this script existed).
 *
 * This script is agent-grounding's own, stricter discipline on top of
 * okf-kit: for every full citation in docs/okf/*.md (log.md excluded, see
 * below), it asserts:
 *
 *   (a) the citation carries a `#"..."` string anchor, unless listed in the
 *       ALLOWLIST below with a reason;
 *   (b) the anchor text occurs on the LAST line of the cited range;
 *   (c) the anchor text occurs exactly ONCE within the cited range.
 *
 * (b)+(c) together mean a line-shift that moves the range can never leave a
 * stale-but-still-matching earlier occurrence behind: the only line the
 * anchor is allowed to match is the one the range's own end has to keep
 * pointing at.
 *
 * A citation into a `*.test.ts` file gets one more shape rule: the range
 * must start on the `describe(`/`it(`/`test(` head of the test the citing
 * sentence names and end on that test's own closing `});` -- so the range
 * always spans exactly one test, never a mid-test line. This still composes
 * with (b)/(c): the closing `});` line is the required last line, and its
 * anchor text just needs to be unique to that exact line within the range
 * (typically via its own indentation, since a bare `});` recurs at every
 * nesting level inside a test body -- see the ALLOWLIST-free examples in the
 * bundle for the pattern).
 *
 * ── CITATION_RE: mirrors okf-kit 0.6.0's, deliberately including fenced
 * code blocks ──────────────────────────────────────────────────────────
 *
 * Copied from agent-dx's okf-kit@0.6.0 `src/rules/citations-resolve.ts`
 * (`CITATION_RE`). Backtick-optional, `path.ext:N[-M][#anchor]`. Verified by
 * reading that file directly (not assumed): okf-kit's own full-citation scan
 * (`scanDoc`'s `fullAtoms` loop) does NOT exclude matches found inside a
 * fenced code block in the CITING doc -- only its separate short-form
 * (bare-range) matcher does, via `computeExcludedSpans`. A full citation
 * inside a fenced example (e.g. a per-line `// lib.ts:9` comment inside an
 * illustrative code block) is therefore a real citation okf-kit itself would
 * flag if it drifted, and this script deliberately does not skip fenced
 * blocks either, to stay equivalent to okf-kit's actual full-citation
 * behavior rather than its short-form one.
 */
const fs = require('fs');
const path = require('path');

const CITATION_RE =
  /([\w./-]+\.(?:ts|js|mjs|md|yml|yaml|json)):(\d+)(?:-(\d+))?(?:#(\[?\w(?:[\w.-]*\w)?\]?|"[^"\n`]*"))?/g;

const BUNDLE_DIR = 'docs/okf';
const RESERVED_DOCS = new Set(['log.md']);
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

/**
 * Citations deliberately exempt from rule (a) -- carries no `#"..."` anchor
 * -- each with a reason. Empty today: every full citation in the bundle
 * (outside log.md) carries a string anchor as of this script's introduction.
 * Add an entry here (keyed by `${file}:${citedPath}:${startLine}`) rather
 * than loosening the rule if a genuine exception shows up later.
 */
const ALLOWLIST = new Map([
  // '<doc file>:<citedPath>:<startLine>': 'reason',
]);

function allowlistKey(docFile, citedPath, startLine) {
  return `${docFile}:${citedPath}:${startLine}`;
}

/** Parses a raw `#...` anchor capture (without the leading `#`) into
 * `{ kind: 'string', text } | { kind: 'heading', text } | null`. Mirrors
 * okf-kit's `parseAnchor`, trimmed to what this script needs: only string
 * anchors get the (b)/(c) shape checks; a heading anchor is reported as
 * "present" for rule (a) but not shape-checked here (okf-kit's own
 * anchor-heading-* rules already validate those). */
function parseAnchor(raw) {
  if (raw === undefined) return null;
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return { kind: 'string', text: raw.slice(1, -1) };
  }
  return { kind: 'heading', text: raw };
}

function listBundleFiles(rootDir) {
  const dir = path.join(rootDir, BUNDLE_DIR);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !RESERVED_DOCS.has(f))
    .sort();
}

/** Every full citation match in `content`, with its 1-based line number. */
function collectCitations(content) {
  const out = [];
  const re = new RegExp(CITATION_RE.source, 'g');
  let m;
  while ((m = re.exec(content)) !== null) {
    const before = content.slice(0, m.index);
    const lineNo = before.split('\n').length;
    out.push({
      raw: m[0],
      citedPath: m[1],
      startLine: Number(m[2]),
      endLine: m[3] ? Number(m[3]) : Number(m[2]),
      anchor: parseAnchor(m[4]),
      docLine: lineNo,
      matchIndex: m.index,
    });
  }
  return out;
}

/** Repo-wide basename index, built once and memoized by caller. Excludes
 * SKIP_DIR_NAMES. Mirrors okf-kit's bare-filename fallback closely enough
 * for this script's purpose (validating anchors against a real file),
 * without reproducing its full multi-step precedence -- any single
 * existing candidate is enough to validate against; only true ambiguity
 * (>1 candidate) or absence (0 candidates) changes this script's verdict.
 */
function buildBasenameIndex(rootDir) {
  const index = new Map();
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const list = index.get(entry.name) ?? [];
        list.push(full);
        index.set(entry.name, list);
      }
    }
  }
  walk(rootDir);
  return index;
}

/** Minimal frontmatter `sources:` list reader -- this script intentionally
 * avoids the js-yaml dependency (declared at the workspace root, but a
 * check that has to run before `npm ci` -- see ci.yml -- should not need an
 * installed package). Only needs the shape every doc in this bundle already
 * uses: a top-level `sources:` key followed by `  - <path>` lines. */
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
      if (/^\S/.test(line)) inSources = false; // next top-level key
    }
  }
  return sources;
}

/** Ancestor-climb: doc-relative first, then each parent dir up to (and
 * including) `rootDir`, nearest first -- mirrors okf-kit's
 * `resolveViaAncestorClimb` for a bare filename. */
function resolveViaAncestorClimb(rootDir, docAbsPath, citedPath) {
  const resolvedRoot = path.resolve(rootDir);
  let dir = path.dirname(docAbsPath);
  for (;;) {
    const candidate = path.resolve(dir, citedPath);
    if (fs.existsSync(candidate)) return candidate;
    if (path.resolve(dir) === resolvedRoot) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Nearest earlier full citation in `content` (before `beforeIndex`) whose
 * cited path contains `/` and either equals `citedPath` or ends with
 * `/${citedPath}` -- the "full path was already mentioned earlier in this
 * doc" convention. Mirrors okf-kit's `findPriorQualifiedCitation`, needed
 * so e.g. a later bare `src/cli.ts` mention in a paragraph that opened with
 * the full `packages/review-claim-gate/src/cli.ts:248` resolves to the same
 * file okf-kit itself resolves it to, instead of this script reporting a
 * false ambiguity between claim-gate's and review-claim-gate's cli.ts. */
function findPriorQualifiedCitation(citations, beforeIndex, citedPath) {
  const suffix = '/' + citedPath;
  let best = null;
  let bestIndex = -1;
  for (const c of citations) {
    if (c.matchIndex >= beforeIndex) break;
    const candidate = c.citedPath;
    if (candidate === citedPath) continue;
    if (candidate.includes('/') && candidate.endsWith(suffix)) {
      if (c.matchIndex > bestIndex) {
        bestIndex = c.matchIndex;
        best = candidate;
      }
    }
  }
  return best;
}

/** Resolves `citedPath` (as cited from `docAbsPath`, whose frontmatter lists
 * `docSources`) to an absolute path on disk, or a skip reason ('unresolved'
 * | 'ambiguous'). Mirrors okf-kit's `resolveCitation` precedence closely
 * enough that a bare filename already named in the doc's own `sources:`
 * list (the common case in this bundle -- every doc lists its cited files)
 * resolves the same file okf-kit itself would use, instead of falling
 * through to a repo-wide search that a same-named file elsewhere in the
 * monorepo (e.g. more than one `server.ts`) would make falsely ambiguous. */
function resolveCitedPath(rootDir, docAbsPath, docSources, allCitations, citation, basenameIndex) {
  const citedPath = citation.citedPath;
  const sourceMatches = docSources.filter((s) => s === citedPath || s.endsWith('/' + citedPath));
  if (sourceMatches.length === 1) {
    const candidate = path.resolve(rootDir, sourceMatches[0]);
    if (fs.existsSync(candidate)) return { resolved: candidate };
  }

  if (!citedPath.includes('/')) {
    const viaAncestor = resolveViaAncestorClimb(rootDir, docAbsPath, citedPath);
    if (viaAncestor) return { resolved: viaAncestor };
  }

  const rootRel = path.join(rootDir, citedPath);
  if (fs.existsSync(rootRel)) return { resolved: rootRel };

  const docRel = path.join(path.dirname(docAbsPath), citedPath);
  if (fs.existsSync(docRel)) return { resolved: docRel };

  const prior = findPriorQualifiedCitation(allCitations, citation.matchIndex, citedPath);
  if (prior) {
    const candidate = path.resolve(rootDir, prior);
    if (fs.existsSync(candidate)) return { resolved: candidate };
  }

  const base = citedPath.includes('/') ? citedPath.split('/').pop() : citedPath;
  const candidates = (basenameIndex.get(base) ?? []).filter((m) => {
    const normalized = m.split(path.sep).join('/');
    return normalized.endsWith('/' + citedPath) || normalized === citedPath || !citedPath.includes('/');
  });
  if (candidates.length === 0) return { skipped: 'unresolved' };
  if (candidates.length > 1) return { skipped: 'ambiguous' };
  return { resolved: candidates[0] };
}

const TEST_HEAD_RE = /^\s*(?:describe|it|test)(?:\.\w+)?\s*\(/;
const TEST_CLOSE_RE = /^\s*\}\)\s*;?\s*$/;

/**
 * Runs the full check against `rootDir` and returns
 * `{ exitCode, summary, violations }`. `summary` carries the counts the CLI
 * and CI step summary both need (total / anchored / skipped / violations).
 */
function run(rootDir = path.join(__dirname, '..')) {
  const bundleAbsDir = path.join(rootDir, BUNDLE_DIR);
  const files = listBundleFiles(rootDir);
  if (files.length === 0) {
    console.error(
      `OKF anchor check failed: found 0 doc(s) under ${BUNDLE_DIR}/ (excluding log.md). ` +
        'Expected at least one bundle doc to check.',
    );
    return { exitCode: 1, summary: null, violations: [] };
  }

  const basenameIndex = buildBasenameIndex(rootDir);
  const violations = [];
  let total = 0;
  let anchored = 0;
  let skippedUnresolved = 0;
  let skippedAmbiguous = 0;

  for (const file of files) {
    const docAbsPath = path.join(bundleAbsDir, file);
    const content = fs.readFileSync(docAbsPath, 'utf8');
    const docSources = parseSourcesFrontmatter(content);
    const citations = collectCitations(content);
    for (const citation of citations) {
      total++;
      const citationLabel = `${file}:${citation.docLine} \`${citation.citedPath}:${citation.startLine}${
        citation.endLine !== citation.startLine ? `-${citation.endLine}` : ''
      }\``;

      const resolution = resolveCitedPath(rootDir, docAbsPath, docSources, citations, citation, basenameIndex);
      if (resolution.skipped === 'unresolved') {
        skippedUnresolved++;
        continue;
      }
      if (resolution.skipped === 'ambiguous') {
        skippedAmbiguous++;
        continue;
      }

      if (!citation.anchor) {
        const key = allowlistKey(file, citation.citedPath, citation.startLine);
        if (ALLOWLIST.has(key)) continue;
        violations.push({
          rule: 'missing-anchor',
          citation: citationLabel,
          message: `${citationLabel} carries no #"..." anchor and is not in ALLOWLIST`,
        });
        continue;
      }

      anchored++;
      if (citation.anchor.kind !== 'string') continue; // heading anchors: okf-kit's own rules cover shape

      const targetLines = fs.readFileSync(resolution.resolved, 'utf8').split('\n');
      const startIdx = citation.startLine - 1;
      const endIdx = citation.endLine - 1;
      const rangeLines = targetLines.slice(startIdx, endIdx + 1);
      const text = citation.anchor.text;

      const isTestCitation = citation.citedPath.endsWith('.test.ts');
      const occurrences = rangeLines.reduce((n, l) => n + (l.includes(text) ? 1 : 0), 0);
      const lastLine = rangeLines[rangeLines.length - 1] ?? '';
      const onLastLine = lastLine.includes(text);

      // A *.test.ts citation's range end is pinned to the test's own
      // closing `});` by the shape rule below, not chosen for anchor
      // distinctiveness -- a bare `});` recurs at every nesting level
      // inside a test body, so demanding the anchor sit on that exact line
      // (rule b) would fight the shape rule instead of composing with it.
      // These citations get the relaxed "somewhere in range, exactly once"
      // check instead; every non-test citation still needs both (b) and (c).
      if (!isTestCitation && !onLastLine) {
        violations.push({
          rule: 'anchor-not-on-last-line',
          citation: citationLabel,
          message: `${citationLabel} anchor "${text}" is not on the range's last line (${citation.endLine})`,
        });
      } else if (occurrences !== 1) {
        violations.push({
          rule: 'anchor-not-unique-in-range',
          citation: citationLabel,
          message: `${citationLabel} anchor "${text}" occurs ${occurrences} times in the cited range, expected exactly 1`,
        });
      }

      if (isTestCitation) {
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
  }

  const summary = {
    filesChecked: files.length,
    totalCitations: total,
    anchored,
    skippedUnresolved,
    skippedAmbiguous,
    violations: violations.length,
  };

  if (violations.length > 0) {
    console.error(`OKF anchor check failed (${violations.length} violation(s)):\n`);
    for (const v of violations) console.error(`  - [${v.rule}] ${v.message}`);
    console.error(
      `\n${total} full citation(s) across ${files.length} doc(s), ${anchored} anchored, ` +
        `${skippedUnresolved} unresolved, ${skippedAmbiguous} ambiguous.`,
    );
    return { exitCode: 1, summary, violations };
  }

  console.log(
    `OKF anchor check passed: ${total} full citation(s) across ${files.length} doc(s) (log.md excluded), ` +
      `${anchored} anchored (all last-line + unique-in-range), ${skippedUnresolved} unresolved, ` +
      `${skippedAmbiguous} ambiguous target(s) skipped.`,
  );
  return { exitCode: 0, summary, violations: [] };
}

function main() {
  process.exitCode = run().exitCode;
}

module.exports = {
  CITATION_RE,
  parseAnchor,
  collectCitations,
  buildBasenameIndex,
  parseSourcesFrontmatter,
  resolveViaAncestorClimb,
  resolveCitedPath,
  run,
  ALLOWLIST,
  TEST_HEAD_RE,
  TEST_CLOSE_RE,
};

if (require.main === module) {
  main();
}
