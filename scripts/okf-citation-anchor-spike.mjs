#!/usr/bin/env node
/**
 * Task 42c5d5fd spike: does anchoring a citation to something other than a
 * bare `path:N[-M]` catch semantic drift (a citation that still lands on
 * real, non-blank, in-range content, just the WRONG content)?
 * scripts/okf-citations-resolve.mjs (PR #185) is provably blind to this: all
 * seven of the citation drifts hand-caught in PR #184 landed on non-blank,
 * in-range lines of `docs/testing/merge-approval-rollout.md`.
 *
 * This script is throwaway spike tooling, not wired into CI or
 * `check:okf-citations`. It measures two anchoring strategies against a
 * reconstruction of those seven real drifts plus the current (HEAD) bundle,
 * and prints a report. See docs/okf/log.md for the promotion decision.
 *
 * Ground truth: PR #184's own body names the seven drifted citations inside
 * `docs/okf/merge-approval-gate-mechanics.md` (all citing
 * `docs/testing/merge-approval-rollout.md`) by their OLD (wrong) and NEW
 * (fixed) line ranges. Commit 891821f855ae94de9775505d60adea92d99c5d89 is
 * the tip of the PR #184 branch before the round that fixed these citations
 * (its own `merge-approval-gate-mechanics.md` still carries the seven old
 * ranges) but before `merge-approval-rollout.md` was restructured further
 * in that same fix round. Reconstructing the drift: 891821f's OLD citation
 * text, resolved against HEAD's CURRENT `merge-approval-rollout.md`,
 * reproduces exactly the "citation still resolves, to the wrong place"
 * state PR #184 caught by hand. Verified against `git show 891821f:...` and
 * `git show 5c52c1e:...` (891821f's own parent, same old values) --- see
 * this task's implementer report for the full derivation.
 *
 * Strategy (a): quoted-phrase pairing. For every double-quoted verbatim
 * excerpt in a doc, pair it with the single nearest FOLLOWING citation in
 * document order (not a whole-paragraph window; the reviewer's original
 * prototype used the whole paragraph and caught 1/7 with 12 false
 * positives). Flag the citation if the quoted text does not occur verbatim
 * inside its resolved target range.
 *
 * Strategy (b): named-anchor verification. A citation carries an explicit,
 * author-written anchor naming what it points at -- a function/symbol name
 * for a code target (`cli.ts:178 (countEvidenceFileLines)`), or a section
 * heading for a markdown target. The resolver independently locates that
 * name in the CURRENT target file (a markdown `## heading`, or -- not
 * exercised here, no such citation exists in the bundle -- a function/const
 * declaration) and flags the citation when its numeric range falls outside
 * the named anchor's span.
 *
 * Strategy (b) requires the anchor to be written at citation time; none of
 * this bundle's real citations carry one today. This script evaluates two
 * different things for (b), kept clearly separate:
 *   - REPLAY (the 7 known drifts): each drifted citation's anchor is
 *     hand-supplied here (--anchor below), reverse-engineered from PR
 *     #184's own plain-English label for that citation ("label table",
 *     "reviewer cheat sheet", etc., taken verbatim from the PR body/log
 *     entry -- not reverse-engineered from the fix itself). This measures
 *     "if the author had written the obviously-correct anchor, would later
 *     drift be caught" -- it is NOT a blind mechanical measurement.
 *   - FALSE POSITIVES on the current bundle: NOT measured for (b). No
 *     citation in the live bundle carries an anchor, and hand-authoring one
 *     for every citation bundle-wide is out of this spike's scope. Reported
 *     as a known gap, not papered over with a fabricated number.
 *
 * Usage: node scripts/okf-citation-anchor-spike.mjs [--root <dir>]
 */

import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  CITATION_RE,
  findDocFiles,
  parseFrontmatterSources,
  resolveCitation,
  splitLines,
  hasParentSegment,
} from "./okf-citations-resolve.mjs";

function scriptDefaultRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolvePath(here, "..");
}

function parseArgs(argv) {
  const opts = { root: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root") {
      opts.root = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`unrecognized argument: ${argv[i]}`);
    }
  }
  return opts;
}

// ---------------------------------------------------------------------
// Strategy (a): quoted-phrase -> nearest following citation
// ---------------------------------------------------------------------

const QUOTE_RE = /"([^"\n]{3,200})"/g;

/** Every double-quoted excerpt in `content`, in document order. */
function extractQuotes(content) {
  const quotes = [];
  const re = new RegExp(QUOTE_RE.source, "g");
  let m;
  while ((m = re.exec(content)) !== null) {
    quotes.push({ index: m.index, text: m[1] });
  }
  return quotes;
}

/** Every full `path:N[-M]` citation in `content`, in document order. */
function extractCitations(content) {
  const citations = [];
  const re = new RegExp(CITATION_RE.source, "g");
  let m;
  while ((m = re.exec(content)) !== null) {
    citations.push({
      index: m.index,
      citedPath: m[1],
      startLine: Number(m[2]),
      endLine: m[3] ? Number(m[3]) : null,
    });
  }
  return citations;
}

/** For each quote, the nearest citation strictly after it (or null). */
function pairQuotesToNearestFollowingCitation(quotes, citations) {
  const pairs = [];
  for (const q of quotes) {
    let nearest = null;
    for (const c of citations) {
      if (c.index > q.index && (nearest === null || c.index < nearest.index)) {
        nearest = c;
      }
    }
    if (nearest) pairs.push({ quote: q, citation: nearest });
  }
  return pairs;
}

/** Resolves one citation to `{lines, resolvedPath}` or null (unresolvable). */
function resolveTargetLines(root, docPath, docContent, sources, citation) {
  if (hasParentSegment(citation.citedPath)) return null;
  const resolution = resolveCitation(
    root,
    docPath,
    docContent,
    sources,
    citation.citedPath,
    citation.index,
  );
  if (!resolution || resolution.skip || resolution.ambiguous) return null;
  const content = readFileSync(resolution.path, "utf8");
  const lines = splitLines(content);
  const start = citation.startLine;
  const end = citation.endLine ?? citation.startLine;
  if (start < 1 || end > lines.length || end < start) return null;
  return { lines: lines.slice(start - 1, end), resolvedPath: resolution.path };
}

/** Runs strategy (a) over one doc's content; returns flagged pairs. */
function runStrategyAOnDoc(root, docPath, docContent) {
  const sources = parseFrontmatterSources(docContent);
  const quotes = extractQuotes(docContent);
  const citations = extractCitations(docContent);
  const pairs = pairQuotesToNearestFollowingCitation(quotes, citations);

  const flagged = [];
  for (const { quote, citation } of pairs) {
    const target = resolveTargetLines(root, docPath, docContent, sources, citation);
    if (!target) continue; // can't evaluate; not this strategy's job to guess
    const rangeText = target.lines.join("\n");
    if (!rangeText.includes(quote.text)) {
      flagged.push({ quote: quote.text, citation, resolvedPath: target.resolvedPath });
    }
  }
  return { pairsEvaluated: pairs.length, flagged };
}

// ---------------------------------------------------------------------
// Strategy (b): named anchor (markdown heading) verification
// ---------------------------------------------------------------------

/** `[{ text, startLine, endLine }]` for every `##`+ heading in `lines`. */
function extractHeadings(lines) {
  const headings = [];
  lines.forEach((line, i) => {
    const m = line.match(/^#{2,6}\s+(.*\S)\s*$/);
    if (m) headings.push({ text: m[1], startLine: i + 1, endLine: null });
  });
  for (let i = 0; i < headings.length; i += 1) {
    headings[i].endLine =
      i + 1 < headings.length ? headings[i + 1].startLine - 1 : lines.length;
  }
  return headings;
}

/**
 * Verifies one (citedPath, startLine, endLine, anchorHeadingText) against
 * the current target file: does the named heading still exist, and does
 * the cited range fall fully inside its current span?
 */
function verifyHeadingAnchor(root, citedPath, startLine, endLine, anchorHeadingText) {
  const full = resolvePath(root, citedPath);
  const lines = splitLines(readFileSync(full, "utf8"));
  const headings = extractHeadings(lines);
  const heading = headings.find((h) => h.text === anchorHeadingText);
  if (!heading) {
    return { ok: false, reason: `anchor heading not found: "${anchorHeadingText}"` };
  }
  const last = endLine ?? startLine;
  if (startLine < heading.startLine || last > heading.endLine) {
    return {
      ok: false,
      reason: `range ${startLine}-${last} falls outside "${anchorHeadingText}" (now ${heading.startLine}-${heading.endLine})`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------
// The seven known PR #184 drifts (see header doc block for provenance)
// ---------------------------------------------------------------------

const KNOWN_DRIFTS = [
  {
    label: "label table",
    old: { start: 15, end: 21 },
    new: { start: 19, end: 25 },
    anchorHeading: "How the gate is driven",
  },
  {
    label: "force-override paragraph",
    old: { start: 31, end: 43 },
    new: { start: 44, end: 51 },
    anchorHeading: "What is enforced, and what is still honour-system",
  },
  {
    label: "committed-evidence paragraph",
    old: { start: 31, end: 43 },
    new: { start: 36, end: 42 },
    anchorHeading: "What is enforced, and what is still honour-system",
  },
  {
    label: "task-id sentence",
    old: { start: 27, end: 28 },
    new: { start: 31, end: 32 },
    anchorHeading: "How the gate is driven",
    // The one citation with an adjacent double-quoted excerpt: 'The
    // rollout doc confirms: "`task-id` is the PR's head branch name --
    // stable across commits on the branch" (`merge-approval-rollout.md
    // :27-28`).' (891821f docs/okf/merge-approval-gate-mechanics.md:72-74)
    quote: "`task-id` is the PR's head branch name — stable across commits on the branch",
  },
  {
    label: "ALLOWED-verdict citation (second part: 82 -> 99-100)",
    old: { start: 82, end: 82 },
    new: { start: 99, end: 100 },
    anchorHeading: "Reviewer flow — cheat sheet",
  },
  {
    label: "Making the check Required",
    old: { start: 40, end: 67 },
    new: { start: 53, end: 81 },
    anchorHeading: "Making the check Required",
  },
  {
    label: "reviewer cheat sheet",
    old: { start: 69, end: 82 },
    new: { start: 83, end: 97 },
    anchorHeading: "Reviewer flow — cheat sheet",
  },
];

const DRIFT_TARGET_PATH = "docs/testing/merge-approval-rollout.md";
const DRIFT_CITING_COMMIT = "891821f855ae94de9775505d60adea92d99c5d89";

function gitShow(root, ref, path) {
  return execFileSync("git", ["-C", root, "show", `${ref}:${path}`], {
    encoding: "utf8",
  });
}

function replayKnownDrifts(root) {
  const driftingDocPath = "docs/okf/merge-approval-gate-mechanics.md";
  let driftingDocContent;
  try {
    driftingDocContent = gitShow(root, DRIFT_CITING_COMMIT, driftingDocPath);
  } catch (err) {
    return { error: `could not read ${DRIFT_CITING_COMMIT}:${driftingDocPath}: ${err.message}` };
  }

  const rows = [];
  for (const drift of KNOWN_DRIFTS) {
    const row = { label: drift.label, old: drift.old, new: drift.new };

    // Strategy (a): only the "task-id sentence" drift has a nearby quote.
    if (drift.quote) {
      const rangeLines = splitLines(readFileSync(resolvePath(root, DRIFT_TARGET_PATH), "utf8")).slice(
        drift.old.start - 1,
        drift.old.end,
      );
      row.strategyA = rangeLines.join("\n").includes(drift.quote)
        ? "not-caught (quote found in old range)"
        : "caught";
    } else {
      row.strategyA = "no quote adjacent to this citation (untestable by (a))";
    }

    // Strategy (b): hand-supplied anchor (see header doc block), checked
    // mechanically against the CURRENT target file.
    const verdict = verifyHeadingAnchor(
      root,
      DRIFT_TARGET_PATH,
      drift.old.start,
      drift.old.end,
      drift.anchorHeading,
    );
    row.strategyB = verdict.ok ? "not-caught (still inside anchor span)" : `caught (${verdict.reason})`;

    rows.push(row);
  }

  return { rows, driftingDocContent };
}

// ---------------------------------------------------------------------
// False positives on the current (HEAD) bundle
// ---------------------------------------------------------------------

function measureStrategyAFalsePositivesAtHead(root) {
  const docFiles = findDocFiles(root);
  let pairsEvaluated = 0;
  const flagged = [];
  for (const docPath of docFiles) {
    const content = readFileSync(docPath, "utf8");
    const { pairsEvaluated: n, flagged: f } = runStrategyAOnDoc(root, docPath, content);
    pairsEvaluated += n;
    for (const item of f) {
      flagged.push({ doc: relative(root, docPath), ...item });
    }
  }
  return { docsScanned: docFiles.length, pairsEvaluated, flagged };
}

// ---------------------------------------------------------------------
// main
// ---------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = opts.root ? resolvePath(opts.root) : scriptDefaultRoot();

  console.log("=== Replay of the seven known PR #184 drifts ===\n");
  const replay = replayKnownDrifts(root);
  if (replay.error) {
    console.error(replay.error);
    process.exit(1);
  }
  let caughtA = 0;
  let caughtB = 0;
  for (const row of replay.rows) {
    console.log(
      `${row.label}: old ${row.old.start}-${row.old.end} -> new ${row.new.start}-${row.new.end}`,
    );
    console.log(`  strategy (a) quote-pairing: ${row.strategyA}`);
    console.log(`  strategy (b) named anchor:  ${row.strategyB}`);
    if (row.strategyA.startsWith("caught")) caughtA += 1;
    if (row.strategyB.startsWith("caught")) caughtB += 1;
  }
  console.log(`\nStrategy (a) catch rate: ${caughtA}/${KNOWN_DRIFTS.length}`);
  console.log(`Strategy (b) catch rate: ${caughtB}/${KNOWN_DRIFTS.length} (hand-supplied anchors, see header)`);

  console.log("\n=== False positives on the current bundle (HEAD) ===\n");
  const fpA = measureStrategyAFalsePositivesAtHead(root);
  console.log(
    `Strategy (a): ${fpA.docsScanned} doc(s) scanned, ${fpA.pairsEvaluated} quote/citation pair(s) evaluated, ${fpA.flagged.length} false positive(s).`,
  );
  for (const f of fpA.flagged) {
    console.log(`  FALSE POSITIVE: ${f.doc} quote "${f.quote}" vs ${f.citation.citedPath}:${f.citation.startLine}${f.citation.endLine ? "-" + f.citation.endLine : ""}`);
  }
  console.log(
    "\nStrategy (b): false positives NOT measured -- no citation in the live bundle carries",
    "\nan anchor today; hand-authoring one per citation bundle-wide is out of this spike's scope.",
  );
}

main();
