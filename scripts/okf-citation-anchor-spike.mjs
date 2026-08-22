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
 * Ground truth for the seven old/new line ranges: docs/okf/log.md's
 * 2026-08-22T04:45:51Z entry (task 4f61601d), which lists each citation's
 * pre-fix and post-fix range. NOT PR #184's own body, which does not carry
 * this table. Commit 891821f855ae94de9775505d60adea92d99c5d89 is the tip of
 * the PR #184 branch at which `merge-approval-gate-mechanics.md` still
 * cites the seven OLD (pre-fix) ranges; its immediate parent 5c52c1e does
 * NOT carry identical old values for every citation (e.g. the
 * force-override citation is `:31-37` at 5c52c1e vs `:31-43` at 891821f),
 * so 891821f itself, not its parent, is the fixture commit.
 *
 * Two pairings are measured for strategy (b), and they are NOT the same
 * thing:
 *   - FAITHFUL: 891821f's citing doc against 891821f's OWN
 *     `merge-approval-rollout.md` -- the file that citing doc's author
 *     actually had open. Even this pairing is not clean: verified via
 *     `git show 891821f:docs/okf/merge-approval-gate-mechanics.md` and
 *     `git show 891821f:docs/testing/merge-approval-rollout.md`, three of
 *     the seven citations (`:27-28`, the `:31-43` pair, `:82`) already
 *     resolve to the wrong content at 891821f, against 891821f's OWN
 *     target -- real pre-existing citation drift, not an artefact of this
 *     spike's fixture choice.
 *   - VARIANT: 891821f's citing doc against HEAD's current
 *     `merge-approval-rollout.md` -- a file that citing doc's author never
 *     saw; `merge-approval-rollout.md` was restructured after 891821f (the
 *     "Reviewer flow" heading moved from line 82 to line 83, among other
 *     shifts), so this pairing additionally captures drift introduced by
 *     that later restructuring, not just the original seven.
 * Both pairings are reported below and in docs/okf/log.md, clearly
 * labelled; they are not interchangeable and do not average to one number.
 *
 * Strategy (a): quoted-phrase pairing. For every double-quoted verbatim
 * excerpt in a doc, pair it with the single nearest FOLLOWING citation in
 * document order (not a whole-paragraph window; the reviewer's original
 * prototype used the whole paragraph and caught 1/7 with 12 false
 * positives). Flag the citation if the quoted text does not occur verbatim
 * inside its resolved target range. A replayed drift only counts as a
 * genuine "caught" when it passes two controls:
 *   - NEGATIVE CONTROL: the hand-supplied quote must actually be
 *     extractable by QUOTE_RE from the real citing doc text at 891821f.
 *     QUOTE_RE excludes newlines, so a quote the author hard-wrapped
 *     across two source lines can never be produced by the real
 *     extraction pipeline; such a drift is reported "not extractable", not
 *     counted as caught, regardless of what the range comparison below
 *     would say.
 *   - POSITIVE CONTROL: the strategy must flag the OLD (pre-fix) range and
 *     must NOT flag the NEW (post-fix) range. A strategy that flags both
 *     ranges alike cannot discriminate drifted citations from corrected
 *     ones, so flagging both is not a catch.
 *
 * Strategy (b): named-anchor verification. A citation carries an explicit,
 * author-written anchor naming what it points at -- a function/symbol name
 * for a code target (`cli.ts:178 (countEvidenceFileLines)`), or a section
 * heading for a markdown target. The resolver independently locates that
 * name in the target file (a markdown `## heading`, or -- not exercised
 * here, no such citation exists in the bundle -- a function/const
 * declaration) and flags the citation when its numeric range falls outside
 * the named anchor's span.
 *
 * Strategy (b) requires the anchor to be written at citation time; none of
 * this bundle's real citations carry one today. This script evaluates two
 * different things for (b), kept clearly separate:
 *   - REPLAY (the 7 known drifts, both pairings above): each drifted
 *     citation's anchor is hand-supplied here (see KNOWN_DRIFTS below),
 *     reverse-engineered from the docs/okf/log.md entry's plain-English
 *     label for that citation ("label table", "reviewer cheat sheet",
 *     etc. -- not reverse-engineered from the fix itself). This measures
 *     "if the author had written the obviously-correct anchor, would later
 *     drift be caught" -- it is NOT a blind mechanical measurement.
 *   - FALSE POSITIVES on the current bundle: NOT measured for (b). No
 *     citation in the live bundle carries an anchor, and hand-authoring one
 *     for every citation bundle-wide is out of this spike's scope. Reported
 *     as a known gap, not papered over with a fabricated number.
 *
 * Usage: node scripts/okf-citation-anchor-spike.mjs [--root <dir>]
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  CITATION_RE,
  findDocFiles,
  parseArgs,
  parseFrontmatterSources,
  resolveCitation,
  splitLines,
  hasParentSegment,
} from "./okf-citations-resolve.mjs";

// parseArgs is the exported okf-citations-resolve.mjs parser (--root,
// --json, --fail-on-warn); this script only reads opts.root and ignores the
// other two, which is fine since it never sets them.

function scriptDefaultRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolvePath(here, "..");
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
 * Verifies one (startLine, endLine, anchorHeadingText) against an
 * already-loaded target file's `lines`: does the named heading exist there,
 * and does the cited range fall fully inside its span?
 */
function verifyHeadingAnchorAgainstLines(lines, startLine, endLine, anchorHeadingText) {
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

/**
 * Verifies one (citedPath, startLine, endLine, anchorHeadingText) against
 * the target file as it exists on disk under `root`.
 */
function verifyHeadingAnchor(root, citedPath, startLine, endLine, anchorHeadingText) {
  const full = resolvePath(root, citedPath);
  if (!existsSync(full)) {
    return { ok: false, reason: `target file not found: ${citedPath}` };
  }
  const lines = splitLines(readFileSync(full, "utf8"));
  return verifyHeadingAnchorAgainstLines(lines, startLine, endLine, anchorHeadingText);
}

// ---------------------------------------------------------------------
// The seven known PR #184 drifts (see header doc block for provenance)
// ---------------------------------------------------------------------

// anchorHeadingAtCiting: the heading name as it existed in
// merge-approval-rollout.md at 891821f (used for the FAITHFUL pairing).
// anchorHeadingAtHead: the heading name as it exists in the current
// (working-tree) merge-approval-rollout.md (used for the VARIANT pairing).
// They differ only where the heading itself was renamed after 891821f
// (the "What is NOT enforced yet" -> "What is enforced, and what is still
// honour-system" rename from the docs/okf/log.md 04:45:51Z fix round).
const KNOWN_DRIFTS = [
  {
    label: "label table",
    old: { start: 15, end: 21 },
    new: { start: 19, end: 25 },
    anchorHeadingAtCiting: "How the gate is driven",
    anchorHeadingAtHead: "How the gate is driven",
  },
  {
    label: "force-override paragraph",
    old: { start: 31, end: 43 },
    new: { start: 44, end: 51 },
    anchorHeadingAtCiting: "What is NOT enforced yet",
    anchorHeadingAtHead: "What is enforced, and what is still honour-system",
  },
  {
    label: "committed-evidence paragraph",
    old: { start: 31, end: 43 },
    new: { start: 36, end: 42 },
    anchorHeadingAtCiting: "What is NOT enforced yet",
    anchorHeadingAtHead: "What is enforced, and what is still honour-system",
  },
  {
    label: "task-id sentence",
    old: { start: 27, end: 28 },
    new: { start: 31, end: 32 },
    anchorHeadingAtCiting: "How the gate is driven",
    anchorHeadingAtHead: "How the gate is driven",
    // The one citation with an adjacent double-quoted excerpt: 'The
    // rollout doc confirms: "`task-id` is the PR's head branch name --
    // stable across commits on the branch" (`merge-approval-rollout.md
    // :27-28`).' (891821f docs/okf/merge-approval-gate-mechanics.md:72-74)
    // Verbatim target text (U+2014 em dash) -- do not normalize to a
    // hyphen; the source doc uses this exact character.
    quote: "`task-id` is the PR's head branch name — stable across commits on the branch",
  },
  {
    label: "ALLOWED-verdict citation (second part: 82 -> 99-100)",
    old: { start: 82, end: 82 },
    new: { start: 99, end: 100 },
    // Verbatim target heading text (U+2014 em dash) -- do not normalize.
    anchorHeadingAtCiting: "Reviewer flow — cheat sheet",
    anchorHeadingAtHead: "Reviewer flow — cheat sheet",
  },
  {
    label: "Making the check Required",
    old: { start: 40, end: 67 },
    new: { start: 53, end: 81 },
    anchorHeadingAtCiting: "Making the check Required",
    anchorHeadingAtHead: "Making the check Required",
  },
  {
    label: "reviewer cheat sheet",
    old: { start: 69, end: 82 },
    new: { start: 83, end: 97 },
    // Verbatim target heading text (U+2014 em dash) -- do not normalize.
    anchorHeadingAtCiting: "Reviewer flow — cheat sheet",
    anchorHeadingAtHead: "Reviewer flow — cheat sheet",
  },
];

const DRIFT_TARGET_PATH = "docs/testing/merge-approval-rollout.md";
const DRIFT_CITING_DOC_PATH = "docs/okf/merge-approval-gate-mechanics.md";
const DRIFT_CITING_COMMIT = "891821f855ae94de9775505d60adea92d99c5d89";

function gitShow(root, ref, path) {
  return execFileSync("git", ["-C", root, "show", `${ref}:${path}`], {
    encoding: "utf8",
  });
}

/**
 * Strategy (a) verdict for one drift with a `quote`, applying both
 * controls (see header doc block): NEGATIVE (extractable from the real
 * citing doc at 891821f) and POSITIVE (flags old, does not flag new).
 */
function evaluateStrategyAForDrift(drift, citingDocContent, headTargetLines) {
  const extractedFromCitingDoc = extractQuotes(citingDocContent).some(
    (q) => q.text === drift.quote,
  );
  if (!extractedFromCitingDoc) {
    return "not extractable (quote is not a single-line match in the citing doc at 891821f; QUOTE_RE excludes newlines)";
  }

  const flagsRange = (start, end) => {
    const rangeText = headTargetLines.slice(start - 1, end).join("\n");
    return !rangeText.includes(drift.quote);
  };
  const flagsOld = flagsRange(drift.old.start, drift.old.end);
  const flagsNew = flagsRange(drift.new.start, drift.new.end);

  if (flagsOld && !flagsNew) return "caught";
  if (flagsOld && flagsNew) return "not caught (non-discriminative: flags both old and new range)";
  return "not caught (does not flag the old range)";
}

function replayKnownDrifts(root) {
  let citingDocContent;
  try {
    citingDocContent = gitShow(root, DRIFT_CITING_COMMIT, DRIFT_CITING_DOC_PATH);
  } catch (err) {
    return { error: `could not read ${DRIFT_CITING_COMMIT}:${DRIFT_CITING_DOC_PATH}: ${err.message}` };
  }
  let faithfulTargetContent;
  try {
    faithfulTargetContent = gitShow(root, DRIFT_CITING_COMMIT, DRIFT_TARGET_PATH);
  } catch (err) {
    return { error: `could not read ${DRIFT_CITING_COMMIT}:${DRIFT_TARGET_PATH}: ${err.message}` };
  }
  const faithfulTargetLines = splitLines(faithfulTargetContent);
  const headTargetLines = splitLines(readFileSync(resolvePath(root, DRIFT_TARGET_PATH), "utf8"));

  const rows = [];
  for (const drift of KNOWN_DRIFTS) {
    const row = { label: drift.label, old: drift.old, new: drift.new };

    // Strategy (a): only the "task-id sentence" drift has a nearby quote.
    row.strategyA = drift.quote
      ? evaluateStrategyAForDrift(drift, citingDocContent, headTargetLines)
      : "no quote adjacent to this citation (untestable by (a))";

    // Strategy (b), FAITHFUL pairing: hand-supplied anchor checked against
    // 891821f's OWN target file (the doc the citing author actually saw).
    const faithful = verifyHeadingAnchorAgainstLines(
      faithfulTargetLines,
      drift.old.start,
      drift.old.end,
      drift.anchorHeadingAtCiting,
    );
    row.strategyBFaithful = faithful.ok ? "not-caught (still inside anchor span)" : `caught (${faithful.reason})`;

    // Strategy (b), VARIANT pairing: hand-supplied anchor checked against
    // the CURRENT (HEAD, later-restructured) target file.
    const variant = verifyHeadingAnchor(
      root,
      DRIFT_TARGET_PATH,
      drift.old.start,
      drift.old.end,
      drift.anchorHeadingAtHead,
    );
    row.strategyBVariant = variant.ok ? "not-caught (still inside anchor span)" : `caught (${variant.reason})`;

    rows.push(row);
  }

  return { rows, citingDocContent };
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
  let caughtBFaithful = 0;
  let caughtBVariant = 0;
  for (const row of replay.rows) {
    console.log(
      `${row.label}: old ${row.old.start}-${row.old.end} -> new ${row.new.start}-${row.new.end}`,
    );
    console.log(`  strategy (a) quote-pairing:        ${row.strategyA}`);
    console.log(`  strategy (b) named anchor FAITHFUL: ${row.strategyBFaithful}`);
    console.log(`  strategy (b) named anchor VARIANT:  ${row.strategyBVariant}`);
    if (row.strategyA === "caught") caughtA += 1;
    if (row.strategyBFaithful.startsWith("caught")) caughtBFaithful += 1;
    if (row.strategyBVariant.startsWith("caught")) caughtBVariant += 1;
  }
  console.log(`\nStrategy (a) catch rate: ${caughtA}/${KNOWN_DRIFTS.length}`);
  console.log(
    `Strategy (b) catch rate, FAITHFUL pairing (891821f citing doc vs 891821f's own target): ${caughtBFaithful}/${KNOWN_DRIFTS.length} (hand-supplied anchors, see header)`,
  );
  console.log(
    `Strategy (b) catch rate, VARIANT pairing (891821f citing doc vs HEAD target): ${caughtBVariant}/${KNOWN_DRIFTS.length} (hand-supplied anchors, see header)`,
  );

  console.log("\n=== False positives on the current bundle (HEAD) ===\n");
  const fpA = measureStrategyAFalsePositivesAtHead(root);
  console.log(
    `Strategy (a): ${fpA.docsScanned} doc(s) scanned, ${fpA.pairsEvaluated} quote/citation pair(s) evaluated, ${fpA.flagged.length} false positive(s). (Boundary: this counts pairs across every doc findDocFiles(root) returns, including docs/okf/log.md itself, which is scanned like any other doc in the bundle.)`,
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
