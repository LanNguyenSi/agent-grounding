#!/usr/bin/env node
/**
 * Warn-only checker for `path:line[-line]` citations inside the curated
 * docs/okf (and docs/testing) knowledge bundle.
 *
 * okf-staleness (okf-kit `sources-fresh`) only compares a doc's `sources:`
 * frontmatter list against file mtimes; it is structurally blind to an edit
 * that shifts line numbers inside a still-fresh source file, which is
 * exactly what drifted the merge-approval-rollout.md / merge-approval-gate-
 * mechanics.md citations caught by hand in PR #184. This script is a
 * mechanical, no-dependency spike at closing that gap: it finds every
 * `path:N` / `path:N-M` citation in the bundle, resolves `path` to a real
 * file, and warns when the citation clearly cannot be pointing at real
 * content any more.
 *
 * What it checks (mechanical only, no symbol/AST resolution):
 *   - the target file does not exist (after resolution, see below)
 *   - a range's end line is before its start line (an inverted range)
 *   - the cited line (or the end of a range) is past the end of the file
 *   - the start line is blank
 *   - for non-markdown targets only, the start line is only a closing
 *     brace/bracket/paren (`}`, `)`, `]`, optionally with a trailing `,`/`;`)
 *     — a common signature of "the cited block moved and this now points at
 *     the line right after it used to end"
 *
 * What it does NOT check: whether the cited line is semantically the right
 * one (that needs the actual symbol, out of scope for a warn-only mechanical
 * spike), nor citations without a file extension this script recognises.
 *
 * Path resolution. This bundle's prose citations are frequently written
 * *relative to context* rather than as a full repo-root path, e.g. a doc's
 * frontmatter `sources:` list carries `packages/foo/src/cli.ts`, but the
 * prose later just says `cli.ts:42` or `src/cli.ts:42` once the reader
 * "knows" which package the section is about — and several source basenames
 * (`cli.ts`, `lib.ts`, `README.md`) are reused across sibling packages (and
 * a bare `README.md` collides with the repo-root README), so a resolver
 * that only tried repo-root-relative and doc-relative paths would either
 * flag the large majority of this bundle's real, non-drifted citations as
 * "missing file", or silently check the wrong same-named file. Resolution
 * here instead tries, in order:
 *   1. the citing doc's own frontmatter `sources:` list, matched by exact
 *      suffix (`source === citedPath || source.endsWith('/' + citedPath)`),
 *      only when exactly one source matches — the doc's author already
 *      disambiguated which physical file this citation means
 *   2. repo-root-relative (`<root>/<citedPath>`)
 *   3. doc-relative (`<dirname(doc)>/<citedPath>`)
 *   4. the nearest earlier citation *in the same doc* whose path contains a
 *      `/` and ends with the same suffix as citedPath (the "last full path
 *      mentioned" convention this bundle actually uses in prose)
 *   5. a repo-wide search for a file whose path ends with citedPath (or,
 *      for a bare filename, whose basename equals it)
 * A citedPath starting with `/` is treated as out of scope (an absolute or
 * placeholder path, e.g. inside a fabricated example stack trace) and
 * skipped without a finding. When step 5 finds more than one candidate the
 * citation is reported separately as "unresolved (ambiguous)" — informational
 * only, not counted as a finding — rather than guessed at or false-flagged
 * as missing. A citation resolved by none of the above, with zero candidates
 * at step 5, is reported as `missing-file`. A citedPath containing a `..`
 * segment is rejected outright (`path-traversal-rejected`) without ever
 * being resolved, so a malformed or hostile citation cannot walk resolution
 * outside the repo.
 *
 * Continuation citations. Once a sentence has stated a full `path:N`
 * citation, this bundle's prose habitually repeats just the line (or
 * range) for a later reference in the same sentence rather than retyping
 * the path, in three forms actually used in docs/okf:
 *   - `` `:N` `` or `` `:N-M` `` — a bare colon-prefixed line/range
 *   - `` -`M` `` / `` –`M` `` — a hyphen- or en-dash-led bare line, the
 *     tail half of a `` `path:N`-`M` `` split range
 *   - `` (`N`) `` — a parenthesized bare line
 * Each of these resolves against `governing`: the nearest *preceding*
 * citation (full or itself a continuation) that resolved to a real file,
 * scanned in document order. `governing` resets to none whenever the
 * citation immediately before it failed to resolve, was ambiguous, or was
 * out of scope (leading `/`) — a continuation never silently inherits a
 * stale or unrelated path from further up the doc. A continuation with no
 * governing citation at all (e.g. very start of a doc) is skipped, not
 * flagged: there is nothing to validate it against.
 *
 * A continuation is further split into two roles (see
 * collectContinuationAtoms): "fresh" (a genuinely new start line, checked
 * the same five ways as a full citation's start) versus "extension" (only
 * ever the tail `M` of a split range whose start was already checked) —
 * an extension gets *only* the range-bound checks (inverted-range,
 * range-exceeds-file), never blank/closing-brace: that start line was
 * already checked when it was first cited, so re-running it here would
 * double-report the same drift, and a range legitimately ending on a
 * closing brace is normal, not drift.
 *
 * Usage:
 *   node scripts/okf-citations-resolve.mjs [--root <dir>] [--json] [--fail-on-warn]
 *
 * Exit code is always 0 unless --fail-on-warn is given and at least one
 * finding was produced (for local use only; the wired CI step never passes
 * --fail-on-warn, matching the warn-only posture of okf-staleness.yml).
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CITATION_RE =
  /([\w./-]+\.(?:ts|js|mjs|md|yml|yaml|json)):(\d+)(?:-(\d+))?/g;
// Continuation citation forms (see the "Continuation citations" doc block
// above). Each requires the backtick delimiter as part of the match so it
// can never overlap a CITATION_RE match: a full citation's regex match
// never includes the surrounding backticks, and none of these three
// require a `path.ext` prefix before the digits.
const CONT_COLON_RE = /`:(\d+)(?:-(\d+))?`/g;
const CONT_DASH_RE = /[-–]`(\d+)`/g;
const CONT_PAREN_RE = /\(`(\d+)`\)/g;
const CLOSING_ONLY_EXTS = new Set(["ts", "js", "mjs", "yml", "yaml", "json"]);
const CLOSING_BRACE_RE = /^[)\]}][;,]?$/;
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  // This script's own disposable test fixtures: a small, fake docs/okf +
  // src/ tree under scripts/okf-citations-resolve-fixtures/ with filenames
  // (target.ts, note.md) that could otherwise collide with a repo-wide
  // basename search (resolution step 5) for a real docs/okf citation.
  "okf-citations-resolve-fixtures",
]);

function scriptDefaultRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolvePath(here, "..");
}

export function parseArgs(argv) {
  const opts = { root: null, json: false, failOnWarn: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      if (argv[i + 1] === undefined) {
        throw new Error("--root requires a value");
      }
      opts.root = argv[i + 1];
      i += 1;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--fail-on-warn") {
      opts.failOnWarn = true;
    } else {
      throw new Error(`unrecognized argument: ${arg}`);
    }
  }
  return opts;
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** True when citedPath has a literal `..` path segment. */
export function hasParentSegment(citedPath) {
  return citedPath.split("/").includes("..");
}

export function findDocFiles(root) {
  const okfDir = join(root, "docs/okf");
  const files = [];
  if (existsSync(okfDir)) {
    for (const entry of readdirSync(okfDir)) {
      if (entry.endsWith(".md")) files.push(join(okfDir, entry));
    }
  }

  // docs/testing/*.md is included only when cited from an okf doc's
  // frontmatter `sources:` list. Most docs/testing files are dogfood
  // evidence logs full of fabricated example output (stack traces,
  // placeholder paths), not curated citation targets, so blanket-scanning
  // the whole directory would flag their example content as broken
  // citations.
  const citedTesting = new Set();
  for (const f of files) {
    const content = readFileSync(f, "utf8");
    for (const src of parseFrontmatterSources(content)) {
      if (src.startsWith("docs/testing/") && src.endsWith(".md")) {
        citedTesting.add(src);
      }
    }
  }
  for (const rel of citedTesting) {
    const full = join(root, rel);
    if (isFile(full)) files.push(full);
  }

  return files;
}

/** Parses the flat YAML `sources:` list out of a doc's frontmatter. */
export function parseFrontmatterSources(content) {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return [];
  const fm = fmMatch[1];
  const sourcesMatch = fm.match(/^sources:\s*\r?\n((?:[ \t]+-.*\r?\n?)+)/m);
  if (!sourcesMatch) return [];
  return sourcesMatch[1]
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*-\s*(.+?)\s*$/))
    .filter(Boolean)
    .map((m) => m[1]);
}

/** Repo-wide search for files with an exact basename, memoized per root. */
const basenameIndexCache = new Map();
function findByBasename(root, basename) {
  let index = basenameIndexCache.get(root);
  if (!index) {
    index = new Map();
    const walk = (dir) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".") && entry.name !== ".github") continue;
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          const list = index.get(entry.name) ?? [];
          list.push(full);
          index.set(entry.name, list);
        }
      }
    };
    walk(root);
    basenameIndexCache.set(root, index);
  }
  return index.get(basename) ?? [];
}

/**
 * Finds the nearest citation earlier in the same doc whose cited path
 * contains a `/` and ends with the same suffix as `citedPath`, the "full
 * path was mentioned earlier in this section/doc" convention.
 */
function findPriorQualifiedCitation(content, beforeIndex, citedPath) {
  const suffix = "/" + citedPath;
  let best = null;
  let bestIndex = -1;
  const re = new RegExp(CITATION_RE.source, "g");
  let m;
  while ((m = re.exec(content)) !== null) {
    if (m.index >= beforeIndex) break;
    const candidate = m[1];
    if (candidate === citedPath) continue; // not more qualified than itself
    if (candidate.includes("/") && (candidate === citedPath || candidate.endsWith(suffix))) {
      if (m.index > bestIndex) {
        bestIndex = m.index;
        best = candidate;
      }
    }
  }
  return best;
}

/**
 * Resolves a citation's path to a single real file.
 *
 * Returns `{ skip: true }` for a citedPath out of this resolver's scope
 * (leading `/`), `{ path }` on a definitive single resolution, `{ ambiguous:
 * true, candidates }` when more than one plausible target exists and none of
 * the higher-priority strategies picked one, or `null` when nothing at all
 * matches. Callers must reject a citedPath with a `..` segment (see
 * hasParentSegment) before calling this; it is not re-checked here.
 */
export function resolveCitation(root, docPath, docContent, docSources, citedPath, matchIndex) {
  if (citedPath.startsWith("/")) {
    return { skip: true };
  }

  const sourceMatches = docSources.filter(
    (s) => s === citedPath || s.endsWith("/" + citedPath),
  );
  if (sourceMatches.length === 1) {
    const candidate = resolvePath(root, sourceMatches[0]);
    if (isFile(candidate)) return { path: candidate };
  }

  const rootRelative = resolvePath(root, citedPath);
  if (isFile(rootRelative)) return { path: rootRelative };

  const docRelative = resolvePath(dirname(docPath), citedPath);
  if (isFile(docRelative)) return { path: docRelative };

  const prior = findPriorQualifiedCitation(docContent, matchIndex, citedPath);
  if (prior) {
    const candidate = resolvePath(root, prior);
    if (isFile(candidate)) return { path: candidate };
  }

  const base = citedPath.includes("/") ? citedPath.split("/").pop() : citedPath;
  const bySuffix = findByBasename(root, base).filter((m) => {
    const normalized = m.split(sep).join("/");
    return normalized === citedPath || normalized.endsWith("/" + citedPath) || !citedPath.includes("/");
  });
  if (bySuffix.length === 1) return { path: bySuffix[0] };
  if (bySuffix.length > 1) {
    return { ambiguous: true, candidates: bySuffix.map((m) => relative(root, m)) };
  }

  return null;
}

export function splitLines(content) {
  const lines = content.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "" && content.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

// Range-bound checks shared by a full citation's own range (via
// checkTarget below) and a cont-ext atom's extension (via
// checkRangeBoundOnly): a citation's end before its start, or either bound
// past the end of the file. Both are pure "does this range make sense"
// checks, independent of what the start line's content actually is.
function checkRangeBound(startLine, endLine, lineCount) {
  if (endLine !== undefined && endLine !== null && endLine < startLine) {
    return {
      rule: "inverted-range",
      message: `range end (${endLine}) is before its start (${startLine})`,
    };
  }

  const last = endLine ?? startLine;
  if (startLine > lineCount || last > lineCount) {
    return {
      rule: "range-exceeds-file",
      message: `citation exceeds file length (${lineCount} line(s))`,
    };
  }

  return null;
}

function checkTarget(citedPath, startLine, endLine, resolvedPath) {
  const content = readFileSync(resolvedPath, "utf8");
  const lines = splitLines(content);
  const lineCount = lines.length;

  const bound = checkRangeBound(startLine, endLine, lineCount);
  if (bound) return bound;

  const startText = lines[startLine - 1] ?? "";
  const trimmed = startText.trim();
  if (trimmed === "") {
    return { rule: "blank-start-line", message: "start line is blank" };
  }

  const ext = citedPath.split(".").pop().toLowerCase();
  if (CLOSING_ONLY_EXTS.has(ext) && CLOSING_BRACE_RE.test(trimmed)) {
    return {
      rule: "closing-brace-start-line",
      message: `start line is only a closing brace/bracket ("${trimmed}")`,
    };
  }

  return null;
}

// A cont-ext atom only ever extends the *end* of a range whose start line
// was already fully checked (blank / closing-brace) when it was cited as
// its own full citation or cont-fresh atom -- re-running checkTarget here
// would re-derive that same start-line check against the identical line
// and, on a real drift, double-report it as a second finding. This checks
// only whether the (possibly inverted, possibly out-of-file) range itself
// is sound.
function checkRangeBoundOnly(startLine, endLine, resolvedPath) {
  const content = readFileSync(resolvedPath, "utf8");
  const lineCount = splitLines(content).length;
  return checkRangeBound(startLine, endLine, lineCount);
}

/**
 * Collects every continuation-citation atom (see the "Continuation
 * citations" doc block above) in `content`, sorted by document position.
 *
 * Each atom is tagged with a role:
 *   - "cont-fresh": establishes a new start line (optionally with its own
 *     embedded end, e.g. `` `:75-78` ``), checked the same way as a full
 *     citation's start (blank / closing-brace / range-exceeds).
 *   - "cont-ext": purely extends the *end* of whatever start line came
 *     immediately before it (a `` -`M` `` / `` –`M` `` tail, or a `` `:M` ``
 *     directly preceded by a `-`/`–`), e.g. the `264` half of `` `src/cli
 *     .ts:260`-`264` ``. Ending a range on a closing brace is completely
 *     normal, so an extension is checked ONLY for the range-bound checks
 *     (inverted-range, range-exceeds-file), never blank/closing-brace (that
 *     would misflag every range that legitimately ends at a function's
 *     closing `}`).
 * A colon-form match (`` `:N` ``) is "cont-ext" exactly when the nearest
 * non-whitespace character before its opening backtick is `-` or `–`;
 * otherwise it is "cont-fresh". Dash-form (`` -`M` ``/`` –`M` ``) is always
 * "cont-ext" by construction. Paren-form (`` (`N`) ``) is always
 * "cont-fresh": nothing in this bundle uses it as a range tail, and a
 * parenthetical reads as its own standalone pointer.
 */
function collectContinuationAtoms(content) {
  const atoms = [];

  const colonRe = new RegExp(CONT_COLON_RE.source, "g");
  let m;
  while ((m = colonRe.exec(content)) !== null) {
    const before = content.slice(0, m.index).trimEnd();
    if (/[-–]$/.test(before)) {
      atoms.push({
        kind: "cont-ext",
        index: m.index,
        value: m[2] ? Number(m[2]) : Number(m[1]),
      });
    } else {
      atoms.push({
        kind: "cont-fresh",
        index: m.index,
        startLine: Number(m[1]),
        endLine: m[2] ? Number(m[2]) : null,
      });
    }
  }

  const dashRe = new RegExp(CONT_DASH_RE.source, "g");
  while ((m = dashRe.exec(content)) !== null) {
    atoms.push({ kind: "cont-ext", index: m.index, value: Number(m[1]) });
  }

  const parenRe = new RegExp(CONT_PAREN_RE.source, "g");
  while ((m = parenRe.exec(content)) !== null) {
    atoms.push({ kind: "cont-fresh", index: m.index, startLine: Number(m[1]), endLine: null });
  }

  return atoms;
}

function scanDoc(root, docPath) {
  const content = readFileSync(docPath, "utf8");
  const sources = parseFrontmatterSources(content);
  const findings = [];
  const unresolved = [];

  const fullAtoms = [];
  const re = new RegExp(CITATION_RE.source, "g");
  let m;
  while ((m = re.exec(content)) !== null) {
    fullAtoms.push({
      kind: "full",
      index: m.index,
      citedPath: m[1],
      startLine: Number(m[2]),
      endLine: m[3] ? Number(m[3]) : null,
    });
  }

  const atoms = [...fullAtoms, ...collectContinuationAtoms(content)].sort(
    (a, b) => a.index - b.index,
  );

  // `governing`: nearest preceding citation (full or continuation) that
  // resolved to a real file; see the "Continuation citations" doc block
  // above for the reset rules. `lastStartLine`: the start line a "cont-ext"
  // atom extends into a range; tracks the most recent full or cont-fresh
  // atom's own startLine, scoped together with `governing`.
  let governing = null;
  let lastStartLine = null;

  for (const atom of atoms) {
    if (atom.kind === "cont-ext") {
      if (!governing || lastStartLine === null) continue; // nothing to extend
      const citation = `${governing.citedPath}:${lastStartLine}-${atom.value} (continuation)`;
      const problem = checkRangeBoundOnly(lastStartLine, atom.value, governing.resolvedPath);
      if (problem) {
        findings.push({
          doc: relative(root, docPath),
          citation,
          resolvedTo: relative(root, governing.resolvedPath),
          rule: problem.rule,
          message: problem.message,
        });
      }
      continue; // governing and lastStartLine both carry over unchanged
    }

    if (atom.kind === "cont-fresh") {
      if (!governing) continue; // nothing to validate a bare continuation against
      const { startLine, endLine } = atom;
      const citation = `${governing.citedPath}:${startLine}${endLine ? "-" + endLine : ""} (continuation)`;
      const problem = checkTarget(governing.citedPath, startLine, endLine, governing.resolvedPath);
      if (problem) {
        findings.push({
          doc: relative(root, docPath),
          citation,
          resolvedTo: relative(root, governing.resolvedPath),
          rule: problem.rule,
          message: problem.message,
        });
      }
      lastStartLine = startLine;
      continue; // governing (same file) carries over unchanged
    }

    const { citedPath, startLine, endLine } = atom;
    const citation = `${citedPath}:${startLine}${endLine ? "-" + endLine : ""}`;

    if (hasParentSegment(citedPath)) {
      findings.push({
        doc: relative(root, docPath),
        citation,
        rule: "path-traversal-rejected",
        message: `citedPath contains a ".." segment and was rejected without resolving: ${citedPath}`,
      });
      governing = null;
      lastStartLine = null;
      continue;
    }

    const resolution = resolveCitation(root, docPath, content, sources, citedPath, atom.index);

    if (!resolution) {
      findings.push({
        doc: relative(root, docPath),
        citation,
        rule: "missing-file",
        message: `could not resolve ${citedPath}: tried doc sources, repo-root, doc-relative, nearest prior qualified mention, repo-wide search; no candidate file exists`,
      });
      governing = null;
      lastStartLine = null;
      continue;
    }
    if (resolution.skip) {
      governing = null;
      lastStartLine = null;
      continue;
    }
    if (resolution.ambiguous) {
      unresolved.push({
        doc: relative(root, docPath),
        citation,
        reason: "ambiguous",
        candidates: resolution.candidates,
      });
      governing = null;
      lastStartLine = null;
      continue;
    }

    const problem = checkTarget(citedPath, startLine, endLine, resolution.path);
    if (problem) {
      findings.push({
        doc: relative(root, docPath),
        citation,
        resolvedTo: relative(root, resolution.path),
        rule: problem.rule,
        message: problem.message,
      });
    }
    governing = { citedPath, resolvedPath: resolution.path };
    lastStartLine = startLine;
  }

  return { findings, unresolved };
}

export function run(root) {
  const docFiles = findDocFiles(root);
  const results = docFiles.map((doc) => scanDoc(root, doc));
  const findings = results.flatMap((r) => r.findings);
  const unresolved = results.flatMap((r) => r.unresolved);
  return { docFiles: docFiles.map((f) => relative(root, f)), findings, unresolved };
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  const root = opts.root ? resolvePath(opts.root) : scriptDefaultRoot();
  if (!existsSync(root)) {
    console.error(`--root does not exist: ${root}`);
    process.exit(2);
  }

  const { docFiles, findings, unresolved } = run(root);

  if (opts.json) {
    console.log(JSON.stringify({ root, docFiles, findings, unresolved }, null, 2));
  } else {
    if (findings.length === 0) {
      console.log(`okf-citations-resolve: clean, ${docFiles.length} doc(s) scanned, 0 findings.`);
    } else {
      console.log(
        `okf-citations-resolve: ${findings.length} finding(s) across ${docFiles.length} doc(s) scanned.\n`,
      );
      for (const f of findings) {
        console.log(`${f.doc}  cites ${f.citation}  [${f.rule}]`);
        console.log(`  ${f.message}`);
      }
    }
    if (unresolved.length > 0) {
      console.log(
        `\n${unresolved.length} citation(s) could not be confidently resolved (ambiguous target(s)), not evaluated:`,
      );
      for (const u of unresolved) {
        console.log(`${u.doc}  cites ${u.citation}  candidates: ${u.candidates.join(", ")}`);
      }
    }
  }

  if (opts.failOnWarn && findings.length > 0) {
    process.exit(1);
  }
  process.exit(0);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);
if (isMain) {
  main();
}
