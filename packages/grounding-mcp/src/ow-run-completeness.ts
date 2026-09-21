// Orchestrator-workflow (OW) run-completeness reader.
//
// Pure, side-effect-free read of a repo's OW run files. It answers one
// question: is the *active* OW run process-complete (handoff accepted, review
// recommended accept, no unresolved high/critical findings, and findings
// actually transferred into the table — or the placeholder row deleted for a
// genuine zero-findings review)?
//
// This module only READS. It is consumed later (separate slice) by
// solution-verdict.ts to add an OW-process arm to the acceptance gate; nothing
// here writes, spawns, or mutates.
//
// Design notes:
//   - Marker-first: each OW run file carries a machine-readable marker line
//     (`<!-- solution-acceptance: <field> = <value> -->`). We prefer it.
//   - Fail-closed prose fallback: a repo still on the pre-marker OW kit has no
//     marker, so we fall back to the prose `## ...` value line. An unfilled
//     placeholder (the pipe-joined enum legend), a `TODO` sentinel, a missing
//     line, or a missing file all resolve to "not accepted" — never to a
//     silent pass. A marker still carrying the template's `TODO` placeholder
//     surfaces its OWN reason (never the misleading "no marker" one) and never
//     falls back to prose. Acceptance markers capture only word-shaped enum
//     values, so sloppy spacing (`= accepted-->`) cannot swallow the comment
//     terminator. First marker match wins; a quoted mention of marker syntax
//     earlier in the file shadowing the real marker is a known non-goal (run
//     files are agent-authored, honor-system).
//   - The shipped review template seeds the Findings table with a legend /
//     placeholder row whose Severity and Decision cells are slash-lists
//     (`low/medium/high/critical`, `accepted/defer` since OW kit 0.7.4, which
//     narrowed the Decision legend to the two resolved values; every other
//     decision arms the gate, see the next note). That row is
//     not a real finding; we decide whether a row is a real finding by its
//     SEVERITY cell carrying a single concrete value (the slash-list legend is
//     therefore skipped), and only then judge the Decision.
//   - Mixed-state bypass guard: the placeholder row above is not itself a
//     finding, but its untouched presence with NO concrete-severity finding
//     row anywhere is a signal that findings were never transferred — an
//     operator can flip the solution-acceptance markers to an accepted value
//     without ever touching the table, and the marker checks above alone
//     would pass it. The reader recognizes the placeholder row by a
//     byte-exact match of the COMPLETE shipped row (every cell, including the
//     Category legend and the two HTML-comment cells — not just the Severity
//     slash-list, so a differently worded legend, e.g. a stale pre-0.7.4
//     fixture, does not match and is handled by the skip-path above as
//     before). Normalization is bounded to what any table row already gets
//     (whole-line trim, split on `|`, per-cell trim) — nothing extra. When
//     the placeholder row survives AND no row anywhere carries a concrete
//     severity, the run is `complete: false` with a reason naming both escape
//     hatches: transfer the reviewer's findings into the table, or delete the
//     placeholder row for a genuine zero-findings review. A header row with no
//     data rows at all (the row already deleted) stays `complete: true`, and a
//     concrete finding row sitting next to a left-behind placeholder row is
//     unaffected (still valid, as before). Lockstep: the exact row text is
//     exported as `OW_FINDINGS_PLACEHOLDER_ROW` and pinned by a reciprocal
//     test against agent-dx's
//     packages/orchestrator-workflow/assets/templates/05-review-findings.md
//     and its test/template-markers.test.ts.
//   - Fail-closed findings arming: a row with a concrete high/critical severity
//     ARMS the gate (blocks) UNLESS its Decision is explicitly resolved
//     ({accepted, defer}). So fix, reject, blank, `open`, `TODO`, and any
//     unrecognized decision all BLOCK — an undecided high/critical never passes.
//   - The findings tables are located by anchoring on table HEADER ROWS (cells
//     include both `Severity` and `Decision`), not the `## Findings` heading
//     text, so a drifted heading (`## Findings (summary)`) cannot fail open.
//     ALL such tables are parsed (a second review round may append a new
//     table); a findings section with content but no table anywhere yields an
//     explicit format blocker instead of silently reporting zero findings.
//   - Change binding: the reader also EXTRACTS the `run-base` marker from the
//     run's `00-goal.md` (raw string, `TODO` → absent) and the run dir name.
//     Verifying that binding against the current git change (ancestry, fork
//     point, date heuristic) is the verdict layer's job — this module stays
//     free of subprocess calls.
//   - Active-run resolution, pointer-first: the caller's worktree root (found
//     by walking up from `repoPath` for the nearest `.git` entry, file,
//     directory, OR dangling symlink — an `fs.lstatSync` presence check, so a
//     broken `.git` symlink still marks the root) may carry a `.ai/run`
//     pointer file naming the absolute path of the run directory OW is
//     actively working. When present, that pointer wins outright over the
//     newest-run scan — a run is session-shaped (the worktree the agent is
//     sitting in) while the newest-by-date scan is only a best-effort proxy.
//     The scan of `<repoPath>/.ai/runs/` is used ONLY when no pointer file
//     exists at all. A pointer file that exists but does not resolve
//     (unreadable, empty, a relative path, a target that is missing / not a
//     directory / not date-prefixed) is a DISTINCT fail-closed blocker — it
//     never silently falls back to the scan, since a broken pointer left
//     behind is itself a signal something is wrong. The pointer's target is
//     resolved with `fs.realpathSync` before any of those checks — symlinks
//     are resolved, so the run's identity is its real directory (a symlinked
//     target whose real basename is not date-prefixed is rejected the same as
//     any other non-dated target). The resolution channel actually used is
//     reported via `runSource`.
//   - Keyed run-base selection: a repo may appear under more than one basename
//     across a monorepo/fleet (the worktree's own basename, and — for a
//     linked git worktree — the main repository's basename, resolved via the
//     worktree's `gitdir:` pointer and `commondir`). The `run-base` marker in
//     `00-goal.md` may therefore be keyed per repo (`run-base[<key>] = <sha>`,
//     one line per repo bound to the run) alongside the legacy unkeyed
//     `run-base = <sha>`. Keyed markers are a GRAMMAR, not a single regex: a
//     candidate line is checked as a WHOLE-LINE HTML comment (leading/trailing
//     whitespace only) against a strict shape
//     `<!-- solution-acceptance: run-base[<key>] = <value> -->`. That strict
//     shape stays EXACT — the same exactness the legacy unkeyed matcher
//     already demands: lowercase `solution-acceptance:` and `run-base`, no
//     whitespace before the colon, exactly two dashes in the comment opener.
//     The LOOSE net that decides whether a line was an ATTEMPT at a keyed
//     marker is deliberately more tolerant than that: case-insensitive,
//     whitespace allowed around the colon and before the bracket, one or more
//     dashes after `<!`. A line the loose net catches but the strict shape
//     rejects is a MALFORMED marker line — collected and surfaced as its own
//     fail-closed blocker (`runBaseKind: 'malformed'`) rather than silently
//     falling through to the legacy date heuristic. The loose net stays
//     anchored at the LINE START (it widens the strict shape's own tokens,
//     case, spacing, dash count, not the line position); a THIRD, position-
//     independent check widens coverage further: any line anywhere in the
//     file that names both exact, case-sensitive tokens `solution-acceptance`
//     and `run-base` (a list bullet (`- <!-- ... -->`), a marker embedded in
//     prose, a bare `run-base[k] = <sha>` with no comment wrapper, an attempt
//     preceded by leading text, or a whole-line comment deviating in those
//     tokens, e.g. the colon omitted) is ALSO collected as malformed unless
//     it is already accepted as a well-formed keyed or unkeyed marker. An
//     attempted-but-unreadable marker is worse than no marker at all: it
//     signals the run intended to bind a `run-base` and failed, which must
//     block rather than silently fall through to the legacy date heuristic.
//     QUOTATION EXEMPTION (orchestrator decision D-027, round 2 of task
//     6da2c230, amending round 1's fence choice above; round 3 tightened both
//     nets below): a phrase occurrence that is entirely inside backtick-
//     delimited inline code, or entirely inside a FENCED code block, reads as
//     a QUOTATION of the marker syntax, not an attempted marker, and does not
//     trip THIS position-independent phrase check. This is a HEURISTIC, not a
//     CommonMark parser, and stays deliberately narrow rather than
//     approximating full Markdown rendering: an inline span is a single
//     backtick pair (double/triple-backtick inline delimiters are not
//     recognised) that may cross line breaks but never a BLANK line: a code
//     span cannot contain a paragraph break, so two stray backticks
//     separated by a blank line never pair with each other. A fenced block is
//     any line, indented up to 3 spaces, starting with a run of 3+ backticks
//     or 3+ tildes; a fence CLOSES only on a later line whose run is the SAME
//     character and AT LEAST AS LONG (a `~~~` line inside a ``` fence does
//     not close it, and the reverse holds too, same requirement). An opener with no matching
//     closer anywhere after it fences NOTHING (fails closed: neither the
//     opener line nor anything after it is exempt), rather than exempting
//     everything to end of file. A blockquoted fence (`> \`\`\``) is NOT
//     recognised as a fence at all: the `> ` prefix is not stripped, so its
//     backtick run neither opens nor closes fence state (fails closed).
//     Residual: an unrecognised backtick fence's own backticks stay ordinary
//     characters to the single-backtick inline-span pass below, so leftovers
//     from two such lines (e.g. two ``` lines indented 4+ spaces) pair around
//     a marker attempt between them with no blank line and exempt it: wanted
//     for a fence nested under a list item (a quotation), fail-open when such
//     a line sits outside any list. Pinned by a test; tildes never pair.
//     Only this third net is quoting-aware; the loose-net keyed-attempt check
//     above is NOT (a genuine keyed-marker attempt at the line start still
//     blocks the same way whether or not it sits inside a fence: this is a
//     deliberate ASYMMETRY: only the phrase net treats a fence or code span
//     as quotation, a line-start keyed attempt, well-formed or malformed, is
//     read or blocked inside a fence exactly as outside it). A phrase
//     occurrence that survives quoting removal, including one on a line that
//     ALSO carries a code span elsewhere when the phrase itself sits outside
//     it, still blocks, unchanged. This narrows round 1's stance (a fence was
//     previously never an excuse); the residual left standing is narrower
//     still: only a `00-goal.md` with NO UNQUOTED line naming both tokens
//     anywhere reads as truly MARKERLESS and falls through to the legacy date
//     heuristic (fail-open by design, the kit's documented markerless path).
//     A separate, ACCEPTED residual: a purely QUOTED unkeyed marker that is
//     the only occurrence of the marker tokens in the file is still resolved
//     by the legacy substring matcher (`matchMarker`), which is not
//     quote-aware at all; quoting exempts a line from the malformed-phrase
//     check, it does not stop the unkeyed resolver from reading a value out
//     of it.
//     Malformed lines caught by the third (phrase) net report a DIFFERENT
//     reason than lines caught by the loose keyed-attempt net: the keyed
//     hint (`expected '<!-- solution-acceptance: run-base[<key>] = <sha>
//     -->' ...`) is misleading for a phrase-only hit (prose, a quoted
//     regex) that never attempted keyed bracket syntax, so phrase-only hits
//     get their own wording naming the tokens found rather than the keyed
//     shape. A strict match whose key is
//     documentation example, not a marker, and is skipped the same way (not counted as present); an example that itself deviates
//     from the strict shape is an attempt like any other and blocks as malformed. All well-formed keyed markers are
//     collected in a single scan (first occurrence per key wins on a
//     duplicate, case-insensitive). Selection tries each applicable key in
//     order (the worktree's own basename first, then the main repo's, when
//     they differ), matching keys CASE-INSENSITIVELY, and the FIRST key with a
//     matching well-formed keyed marker decides — its value, or null for
//     `TODO` — without falling through to a later key or to the unkeyed
//     marker. When NO well-formed keyed marker matches any candidate key, an
//     unkeyed marker (if present) is still used, exactly as before this
//     feature existed. When malformed marker lines were found alongside a
//     value that WAS selected (keyed match or unkeyed fallback), that value is
//     still returned, but the malformed blocker is ALSO reported (the run is
//     not complete). When keyed markers ARE present, NONE matches, AND no
//     unkeyed marker exists either, that is an explicit fail-closed blocker
//     (not a silent null run-base): the reason names both the keys actually
//     present in the file and the keys that were tried — UNLESS malformed
//     lines were also found in that same situation, in which case the
//     malformed blocker takes priority (`runBaseKind: 'malformed'`) over the
//     `'unmatched-keyed'` one, since a malformed line is evidence of an
//     attempted-but-broken marker rather than merely a missing one. Documented
//     asymmetry: the legacy UNKEYED `run-base` matcher (`matchMarker`) is not
//     line-anchored (a substring match anywhere in the file), resolves values
//     exactly as before this change, and is unaffected by the keyed grammar
//     hardening. The phrase check's UNKEYED exemption tracks that same
//     resolver grammar (round 2 of task 6da2c230, review finding 1): a line
//     is exempt when it starts (after optional leading whitespace) with
//     `<!--` followed by `solution-acceptance:` (whitespace, no space before
//     the colon, the exact literal `matchMarker` requires), whitespace,
//     `run-base`, whitespace, `=`, whitespace, and a non-whitespace value,
//     REGARDLESS of what follows that value on the line: an unkeyed marker
//     whose value is followed by a trailing annotation, or one left with an
//     unclosed comment, both included. The earlier whole-line-only shape
//     under-matched relative to what the resolver actually reads a value
//     from, so a legitimately resolving annotated unkeyed marker was both
//     used AND reported malformed; this exemption closes that gap without
//     widening what the resolver itself accepts. Anchored by a corpus
//     measurement, see CHANGELOG 0.10.0.

import fs from 'node:fs';
import path from 'node:path';

export interface OwRunCompleteness {
  /**
   * true iff an OW run dir was found via the pointer or at
   * `<repoPath>/.ai/runs/` — ALSO true for the fail-closed invalid-pointer
   * state (a pointer file exists but does not resolve): OW is known to apply
   * to this repo, it is just blocked, which is a distinct case from "no
   * pointer and no `.ai/runs/` dir" (`enforced: false`, OW does not apply).
   */
  enforced: boolean;
  /** true iff the active run is process-complete (only meaningful when enforced). */
  complete: boolean;
  /** One specific message per failed condition (empty when complete). */
  reasons: string[];
  /** Basename of the active run dir (e.g. `2026-07-02-slug`), null when not enforced. */
  runName: string | null;
  /**
   * `run-base` binding marker from the run's `00-goal.md` (the repo HEAD sha
   * recorded at run creation), or null when the marker is absent or still the
   * `TODO` placeholder. The reader only EXTRACTS the value; git verification
   * against the current change happens in solution-verdict.ts.
   */
  runBase: string | null;
  /**
   * Which channel resolved (or attempted to resolve) the active run:
   * `'pointer'` whenever the worktree's `.ai/run` pointer file was the
   * deciding channel — including the invalid-pointer blocker, where the
   * pointer channel decided NOT to resolve (and thus never fell back to the
   * scan) — `'scan'` when no pointer file existed and the newest-run scan of
   * `<repoPath>/.ai/runs/` found one, or `null` when neither found a run
   * (not enforced).
   */
  runSource: 'pointer' | 'scan' | null;
  /**
   * WHY `runBase` has the value it has, so the verdict layer (`solution-verdict.ts`)
   * can branch without re-deriving `selectRunBase`'s key logic:
   *   - `'sha'`: a marker value was selected (keyed or unkeyed; raw, unvalidated)
   *     — `runBase` is non-null.
   *   - `'todo'`: the selected marker (keyed or unkeyed) still carries the
   *     template's `TODO` placeholder — `runBase` is null.
   *   - `'absent'`: no applicable marker at all (no goal file, OW not
   *     enforced, or a goal file with neither a matching keyed marker nor an
   *     unkeyed one to begin with) — `runBase` is null.
   *   - `'unmatched-keyed'`: well-formed keyed markers ARE present in
   *     `00-goal.md`, none matches this worktree's candidate keys, no unkeyed
   *     marker exists either, and no malformed keyed marker line was found —
   *     the reader has already pushed its own explicit blocker reason into
   *     `reasons` for this case — `runBase` is null.
   *   - `'malformed'`: at least one line names both marker tokens
   *     (`solution-acceptance` and `run-base`) but is not accepted as a
   *     well-formed keyed or unkeyed marker (see the module docstring), AND
   *     no well-formed keyed marker matched a candidate key, AND no unkeyed
   *     marker exists, the reader
   *     has already pushed its own explicit blocker reason into `reasons` —
   *     `runBase` is null. When a malformed line coexists with a value that
   *     WAS selected (keyed match or unkeyed fallback), `runBaseKind` stays
   *     `'sha'`/`'todo'` for that value, but the malformed blocker is still
   *     pushed into `reasons` (the run is not complete either way).
   */
  runBaseKind: 'sha' | 'todo' | 'absent' | 'unmatched-keyed' | 'malformed';
}

interface UnresolvedFinding {
  severity: string;
  description: string;
  decision: string;
}

const ACCEPTED_FINAL_STATUS = new Set(['accepted', 'accepted_with_notes']);
const ACCEPT_RECOMMENDATION = new Set(['accept', 'accept_with_notes']);
const CONCRETE_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const ARMING_SEVERITIES = new Set(['high', 'critical']);
// A high/critical finding is resolved (does NOT arm) ONLY for these decisions.
// Every other decision — fix, reject, blank, `open`, `TODO`, unknown — blocks.
const RESOLVED_DECISIONS = new Set(['accepted', 'defer']);
// Run dirs must carry an ISO date prefix to be eligible as the active run.
const DATED_RUN_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

/**
 * The exact literal text of the shipped review template's placeholder /
 * legend row (agent-dx repo,
 * packages/orchestrator-workflow/assets/templates/05-review-findings.md).
 * Exported ONLY so tests can pin it directly against the known template
 * string (see this package's ow-run-completeness.test.ts reciprocal pinning
 * test) and, by hand, against agent-dx's own
 * packages/orchestrator-workflow/test/template-markers.test.ts pin — the two
 * repos are lockstep-coupled on this row and must be kept in sync manually.
 */
export const OW_FINDINGS_PLACEHOLDER_ROW =
  '| low/medium/high/critical | correctness/architecture/security/tests/maintainability/performance/docs | <!-- finding --> | <!-- fix --> | accepted/defer |';

// Cells derived via splitTableRow() itself (not a hand-written duplicate) so
// the placeholder-row match uses EXACTLY the same normalization any table row
// already gets (whole-line trim, split on `|`, per-cell trim) — no more, no
// less. splitTableRow is a hoisted function declaration, so it is already
// defined at this point in module evaluation.
const PLACEHOLDER_ROW_CELLS = splitTableRow(OW_FINDINGS_PLACEHOLDER_ROW);

/**
 * Read the active OW run for `repoPath` and report process-completeness.
 *
 * When `.ai/runs/` is absent or has no run dir, OW does not apply to this repo:
 * `{ enforced: false, complete: false, reasons: ["no .ai/runs/ run directory found"] }`.
 * The caller treats `enforced: false` as an auto-skip.
 */
export function readOwRunCompleteness(repoPath: string): OwRunCompleteness {
  const worktreeRoot = findWorktreeRoot(repoPath) ?? path.resolve(repoPath);
  const pointer = resolveRunPointer(worktreeRoot);

  let activeRun: string | null;
  let runSource: 'pointer' | 'scan' | null;

  if (pointer.kind === 'invalid') {
    // Distinct fail-closed blocker: a broken pointer file left behind is
    // itself a signal something is wrong, so it NEVER falls back to the
    // newest-run scan (see the module docstring).
    return {
      enforced: true,
      complete: false,
      reasons: [
        `run pointer '${pointer.pointerPath}' does not resolve: ` +
          `${pointer.reason}; fix the pointer to name the absolute path of the run ` +
          `directory, or delete it to fall back to ${repoPath}/.ai/runs/`,
      ],
      runName: null,
      runBase: null,
      runSource: 'pointer',
      runBaseKind: 'absent',
    };
  } else if (pointer.kind === 'run') {
    activeRun = pointer.dir;
    runSource = 'pointer';
  } else {
    activeRun = findActiveRun(repoPath);
    runSource = activeRun === null ? null : 'scan';
  }

  if (activeRun === null) {
    return {
      enforced: false,
      complete: false,
      reasons: ['no .ai/runs/ run directory found'],
      runName: null,
      runBase: null,
      runSource: null,
      runBaseKind: 'absent',
    };
  }

  const handoff = readFileOrNull(path.join(activeRun, '06-handoff.md'));
  const review = readFileOrNull(path.join(activeRun, '05-review-findings.md'));
  const goal = readFileOrNull(path.join(activeRun, '00-goal.md'));
  const reasons: string[] = [];

  const finalStatus = resolveAcceptanceValue(handoff, 'final-status', 'Final Status');
  if (finalStatus.kind === 'todo') {
    reasons.push(
      'handoff final-status marker is still TODO (replace it with the chosen enum value)',
    );
  } else if (finalStatus.kind === 'malformed') {
    reasons.push(
      `handoff final-status marker value '${finalStatus.raw}' is malformed (replace it with one of the enum values)`,
    );
  } else if (finalStatus.kind === 'missing') {
    reasons.push(
      "handoff final-status is unset (no solution-acceptance marker and no filled '## Final Status')",
    );
  } else if (!ACCEPTED_FINAL_STATUS.has(finalStatus.value.toLowerCase())) {
    reasons.push(`handoff final-status is '${finalStatus.value}'`);
  }

  const recommendation = resolveAcceptanceValue(
    review,
    'acceptance-recommendation',
    'Acceptance Recommendation',
  );
  if (recommendation.kind === 'todo') {
    reasons.push(
      'review recommendation marker is still TODO (replace it with the chosen enum value)',
    );
  } else if (recommendation.kind === 'malformed') {
    reasons.push(
      `review recommendation marker value '${recommendation.raw}' is malformed (replace it with one of the enum values)`,
    );
  } else if (recommendation.kind === 'missing') {
    reasons.push(
      "review recommendation is unset (no solution-acceptance marker and no filled '## Acceptance Recommendation')",
    );
  } else if (!ACCEPT_RECOMMENDATION.has(recommendation.value.toLowerCase())) {
    reasons.push(`review recommendation is '${recommendation.value}'`);
  }

  const scan = scanFindings(review);
  for (const f of scan.unresolved) {
    reasons.push(`unresolved ${f.severity} finding: ${f.description} (Decision=${f.decision})`);
  }

  // Mixed-state bypass guard: the shipped placeholder row survived AND no
  // concrete-severity row exists anywhere — findings were never transferred,
  // regardless of what the acceptance markers say. See the module docstring.
  if (scan.placeholderRowSeen && !scan.concreteRowSeen) {
    reasons.push(
      'findings table still contains the shipped template placeholder row with no ' +
        'concrete finding row anywhere in the file — transfer the reviewer\'s findings ' +
        'into the table (replacing the placeholder row), or delete the placeholder row ' +
        'if this is genuinely a zero-findings review',
    );
  }

  const formatBlocker = findingsFormatBlocker(review);
  if (formatBlocker !== null) {
    reasons.push(formatBlocker);
  }

  const methodScan = scanReviewMethodCompliance(review);
  for (const r of methodScan.reasons) {
    reasons.push(r);
  }

  const runBaseSelection = selectRunBase(goal, repoKeys(worktreeRoot));
  for (const r of runBaseSelection.reasons) {
    reasons.push(r);
  }

  return {
    enforced: true,
    complete: reasons.length === 0,
    reasons,
    runName: path.basename(activeRun),
    runBase: runBaseSelection.runBase,
    runSource,
    runBaseKind: runBaseSelection.runBaseKind,
  };
}

/** Result of resolving the `run-base` binding marker for one worktree. */
interface RunBaseSelection {
  /** The bound sha (raw, unvalidated), or null when absent/`TODO`/blocked. */
  runBase: string | null;
  /** See `OwRunCompleteness.runBaseKind` for the meaning of each value. */
  runBaseKind: 'sha' | 'todo' | 'absent' | 'unmatched-keyed' | 'malformed';
  /**
   * Explicit fail-closed blocker reasons, empty when selection resolved
   * normally with nothing to report (including the ordinary "no marker at
   * all" case, which stays silent). A malformed-marker reason can coexist
   * with a selected `runBase` (keyed match or unkeyed fallback) — see
   * `OwRunCompleteness.runBaseKind`.
   */
  reasons: string[];
}

/** One well-formed `run-base[<key>] = <value>` marker found in a run's `00-goal.md`. */
interface KeyedRunBaseMarker {
  /** The key exactly as authored (trimmed, original case). */
  key: string;
  /** The raw value (unvalidated; may be `TODO`). */
  value: string;
}

/**
 * One line naming the run-base marker tokens without matching a well-formed
 * marker grammar. `kind` distinguishes an attempted KEYED marker (loose net:
 * `run-base[` at the line start) from a bare PHRASE occurrence (third,
 * position-independent net: names both tokens, nothing more specific); see
 * the module docstring for why they get different reasons.
 */
interface MalformedRunBaseLine {
  /** 1-based line number in `goal`. */
  line: number;
  /** Whole, trimmed text of the line. */
  excerpt: string;
  kind: 'keyed-attempt' | 'phrase-only';
}

/** Result of one pass over `goal`'s lines collecting keyed run-base markers. */
interface KeyedMarkerScan {
  /** Well-formed markers, placeholder-keyed ones excluded. First occurrence per key wins. */
  markers: KeyedRunBaseMarker[];
  /** Every line that named the run-base marker tokens without a well-formed match. */
  malformedLines: MalformedRunBaseLine[];
}

// Strict shape: the ENTIRE line (leading/trailing whitespace only) is the
// HTML comment `<!-- solution-acceptance: run-base[<key>] = <value> -->`. The
// `(?!-->)` guard stops a value-less marker (`run-base[k] = -->`) from having
// its `\S+` capture swallow the comment terminator as the value; in practice
// such a line already fails to match at all (there is no room left for the
// literal trailing `-->`), so it naturally falls to the loose net below and
// is reported as malformed rather than resolving to a bogus `'-->' ` value.
const KEYED_RUN_BASE_STRICT =
  /^\s*<!--\s*solution-acceptance:\s*run-base\[([^\]\n]+)\]\s*=\s*(?!-->)(\S+)\s*-->\s*$/;
// Loose net: a whole line that STARTS like an ATTEMPTED keyed marker but is
// not required to satisfy the rest of the strict shape. Deliberately more
// tolerant than the strict shape above, so that a still-recognisable attempt
// BLOCKS as malformed instead of falling through to the legacy date
// heuristic: case-insensitive (`RUN-BASE[`), whitespace around the colon
// (`solution-acceptance : run-base[`), one or more dashes in the comment
// opener (`<!--- `), and stray whitespace before the bracket (`run-base [k]`).
// Anchored at the line start: it exists to widen the STRICT shape's own
// tokens (case, spacing, dash count), not the line position. Line position is
// covered separately by the phrase check below. Any strict match is also a
// loose match, so this is checked only after a strict-match attempt fails.
const KEYED_RUN_BASE_LOOSE_START = /^\s*<!--+\s*solution-acceptance\s*:\s*run-base\s*\[/i;
// A key that is itself an angle-bracket placeholder (`<repo-basename>`,
// `<key>`, ...) — the template's own documentation example, not an authored
// marker. `[^>]*` deliberately excludes `>` so the placeholder must be a
// single bracketed token spanning the whole (already-trimmed) key.
const PLACEHOLDER_KEY = /^<[^>]*>$/;
// The LEGACY UNKEYED marker LINE shape (round 2, review finding 1): a line
// is an unkeyed marker line, exempt from the phrase check below, whatever
// its value resolves to and whatever follows on the line, iff it is a line
// the resolver (`matchMarker`, via `isUnkeyedRunBaseMarkerLine` below) would
// actually read an unkeyed value from, ANCHORED at the line start (after
// optional leading whitespace) with the HTML comment opener. Anchoring to
// the line start (unlike `matchMarker` itself, which is a bare substring
// search) keeps this exemption narrow: it recognises an attempted `<!--
// solution-acceptance: run-base = ...` comment specifically, not any bare
// mid-line mention of the resolver's grammar. Deliberately NOT required to
// close its own comment (`-->`) or stop at the value (unlike the old
// whole-line-only shape this replaces): an unkeyed marker whose value is
// followed by a trailing annotation resolves a value via the same substring
// search `matchMarker` performs and must not ALSO be reported malformed for
// it. Anchored by a corpus measurement, see CHANGELOG 0.10.0.
const UNKEYED_RUN_BASE_LINE_START = /^\s*<!--\s*solution-acceptance:\s*run-base\s*=\s*\S+/;
/**
 * True when `line` is a line the legacy unkeyed matcher (`matchMarker` with
 * field `run-base`) would read a value from, anchored at the line start (see
 * `UNKEYED_RUN_BASE_LINE_START`). Reuses `matchMarker` itself rather than a
 * hand-duplicated grammar, so the exemption can never drift from what the
 * resolver actually reads.
 */
function isUnkeyedRunBaseMarkerLine(line: string): boolean {
  return UNKEYED_RUN_BASE_LINE_START.test(line) && matchMarker(line, 'run-base', '\\S+') !== null;
}

// Fenced code block detector (round 2, D-027; round 3 tightened the matching
// rule; see the module docstring's QUOTATION EXEMPTION paragraph). A fence
// delimiter line is at most 3 leading spaces (CommonMark's indented-fence
// allowance) followed by a run of 3+ backticks or 3+ tildes; a `> ` (or any
// other) blockquote prefix is NOT a fence, deliberately fail-closed: a
// blockquoted fence is never recognised as one, so its own backtick/tilde run
// never opens or closes a fence. Heuristic, not a CommonMark parser: info
// strings are not validated.
const FENCE_MARKER = /^ {0,3}(`{3,}|~{3,})/;

/** The fence delimiter (character and run length) on `line`, or null. */
function matchFenceMarker(line: string): { char: string; length: number } | null {
  const m = FENCE_MARKER.exec(line);
  if (m === null) return null;
  return { char: m[1][0], length: m[1].length };
}

/**
 * A fence CLOSES only on a later line whose delimiter is the SAME character
 * and AT LEAST AS LONG as the opener's (CommonMark's own closing rule): a
 * `~~~` line inside a ``` fence does not close it, and vice versa. An opener
 * with no matching closer anywhere after it fences NOTHING: it fails closed
 * (the opener line itself is exempted from being "fenced" too), rather than
 * the earlier behaviour of an unclosed fence swallowing everything to EOF.
 * When an opener has no matching closer, the scan resumes at the very next
 * line, so a later, genuinely well-formed fence pair further down the file
 * is still recognised.
 */
function computeFencedLineFlags(lines: string[]): boolean[] {
  const flags: boolean[] = new Array(lines.length).fill(false);
  let i = 0;
  while (i < lines.length) {
    const open = matchFenceMarker(lines[i]);
    if (open === null) {
      i++;
      continue;
    }
    let closeIdx = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const candidate = matchFenceMarker(lines[j]);
      if (candidate !== null && candidate.char === open.char && candidate.length >= open.length) {
        closeIdx = j;
        break;
      }
    }
    if (closeIdx === -1) {
      // Unclosed: fences nothing, not even the opener line itself. Resume
      // scanning from the very next line for another, possibly well-formed,
      // fence pair.
      i++;
      continue;
    }
    for (let k = i; k <= closeIdx; k++) flags[k] = true;
    i = closeIdx + 1;
  }
  return flags;
}

/** Replace every non-newline character of `s` with a space (preserves length and line structure). */
function blank(s: string): string {
  return s.replace(/[^\n]/g, ' ');
}

// A single-backtick inline code span, bounded at a PARAGRAPH break: the span
// may cross one or more consecutive non-blank line breaks (a backtick pair
// opened on one line and closed on the next quotes cleanly, matching the one
// real corpus file that relies on this, see the module docstring), but
// never a BLANK line: a bare backtick followed, sometime later, by a blank
// line and then another stray backtick must not pair across that gap (round
// 3; the round-2 version paired across the WHOLE file, including across
// blank-line paragraph breaks). `(?!\s*\n)` after each `\n` refuses to
// continue the span onto a blank (or whitespace-only) line.
const INLINE_CODE_SPAN = /`[^`\n]*(?:\n(?!\s*\n)[^`\n]*)*?`/g;

/**
 * `content` with every QUOTED range blanked out (fenced code block lines,
 * then single-backtick inline code spans; see the module docstring's
 * QUOTATION EXEMPTION paragraph, `computeFencedLineFlags`, and
 * `INLINE_CODE_SPAN`). Fences are blanked FIRST so a backtick that is itself
 * fenced content can never pair with a backtick outside the fence. Line
 * count and line boundaries are preserved (only non-newline characters are
 * ever replaced), so the result can be re-split with the same `/\r?\n/`
 * regex used on `content` and indexed line-for-line against it. An unmatched
 * single backtick, or one whose only pairing partner sits across a blank
 * line, quotes nothing (fails closed).
 *
 * Generic over both consumers: the `run-base` grammar (`00-goal.md`) below,
 * and the review-method axis grammar (`05-review-findings.md`) further down.
 * The two consumers apply it asymmetrically on purpose; see each one's own
 * docstring for the difference.
 */
function stripQuotedMarkdownText(content: string): string {
  const lines = content.split(/\r?\n/);
  const fenced = computeFencedLineFlags(lines);
  const fenceStripped = lines.map((line, i) => (fenced[i] ? blank(line) : line)).join('\n');
  return fenceStripped.replace(INLINE_CODE_SPAN, blank);
}

// Fail-closed phrase check (the residual this widens, see the module
// docstring): ANY line, regardless of position (list bullet, prose, no
// comment wrapper, leading text before the comment), that mentions BOTH
// exact, case-sensitive tokens the template uses is an attempted `run-base`
// marker unless it is already accepted as well-formed (keyed or unkeyed,
// checked before this is reached) OR the occurrence is entirely inside a
// quoted range (round 2, D-027; see `stripQuotedMarkdownText`). Deliberately
// simple and total otherwise: no attempt to enumerate shapes, since
// enumerating shapes is exactly what left the residual open before.
function lineCarriesRunBasePhrase(line: string): boolean {
  return line.includes('solution-acceptance') && line.includes('run-base');
}

/**
 * Collect every well-formed keyed `run-base[<key>] = <value>` marker in
 * `goal` with a single line-by-line pass (whole-line HTML comments only —
 * see the module docstring for the grammar), plus every line that looked
 * like an attempted keyed marker but did not match the strict shape
 * (malformed). First well-formed occurrence per key wins (case-insensitive
 * dedup) — a later duplicate for the same key is ignored. A well-formed
 * match whose key is placeholder-shaped is skipped entirely (not counted as
 * present, not malformed). A well-formed LEGACY UNKEYED marker line is also
 * skipped entirely (it is handled by the separate unkeyed matcher, not
 * malformed; see `isUnkeyedRunBaseMarkerLine`). Every other line naming
 * both marker tokens (attempted keyed syntax the loose net already caught,
 * `kind: 'keyed-attempt'`, or a bullet/prose/wrapper-less/leading-text
 * mention the loose net's line-start anchor cannot see, `kind:
 * 'phrase-only'`, and only when it survives the quoting exemption, see
 * `stripQuotedMarkdownText`) is collected as malformed with its 1-based line
 * number and its category.
 */
function collectKeyedRunBaseMarkers(goal: string): KeyedMarkerScan {
  const seen = new Set<string>();
  const markers: KeyedRunBaseMarker[] = [];
  const malformedLines: MalformedRunBaseLine[] = [];
  const lines = goal.split(/\r?\n/);
  const unquotedLines = stripQuotedMarkdownText(goal).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const strict = line.match(KEYED_RUN_BASE_STRICT);
    if (strict !== null) {
      const key = strict[1].trim();
      if (PLACEHOLDER_KEY.test(key)) continue; // documentation example, not a marker
      const lowerKey = key.toLowerCase();
      if (seen.has(lowerKey)) continue; // first occurrence per key wins
      seen.add(lowerKey);
      markers.push({ key, value: strict[2] });
      continue;
    }
    if (isUnkeyedRunBaseMarkerLine(line)) continue; // legitimate legacy marker line, not an attempt
    if (KEYED_RUN_BASE_LOOSE_START.test(line)) {
      malformedLines.push({ line: i + 1, excerpt: line.trim(), kind: 'keyed-attempt' });
      continue;
    }
    if (lineCarriesRunBasePhrase(unquotedLines[i])) {
      malformedLines.push({ line: i + 1, excerpt: line.trim(), kind: 'phrase-only' });
    }
  }
  return { markers, malformedLines };
}

/**
 * Truncate `s` to `n` characters. Applied to an EXCERPT before it is
 * prefixed with `line N: ` (round 2, review finding 6): truncating the
 * already-prefixed string, as the previous version did, let the prefix eat
 * into the excerpt's own character budget instead of the excerpt getting
 * the full `n` characters it was promised.
 */
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

/**
 * Join `items` into a single bounded string: at most `maxItems` shown, with
 * `(+N more)` appended when more were dropped. Per-item character bounding
 * (when wanted) is the caller's job, via `truncate`, applied BEFORE any
 * `line N: ` style prefix is added; see `truncate`'s own note. Keeps
 * blocker messages from growing unbounded when a goal file carries many/long
 * keys or malformed lines.
 */
function joinBounded(items: string[], maxItems: number, sep: string): string {
  const shown = items.slice(0, maxItems);
  const dropped = items.length - shown.length;
  const joined = shown.join(sep);
  return dropped > 0 ? `${joined} (+${dropped} more)` : joined;
}

/**
 * Reason string(s) for the malformed run-base lines `collectKeyedRunBaseMarkers`
 * found, ONE entry per category present (round 2, review finding 5): a
 * `keyed-attempt` line gets the original keyed-shape hint (it named
 * `run-base[`, so the keyed grammar is the actionable fix); a `phrase-only`
 * line gets a DIFFERENT message that does not point at the keyed shape;
 * that hint misleads an operator whose line never attempted bracket syntax
 * at all (prose, a quoted marker, a quoted regex). Returns 0-2 strings, in
 * this fixed order when both are present.
 */
function malformedRunBaseReasons(malformedLines: MalformedRunBaseLine[]): string[] {
  const keyedAttempts = malformedLines.filter((l) => l.kind === 'keyed-attempt');
  const phraseOnly = malformedLines.filter((l) => l.kind === 'phrase-only');
  const reasons: string[] = [];
  if (keyedAttempts.length > 0) {
    const items = keyedAttempts.map((l) => `line ${l.line}: ${truncate(l.excerpt, 80)}`);
    reasons.push(
      `malformed keyed run-base marker(s) in 00-goal.md: ${joinBounded(items, 5, ' | ')} ` +
        "(expected '<!-- solution-acceptance: run-base[<key>] = <sha> -->' on its own line)",
    );
  }
  if (phraseOnly.length > 0) {
    const items = phraseOnly.map(
      (l) =>
        `line ${l.line} names the run-base marker tokens but is not a well-formed marker: ${truncate(l.excerpt, 80)}`,
    );
    reasons.push(`run-base marker mention(s) in 00-goal.md are not well-formed: ${joinBounded(items, 5, ' | ')}`);
  }
  return reasons;
}

/**
 * The `run-base` binding marker value from a run's `00-goal.md` content. No
 * validation happens here — the raw value is handed to the verdict layer,
 * which validates it (strict hex) BEFORE any git invocation.
 *
 * Keyed selection: all well-formed keyed markers (`run-base[<key>] =
 * <value>`, whole-line HTML comments — see the module docstring's grammar)
 * are collected in one line-by-line scan (`collectKeyedRunBaseMarkers`),
 * along with any MALFORMED near-miss lines. `keys` (see `repoKeys`) is then
 * tried in order, matching each candidate key against the collected
 * well-formed keys CASE-INSENSITIVELY. The FIRST candidate key with a
 * matching keyed marker decides — its value, or null for `TODO` — without
 * falling through to a later key or to the unkeyed marker, even when the
 * value is `TODO`. When well-formed keyed markers exist but none matches any
 * candidate key, the legacy unkeyed `run-base` marker is still used if
 * present. Whenever malformed lines were found, their blocker reason is
 * ALWAYS reported (`reasons`) regardless of which of the above resolved a
 * value — a malformed line is evidence the binding is incomplete even when
 * another marker also happens to resolve. When nothing resolved a value (no
 * well-formed match, no unkeyed marker) AND malformed lines were found, that
 * is reported as `runBaseKind: 'malformed'` (takes priority over
 * `'unmatched-keyed'`). When nothing resolved a value, no malformed lines
 * were found, but well-formed keyed markers exist for OTHER keys, that is the
 * `'unmatched-keyed'` blocker, unchanged from before this task. When NO
 * keyed marker (well-formed or malformed) is present at all, the unkeyed
 * marker applies directly, exactly as before this feature existed (silent
 * null when absent/`TODO`, no reason).
 */
function selectRunBase(goal: string | null, keys: string[]): RunBaseSelection {
  if (goal === null) return { runBase: null, runBaseKind: 'absent', reasons: [] };

  // Raw \S+ capture on purpose: sha values may start with a digit (the enum
  // charset would reject them), and a malformed value must reach the verdict
  // layer's hex guard so it blocks explicitly instead of downgrading silently
  // to the date heuristic.
  const unkeyed = matchMarker(goal, 'run-base', '\\S+');
  const { markers: keyedMarkers, malformedLines } = collectKeyedRunBaseMarkers(goal);
  const malformedReasons = malformedRunBaseReasons(malformedLines);

  for (const key of keys) {
    const lowerKey = key.toLowerCase();
    const found = keyedMarkers.find((km) => km.key.toLowerCase() === lowerKey);
    if (found !== undefined) {
      const resolved = resolvedMarker(found.value);
      return { ...resolved, reasons: malformedReasons };
    }
  }

  if (unkeyed !== null) {
    const resolved = resolvedMarker(unkeyed);
    return { ...resolved, reasons: malformedReasons };
  }

  if (malformedReasons.length > 0) {
    return { runBase: null, runBaseKind: 'malformed', reasons: malformedReasons };
  }

  if (keyedMarkers.length === 0) {
    return { runBase: null, runBaseKind: 'absent', reasons: [] };
  }

  return {
    runBase: null,
    runBaseKind: 'unmatched-keyed',
    reasons: [
      `run-base markers in 00-goal.md are keyed (keys: ${joinBounded(keyedMarkers.map((km) => truncate(km.key, 64)), 10, ', ')}) ` +
        `but none matches this worktree (tried: ${keys.join(', ')}) and no unkeyed run-base marker ` +
        'exists; add a run-base[<key>] marker for this repo or an unkeyed run-base marker',
    ],
  };
}

/** A marker value (possibly `TODO`) that was found, resolved to a selection (empty `reasons`). */
function resolvedMarker(value: string | null): RunBaseSelection {
  if (value === null) return { runBase: null, runBaseKind: 'absent', reasons: [] };
  if (value === 'TODO') return { runBase: null, runBaseKind: 'todo', reasons: [] };
  return { runBase: value, runBaseKind: 'sha', reasons: [] };
}

/**
 * Walk up from `path.resolve(start)` (inclusive) to the filesystem root; the
 * first directory containing a `.git` entry (directory, file — a linked git
 * worktree's root has a `.git` FILE — or even a DANGLING symlink) is the
 * worktree root. Presence is checked with `fs.lstatSync` (not
 * `fs.existsSync`, which follows symlinks and would miss a broken one) inside
 * a try/catch, so a `.git` entry of any kind, including a symlink whose
 * target no longer exists, still marks the root. Null when no such directory
 * exists anywhere up the chain (never throws).
 */
function findWorktreeRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    try {
      fs.lstatSync(path.join(dir, '.git'));
      return dir;
    } catch {
      // no `.git` entry at this level → keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

type RunPointer =
  | { kind: 'none' }
  | { kind: 'invalid'; reason: string; pointerPath: string }
  | { kind: 'run'; dir: string };

/**
 * Resolve the worktree-local `.ai/run` pointer file. Only the first
 * non-empty line matters (later lines, e.g. a `base=<sha>` line, are
 * ignored). No `~` or environment expansion. See the module docstring for
 * why an invalid pointer is a distinct fail-closed blocker rather than a
 * silent fallback to the newest-run scan.
 *
 * Symlink resolution: once the target is confirmed absolute, it is resolved
 * with `fs.realpathSync` (in the same try/catch as the existence check — a
 * failure there reads the same as "target does not exist") BEFORE the
 * directory and dated-prefix checks, and the RESOLVED (real) path is what is
 * checked and returned as `dir`. Symlinks are therefore transparent: the
 * run's identity is its real directory, not whatever path happened to be
 * named in the pointer file.
 */
function resolveRunPointer(worktreeRoot: string): RunPointer {
  const pointerPath = path.join(worktreeRoot, '.ai', 'run');
  let raw: string;
  try {
    raw = fs.readFileSync(pointerPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'none' };
    return { kind: 'invalid', reason: 'could not be read as a file', pointerPath };
  }

  const firstLine = raw.split(/\r?\n/).find((l) => l.trim() !== '');
  if (firstLine === undefined) return { kind: 'invalid', reason: 'is empty', pointerPath };
  const target = firstLine.trim();

  if (!path.isAbsolute(target)) {
    return { kind: 'invalid', reason: `names a relative path '${target}'`, pointerPath };
  }

  let realTarget: string;
  let stat: fs.Stats;
  try {
    realTarget = fs.realpathSync(target);
    stat = fs.statSync(realTarget);
  } catch {
    return { kind: 'invalid', reason: `target '${target}' does not exist`, pointerPath };
  }
  if (!stat.isDirectory()) {
    return { kind: 'invalid', reason: `target '${target}' is not a directory`, pointerPath };
  }
  const base = path.basename(realTarget);
  if (!DATED_RUN_PREFIX.test(base)) {
    return {
      kind: 'invalid',
      reason: `target basename '${base}' is not a dated run directory (YYYY-MM-DD-<slug>)`,
      pointerPath,
    };
  }
  return { kind: 'run', dir: realTarget };
}

/**
 * The keys under which `worktreeRoot`'s `run-base` marker may be recorded:
 * the worktree's own basename, plus — for a LINKED git worktree — the main
 * repository's basename (appended only when it differs from the first key).
 * Any read error along the way (missing/unreadable `.git` file, malformed
 * `gitdir:` line) yields no second key; this function never throws.
 */
function repoKeys(worktreeRoot: string): string[] {
  const keys = [path.basename(worktreeRoot)];
  const mainRoot = resolveMainWorktreeRoot(worktreeRoot);
  if (mainRoot !== null) {
    const mainKey = path.basename(mainRoot);
    if (mainKey !== keys[0]) keys.push(mainKey);
  }
  return keys;
}

/**
 * For a LINKED git worktree (`<worktreeRoot>/.git` is a FILE containing
 * `gitdir: <path>`), resolve the main repository's root directory. Returns
 * null for a normal (non-linked) worktree, or when anything along the way is
 * missing/malformed (never throws).
 *
 * Primary path: read `<gitdir>/commondir` (relative paths resolve against
 * `gitdir`); when its resolved basename is `.git`, the main root is its
 * dirname. Fallback, used both when `commondir` is absent/unreadable AND when
 * it is present but its resolved basename is NOT `.git` (an odd or
 * unexpected value should not give up outright): match `gitdir` against
 * `/[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/` and strip the
 * `/.git/worktrees/<name>` suffix to get the main root directly.
 */
function resolveMainWorktreeRoot(worktreeRoot: string): string | null {
  const dotGitPath = path.join(worktreeRoot, '.git');
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(dotGitPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  let content: string;
  try {
    content = fs.readFileSync(dotGitPath, 'utf8');
  } catch {
    return null;
  }
  const m = content.match(/^gitdir:\s*(.+)$/m);
  if (!m) return null;
  const gitdirRaw = m[1].trim();
  const gitdir = path.isAbsolute(gitdirRaw) ? gitdirRaw : path.resolve(worktreeRoot, gitdirRaw);

  const commondirPath = path.join(gitdir, 'commondir');
  try {
    const commondirRaw = fs.readFileSync(commondirPath, 'utf8').trim();
    if (commondirRaw !== '') {
      const commondir = path.isAbsolute(commondirRaw)
        ? commondirRaw
        : path.resolve(gitdir, commondirRaw);
      if (path.basename(commondir) === '.git') return path.dirname(commondir);
      // commondir present but its resolved basename isn't `.git` → fall
      // through to the gitdir-path fallback below instead of giving up.
    }
  } catch {
    // commondir absent/unreadable → fall through to the gitdir-path fallback.
  }

  const worktreesMatch = gitdir.match(/^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/);
  if (worktreesMatch) return worktreesMatch[1];
  return null;
}

/**
 * The active run dir under `<repoPath>/.ai/runs/`, or null when none exists.
 * Selection: newest by directory name, sorted descending — the `YYYY-MM-DD`
 * prefix makes lexicographic order chronological. mtime is a defensive
 * tiebreak (distinct run dir names never collide in practice).
 *
 * Only date-prefixed dirs (`/^\d{4}-\d{2}-\d{2}-/`) are eligible, so a
 * non-dated sibling like `archive` or `draft` can never sort ahead and become
 * the active run. When no dated dir exists, OW does not apply (returns null).
 */
function findActiveRun(repoPath: string): string | null {
  const runsDir = path.join(repoPath, '.ai', 'runs');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => DATED_RUN_PREFIX.test(name));
  if (dirs.length === 0) return null;
  dirs.sort((a, b) => {
    if (a !== b) return a < b ? 1 : -1; // name, descending
    return safeMtimeMs(path.join(runsDir, b)) - safeMtimeMs(path.join(runsDir, a));
  });
  return path.join(runsDir, dirs[0]);
}

/**
 * Discriminated marker/prose resolution so the caller can name the actual
 * failure: `todo` (a marker exists but still carries the template's TODO
 * placeholder; prose is deliberately NOT consulted, marker-first fail-closed)
 * vs `missing` (no marker and no filled prose value).
 */
type AcceptanceValue =
  | { kind: 'value'; value: string }
  | { kind: 'todo' }
  | { kind: 'malformed'; raw: string }
  | { kind: 'missing' };

/**
 * Resolve an acceptance value marker-first, then fail-closed prose fallback.
 * A `TODO` marker never falls back to prose: the marker is the machine
 * channel, and an unfilled machine channel must surface as exactly that. The
 * same holds for a `malformed` marker (field present, value not word-shaped,
 * e.g. `= 1accepted`): a present-but-broken machine channel must block, never
 * be silently overridden by a filled prose line.
 */
function resolveAcceptanceValue(
  content: string | null,
  markerField: string,
  proseHeading: string,
): AcceptanceValue {
  if (content === null) return { kind: 'missing' };

  const marker = matchMarker(content, markerField);
  if (marker !== null) {
    return marker === 'TODO' ? { kind: 'todo' } : { kind: 'value', value: marker };
  }

  // The enum-shaped match failed. Distinguish "field absent" (prose fallback
  // is legitimate) from "field present with a non-enum-shaped value" (block).
  const raw = matchMarker(content, markerField, '\\S+');
  if (raw !== null) return { kind: 'malformed', raw };

  const prose = resolveProseValue(content, proseHeading);
  return prose === null ? { kind: 'missing' } : { kind: 'value', value: prose };
}

// Acceptance enum values are word-shaped (`accepted_with_notes`). Capturing
// exactly that charset keeps sloppy spacing (`= accepted-->`) from swallowing
// the comment terminator into the value. A value that does not even start
// word-shaped fails the match entirely and resolves like a missing marker
// (prose fallback, fail-closed).
const ENUM_VALUE_PATTERN = '[A-Za-z][A-Za-z0-9_]*';

/**
 * Match `<!-- solution-acceptance: <field> = <value> -->`, returning the value.
 * `valuePattern` bounds the capture; callers with non-enum values (the
 * `run-base` sha binding, validated downstream by a strict hex guard) pass a
 * raw `\S+` so malformed values still surface as explicit blockers instead of
 * silently degrading. First match wins; a quoted mention of marker syntax
 * earlier in the file can shadow the real marker (known non-goal: run files
 * are agent-authored, see the honor-system residual).
 */
function matchMarker(
  content: string,
  field: string,
  valuePattern: string = ENUM_VALUE_PATTERN,
): string | null {
  const re = new RegExp(`solution-acceptance:\\s*${escapeRegExp(field)}\\s*=\\s*(${valuePattern})`);
  const m = content.match(re);
  return m ? m[1].trim() : null;
}

/**
 * First filled value line under a `## <heading>` prose section. An unfilled
 * enum legend (contains a `|`), a `TODO` sentinel, an HTML comment line, or the
 * absence of any value before the next section all resolve to null (fail-closed).
 */
function resolveProseValue(content: string, heading: string): string | null {
  const lines = content.split(/\r?\n/);
  const target = `## ${heading}`.toLowerCase();
  const start = lines.findIndex((l) => l.trim().toLowerCase() === target);
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '') continue;
    if (line.startsWith('##')) return null; // reached next section, no value
    if (line.startsWith('<!--')) continue; // skip comment lines (incl. markers)
    if (line.includes('|')) return null; // unfilled enum legend
    if (line === 'TODO') return null;
    return line;
  }
  return null;
}

interface FindingsScan {
  /** Unresolved arming findings (unchanged semantics, see below). */
  unresolved: UnresolvedFinding[];
  /** The shipped placeholder/legend row was seen anywhere (byte-exact match). */
  placeholderRowSeen: boolean;
  /** At least one row anywhere carries a real concrete severity value. */
  concreteRowSeen: boolean;
}

/**
 * Scan every findings table for unresolved arming findings AND for the two
 * presence flags the mixed-state bypass guard needs (see the module
 * docstring): whether the shipped placeholder row survives untouched, and
 * whether any row anywhere carries a real concrete severity (i.e. findings
 * were actually transferred).
 *
 * Location (Fix 1): the table is found by anchoring on its HEADER ROW — the
 * first markdown table row whose cells include both `Severity` and `Decision`
 * (case-insensitive) — not by the `## Findings` heading text. A drifted heading
 * (`## Findings (summary)`) therefore cannot hide a real finding. The column
 * positions of Severity and Decision are taken from that header. Data rows are
 * read after the `|---|` separator until the table ends (blank or non-table
 * line).
 *
 * Placeholder detection (mixed-state bypass guard): a row is the shipped
 * placeholder only when ALL of its cells byte-exactly match
 * `PLACEHOLDER_ROW_CELLS` — not merely "Severity is a slash-list" — so a
 * differently worded legend row falls through to the arming check below
 * (where its non-concrete Severity cell causes it to be skipped, unchanged
 * from before this guard existed).
 *
 * Arming (Fix 2): whether a row is a real finding is decided by the SEVERITY
 * cell carrying a single concrete value — the slash-list legend row
 * (`low/medium/high/critical`), the separator, and the header are all skipped
 * this way. A concrete high/critical row then ARMS the gate UNLESS its Decision
 * is explicitly resolved ({accepted, defer}); fix, reject, blank, `open`,
 * `TODO`, and any unrecognized decision all block (fail-closed).
 */
function scanFindings(content: string | null): FindingsScan {
  const scan: FindingsScan = { unresolved: [], placeholderRowSeen: false, concreteRowSeen: false };
  if (content === null) return scan;
  const lines = content.split(/\r?\n/);

  let i = 0;
  while (i < lines.length) {
    const header = parseFindingsHeaderRow(lines[i]);
    if (header === null) {
      i++;
      continue;
    }

    // Data rows of THIS table, until a blank or non-table line ends it. The
    // outer loop then keeps scanning: a later table (e.g. a second review
    // round appended below the first) is parsed too — before this, only the
    // FIRST table was read and later high/critical findings were invisible
    // (fail-open on append).
    let j = i + 1;
    for (; j < lines.length; j++) {
      const t = lines[j].trim();
      if (t === '' || !t.startsWith('|')) break;
      const cells = splitTableRow(t);
      if (isSeparatorRow(cells)) continue; // the |---| separator row

      if (isPlaceholderRow(cells)) {
        scan.placeholderRowSeen = true;
        continue; // the shipped legend row is never itself a finding
      }

      if (header.severityIdx >= cells.length) continue; // no severity cell to classify

      const severity = (cells[header.severityIdx] ?? '').toLowerCase();
      // Real-finding test: SEVERITY must be a single concrete value. A legend
      // row's slash-list severity fails this and is skipped.
      if (!CONCRETE_SEVERITIES.has(severity)) continue;
      scan.concreteRowSeen = true;
      if (!ARMING_SEVERITIES.has(severity)) continue; // low/medium never arm

      // A missing decision cell reads as blank → unset → arms (fail-closed).
      const decision = (cells[header.decisionIdx] ?? '').toLowerCase();
      if (RESOLVED_DECISIONS.has(decision)) continue; // accepted/defer → resolved

      const description =
        header.descriptionIdx !== -1 && header.descriptionIdx < cells.length
          ? cells[header.descriptionIdx]
          : cells
              .filter((_, idx) => idx !== header.severityIdx && idx !== header.decisionIdx)
              .join(' | ');
      scan.unresolved.push({
        severity,
        description,
        decision: decision === '' ? 'unset' : decision,
      });
    }
    i = j;
  }
  return scan;
}

/**
 * True when `cells` (already normalized the way splitTableRow() normalizes
 * any table row) are byte-identical, cell by cell, to the shipped
 * placeholder row's cells — the FULL row, not just the Severity slash-list.
 */
function isPlaceholderRow(cells: string[]): boolean {
  return (
    cells.length === PLACEHOLDER_ROW_CELLS.length &&
    cells.every((c, idx) => c === PLACEHOLDER_ROW_CELLS[idx])
  );
}

interface FindingsHeader {
  severityIdx: number;
  decisionIdx: number;
  descriptionIdx: number;
}

/** Parse a line as a findings-table HEADER ROW (cells include Severity and Decision). */
function parseFindingsHeaderRow(line: string): FindingsHeader | null {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  const cells = splitTableRow(t);
  const severityIdx = cells.findIndex((c) => c.toLowerCase() === 'severity');
  const decisionIdx = cells.findIndex((c) => c.toLowerCase() === 'decision');
  if (severityIdx === -1 || decisionIdx === -1) return null;
  return {
    severityIdx,
    decisionIdx,
    descriptionIdx: cells.findIndex((c) => c.toLowerCase() === 'description'),
  };
}

/**
 * Fail-closed on findings-format drift: a `## Findings`-style section that
 * carries content but NO findings-table header row anywhere in the file means
 * findings were recorded in a shape the reader cannot verify (e.g. a bullet
 * list). Silently reporting zero findings there would fail open, so this
 * yields an explicit blocker instead. Residual: once ANY table header exists,
 * extra non-table findings elsewhere stay invisible (tables are the machine
 * channel; drift beyond that is out of reach for a line parser).
 */
function findingsFormatBlocker(content: string | null): string | null {
  if (content === null) return null;
  if (content.split(/\r?\n/).some((l) => parseFindingsHeaderRow(l) !== null)) return null;

  // Strip HTML comments BEFORE the content scan so a template placeholder
  // spanning multiple lines is not mistaken for findings content. An
  // unterminated comment is left in place (counts as content, fail-closed).
  const lines = content.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);

  // Scan EVERY findings-style heading, mirroring the all-tables scan: list
  // content under a second findings heading must not hide behind an empty
  // first one.
  for (let h = 0; h < lines.length; h++) {
    if (!/^#{1,6}\s*findings\b/i.test(lines[h].trim())) continue;
    for (let i = h + 1; i < lines.length; i++) {
      const t = lines[i].trim();
      if (/^#{1,6}\s/.test(t)) break; // next section ends this findings section
      if (t === '') continue;
      return (
        'review findings are present but not in the expected table format ' +
        '(header row with Severity and Decision columns); rewrite them as the ' +
        'findings table so they can be verified'
      );
    }
  }
  return null;
}

// Review-method axis (orchestrator-workflow kit 0.32.0, assets/templates/05-review-findings.md):
// each review round may declare `<!-- review-method[<round>] = normal|rigorous|adversarial -->`
// above the Findings table. Round 1 defined the machine-readable counterpart
// grammar the kit template does not ship yet, `<!-- method-applied[<round>] =
// normal|rigorous|adversarial -->`. Round 2 (review finding F1, orchestrator
// decision) found that mandating ONLY that marker fails a run authored
// exactly from the shipped template (and all real runs then on kit 0.32.0):
// the template's own immediately-following `Method: <value> (...)` prose line
// is what a template-conformant run actually carries, not a marker. The
// reader therefore ALSO accepts that prose line as a fallback record (see
// `resolveProseMethodLine`), while still keeping `method-applied[<round>]` as
// the explicit, preferred record; when both exist for a round and disagree,
// that is its own named blocker rather than either one silently winning.
// CROSS-REPO OBLIGATION (unchanged from round 1, still open): the shipped
// packages/orchestrator-workflow/assets/templates/05-review-findings.md
// should add `<!-- method-applied[<round>] = normal|rigorous|adversarial -->`
// next to its existing `review-method[<round>]` marker and `Method:` line.
// Until it does: a run authored under kit 0.32.0 with a FILLED `Method:
// <value> (...)` line (not the pipe-joined legend) passes via the prose
// fallback; a run recording NEITHER channel for a round needs one line added
// (`<!-- method-applied[<round>] = <value> -->`, or filling in `Method:`) to
// migrate. Strength order used for the weaker/absent comparison below.
const REVIEW_METHOD_STRENGTH: Record<string, number> = { normal: 0, rigorous: 1, adversarial: 2 };
const REVIEW_METHOD_VALUES = new Set(Object.keys(REVIEW_METHOD_STRENGTH));

/** One well-formed `<field>[<round>] = <value>` marker occurrence. */
interface RoundMarker {
  /** The round key exactly as authored (trimmed, original case). */
  round: string;
  /** One of `normal`/`rigorous`/`adversarial` (enum-validated). */
  value: string;
  /** Index into the scan content right after this occurrence's `-->`, for locating a trailing `Method:` prose line. */
  endIndex: number;
}

/** Rounds with 2+ well-formed occurrences of one field whose values disagree. */
interface RoundConflict {
  /** The round key as authored on its first occurrence. */
  round: string;
  /** Distinct values seen, in first-seen order (always 2+). */
  values: string[];
}

/** Result of scanning `content` for one marker field (`review-method` or `method-applied`). */
interface RoundMarkerScan {
  /** Well-formed, non-conflicting markers keyed by lowercased round. First occurrence per round wins. */
  markers: Map<string, RoundMarker>;
  /** Short, line-numbered excerpts of occurrences that attempted the marker but did not resolve to a well-formed one. */
  malformedExcerpts: string[];
  /** Rounds (keyed by lowercased round) whose well-formed occurrences disagree on value. */
  conflicts: Map<string, RoundConflict>;
  /**
   * EVERY well-formed occurrence, in file order, one entry per occurrence
   * (not deduped by round): a round packed twice on one line, or two
   * different rounds packed on one line, each contribute their own entry.
   * Used (review finding F2, round 3) to count how many well-formed
   * `review-method[...]` occurrences share one physical line, since the
   * `Method:` prose fallback below is only safe to associate with a line
   * that declares exactly one round.
   */
  occurrences: RoundMarker[];
}

/**
 * Collect every well-formed `<!-- <field>[<round>] = <value> -->` occurrence
 * in `content`, plus every occurrence that attempted the marker but did not
 * resolve to one. Deliberately occurrence-scoped rather than whole-line-scoped
 * (unlike the `run-base` keyed grammar above): the review-method note is
 * authored with several rounds packed onto one line
 * (`<!-- review-method[T-001-R1] = rigorous --> <!-- review-method[T-001-R2]
 * = rigorous -->`), so a whole-line requirement would misclassify that
 * legitimate shape as malformed. Anchored by a corpus measurement of real
 * `05-review-findings.md` files authored under kit 0.32.0, the largest of
 * which packs 27 occurrences onto 11 lines; see CHANGELOG 0.12.0 for the
 * corpus, the totals and the per-file figures. The totals are recorded
 * only there: one of the measured runs was still open when they were
 * taken, so they are a measurement at the time of writing, not a fixed
 * corpus fact, and a second copy in this comment would drift against
 * the recorded one.
 *
 * Quoting (review finding F2): unlike the `run-base` grammar above, where
 * only the position-independent phrase net is quoting-aware, EVERY net here
 * (strict, loose, and the wrapper-less net below) runs against
 * `stripQuotedMarkdownText(content)`: a marker sitting inside a fenced code
 * block or an inline code span (e.g. quoted in prose, or inside a findings
 * table cell) is never live, full stop. This is a deliberate asymmetry from
 * `run-base`'s: the review-method grammar has no equivalent to `run-base`'s
 * accepted "a fenced well-formed marker still resolves" residual.
 *
 * A match whose round key is placeholder-shaped (`<round>`, the template's own
 * documentation example) is skipped entirely (not counted as present, not
 * malformed), the same treatment `PLACEHOLDER_KEY`/`PLACEHOLDER_ROW_CELLS`
 * give the run-base and findings-table template examples above. A match whose
 * value is not exactly one of `normal`/`rigorous`/`adversarial` (including the
 * template's own pipe-joined legend value used with a REAL, non-placeholder
 * key) is malformed. A case-insensitive loose net catches wrapper near-misses
 * that never reach the strict shape (wrong case, extra dashes, stray
 * whitespace before the bracket); a further wrapper-LESS net (review finding
 * F4) catches a bare `review-method[R1] = adversarial` line with no HTML
 * comment at all, mirroring the run-base phrase net's own fail-closed
 * discipline for an unwrapped attempt. Both near-miss nets are checked
 * against the ranges the strict/loose nets already claimed, so a genuine
 * well-formed (or already-loose-malformed) occurrence is never double
 * reported by the wrapper-less net.
 *
 * Duplicates (review finding F3): two or more well-formed occurrences for the
 * SAME round are tolerated when their values agree (first occurrence wins,
 * as before); when they disagree, the round is reported via `conflicts`
 * instead of `markers`: a named blocker, not a silent first-wins pick.
 */
function collectRoundMarkers(content: string, field: 'review-method' | 'method-applied'): RoundMarkerScan {
  const scanContent = stripQuotedMarkdownText(content);
  const strictRe = new RegExp(`<!--\\s*${field}\\[([^\\]\\n]+)\\]\\s*=\\s*(\\S+)\\s*-->`, 'g');
  const looseRe = new RegExp(`<!--+\\s*${field}\\s*\\[`, 'gi');
  const bareRe = new RegExp(`${field}\\s*\\[`, 'gi');

  const markers = new Map<string, RoundMarker>();
  const seenValues = new Map<string, { round: string; values: string[] }>();
  const malformedExcerpts: string[] = [];
  const claimedRanges: Array<[number, number]> = [];
  const occurrences: RoundMarker[] = [];

  let m: RegExpExecArray | null;
  while ((m = strictRe.exec(scanContent)) !== null) {
    claimedRanges.push([m.index, m.index + m[0].length]);
    const round = m[1].trim();
    const value = m[2];
    if (PLACEHOLDER_KEY.test(round)) continue; // documentation example, not a marker
    if (!REVIEW_METHOD_VALUES.has(value)) {
      malformedExcerpts.push(`line ${lineAt(scanContent, m.index)}: ${truncate(m[0].trim(), 80)}`);
      continue;
    }
    const endIndex = m.index + m[0].length;
    occurrences.push({ round, value, endIndex });
    const lowerRound = round.toLowerCase();
    const seen = seenValues.get(lowerRound) ?? { round, values: [] };
    if (!seen.values.includes(value)) seen.values.push(value);
    seenValues.set(lowerRound, seen);
    if (!markers.has(lowerRound)) {
      markers.set(lowerRound, { round, value, endIndex });
    }
  }

  let lm: RegExpExecArray | null;
  while ((lm = looseRe.exec(scanContent)) !== null) {
    if (claimedRanges.some(([start, end]) => lm!.index >= start && lm!.index < end)) continue;
    claimedRanges.push([lm.index, lm.index + lm[0].length]);
    malformedExcerpts.push(
      `line ${lineAt(scanContent, lm.index)}: ${truncate(excerptFromIndex(scanContent, lm.index), 80)}`,
    );
  }

  let bm: RegExpExecArray | null;
  while ((bm = bareRe.exec(scanContent)) !== null) {
    if (claimedRanges.some(([start, end]) => bm!.index >= start && bm!.index < end)) continue;
    malformedExcerpts.push(
      `line ${lineAt(scanContent, bm.index)}: ${truncate(excerptFromIndex(scanContent, bm.index), 80)}`,
    );
  }

  const conflicts = new Map<string, RoundConflict>();
  for (const [lowerRound, seen] of seenValues) {
    if (seen.values.length > 1) conflicts.set(lowerRound, seen);
  }
  for (const lowerRound of conflicts.keys()) markers.delete(lowerRound);

  return { markers, malformedExcerpts, conflicts, occurrences };
}

/** The rest of `content`'s line starting at `index`, trimmed (for a malformed-marker excerpt). */
function excerptFromIndex(content: string, index: number): string {
  const rest = content.slice(index);
  const newlineIdx = rest.indexOf('\n');
  return (newlineIdx === -1 ? rest : rest.slice(0, newlineIdx)).trim();
}

/** 1-based line number of `index` within `content` (review finding F6). */
function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

/** One resolved value from a `Method:` prose line, or why it did not resolve to one. */
type ProseMethodLine = { kind: 'value'; value: string } | { kind: 'placeholder' } | { kind: 'malformed' };

// The template's own unfilled legend value, exactly as shipped
// (packages/orchestrator-workflow/assets/templates/05-review-findings.md):
// `Method: normal | rigorous | adversarial (...)`. A `Method:` line whose
// value starts with this pipe-joined legend is the placeholder, not a
// filled-in record (review finding F1), skipped the same way a placeholder
// marker key is, never reported as malformed.
const PROSE_METHOD_PLACEHOLDER = /^normal\s*\|\s*rigorous\s*\|\s*adversarial\b/;

/**
 * The exact literal text of the shipped review template's own unfilled
 * `review-method[<round>]` marker (agent-dx repo,
 * packages/orchestrator-workflow/assets/templates/05-review-findings.md).
 * Exported ONLY so tests can pin it directly against the known template
 * string (see this package's ow-run-completeness.test.ts reciprocal pinning
 * test) and, by hand, against agent-dx's own
 * packages/orchestrator-workflow/test/template-markers.test.ts pin -- the two
 * repos are lockstep-coupled on this marker (round key `<round>`, legend
 * value `normal|rigorous|adversarial`) and must be kept in sync manually,
 * mirroring `OW_FINDINGS_PLACEHOLDER_ROW` above.
 */
export const OW_REVIEW_METHOD_PLACEHOLDER_MARKER =
  '<!-- review-method[<round>] = normal|rigorous|adversarial -->';

/**
 * The trailing text allowed to follow the value token on a `Method:` line for
 * it to still count as a record (review finding F1, round 3, tightened round
 * 4): empty, plain end-of-sentence punctuation only (`.`, `!`, `?`, in any
 * combination, e.g. `?!`), or a BALANCED parenthetical aside starting the
 * template's own explanatory shape (`Method: adversarial (briefing and return
 * match).`), followed only by end-of-sentence punctuation. Anything else --
 * a qualifying clause, a second value, an unrelated sentence, text trailing
 * an aside's closing paren other than punctuation, or an aside that never
 * closes -- means the token was not actually naming the round's method, it
 * was just the first word of unrelated prose (the real batch48 line this
 * guards against: `Method: rigorous for every round except T-007 R1 and
 * T-010 R1 (adversarial); ...`, where a bare first-token read would wrongly
 * record `rigorous`). Round 3's original `\(.*` half accepted anything after
 * an opening paren verbatim, including text appended after the aside closes
 * (`Method: adversarial (x) but actually normal`) and an aside that never
 * closes at all (`Method: adversarial (`); round 4 (review finding, round 4)
 * closes both by requiring the parenthetical to actually balance before the
 * line ends.
 */
const PROSE_METHOD_TRAILING = /^(?:[.!?]*|\([^)]*\)[.!?]*)$/;

/**
 * Resolve a trimmed line already known to start with `Method:` (case as in
 * the template) to its record. The value token is the text after `Method:`
 * up to the first whitespace, `(`, or end-of-sentence punctuation (`.`, `!`,
 * `?`), matching how the template's own filled example reads (`Method:
 * adversarial (briefing and return match).`) while still letting a bare
 * `Method: adversarial.` (value immediately followed by a full stop, no
 * space) resolve rather than swallowing the period into the token (review
 * finding F1, round 3). The template's own unfilled pipe-joined legend is
 * recognized as a WHOLE phrase first (its first token, `normal`, would
 * otherwise misread as a valid, wrong value) and treated as a placeholder,
 * not a record. A token that names one of the three words only counts as a
 * record when the text AFTER it is empty, end-of-sentence punctuation only,
 * or a balanced parenthetical aside followed only by end-of-sentence
 * punctuation (see `PROSE_METHOD_TRAILING`, review finding F1, round 3,
 * tightened round 4): a qualified or multi-clause sentence whose first word
 * merely happens to be a valid value is a malformed record, not a
 * silently-accepted one.
 * Anything else -- no recognized token, or a recognized token followed by
 * disqualifying trailing text -- is a malformed record (review finding F1:
 * "a `Method:` line that names none of the three is a malformed record").
 */
function resolveProseMethodLine(trimmedLine: string): ProseMethodLine {
  const rest = trimmedLine.slice('Method:'.length).trim();
  if (PROSE_METHOD_PLACEHOLDER.test(rest)) return { kind: 'placeholder' };
  const token = /^[^\s(.!?]+/.exec(rest)?.[0] ?? '';
  if (!REVIEW_METHOD_VALUES.has(token)) return { kind: 'malformed' };
  const trailing = rest.slice(token.length).trim();
  if (!PROSE_METHOD_TRAILING.test(trailing)) return { kind: 'malformed' };
  return { kind: 'value', value: token };
}

/**
 * The prose `Method:` fallback record for one `review-method[<round>]`
 * occurrence ending at `afterIndex` in `scanContent` (review finding F1):
 * the NEXT non-blank line after the occurrence's own line, and ONLY when
 * that line starts with `Method:`, matching the template's layout, where
 * the `Method:` line immediately follows the marker with no intervening
 * content. A next non-blank line that is something else (another packed
 * marker line, a heading, ...) means no prose record, not a search further
 * down the file. `undefined` when no prose record applies at all.
 */
function findProseMethodRecord(lines: string[], lineOffsets: number[], afterIndex: number): ProseMethodLine | undefined {
  const occurrenceLine = lineIndexForOffset(lineOffsets, afterIndex);
  for (let i = occurrenceLine + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === '') continue;
    if (!trimmed.startsWith('Method:')) return undefined;
    return resolveProseMethodLine(trimmed);
  }
  return undefined;
}

/** 0-based start offset of each line in `content` (index 0 is always 0). */
function buildLineOffsets(content: string): number[] {
  const offsets = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

/** 0-based index of the line containing character `index`, given `offsets` from `buildLineOffsets`. */
function lineIndexForOffset(offsets: number[], index: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] <= index) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

interface ReviewMethodComplianceResult {
  reasons: string[];
}

/**
 * Fail-closed check: a round that DECLARED a `review-method[<round>]` (the
 * `review_method` named in that round's briefing) must be matched by a
 * recorded `method_applied` that is AT LEAST as strong (`normal < rigorous <
 * adversarial`), read from either channel: an explicit
 * `method-applied[<round>]` marker, or (review finding F1) the template's own
 * `Method: <value>` prose line immediately following the declaration. A round
 * with no matching record on EITHER channel, or one recording a WEAKER
 * method, is an explicit named blocker; when BOTH channels exist for a round
 * and disagree, that is its own named blocker (neither wins silently). All
 * per-category reasons are bounded (`joinBounded`, review finding F5) rather
 * than one reason per round. Backward compatible by construction: a review
 * file with NO well-formed `review-method[...]` marker at all returns no
 * reasons from the comparison (though a malformed or conflicting near-miss of
 * either marker still blocks, and an orphan `method-applied[<round>]` with no
 * matching declaration is silently ignored, documented rather than evaluated,
 * mirroring how a round nobody declared has nothing to check it against).
 *
 * The `Method:` prose fallback (round 3, review findings F1/F2, tightened
 * round 4) is read only when BOTH hold: (F1) the text after the recognized
 * value token is empty, end-of-sentence punctuation only, or a balanced
 * parenthetical aside followed only by end-of-sentence punctuation -- a
 * qualified or multi-clause sentence whose first word merely happens to be
 * one of the three values (`Method: rigorous for every round except ...
 * (adversarial); ...`, the real shape found in `quickwins-batch48`) is a
 * malformed record, not silently read as that first word, and neither is an
 * aside that never closes or that has trailing text after it closes; and
 * (F2, corrected round 4) the round's OWN declaration line carries exactly
 * one DISTINCT well-formed `review-method[...]` round -- several rounds
 * packed onto one shared line (also `quickwins-batch48`'s
 * `T-011-R1`/`R2`/`R3`) never resolve via the following `Method:` line, since
 * one prose line cannot stand for three distinct rounds' own confirmations,
 * while the SAME round declared twice in agreement on one shared line still
 * counts as single-occurrence for this gate; such a multi-round line falls
 * through to the "no matching record" (absent) reason instead, same as if no
 * `Method:` line followed it at all. Two residuals documented rather than
 * fixed: a fenced code block sitting between the
 * `review-method[<round>]` declaration and its `Method:` line is blanked by
 * `stripQuotedMarkdownText` and so is skipped over rather than treated as
 * intervening content, and only 05-review-findings.md is read at all, so a
 * `method-applied[<round>]` recorded in 03-decisions.md or
 * 04-implementation-summary.md instead is invisible to this check.
 */
function scanReviewMethodCompliance(content: string | null): ReviewMethodComplianceResult {
  if (content === null) return { reasons: [] };

  const scanContent = stripQuotedMarkdownText(content);
  const lineOffsets = buildLineOffsets(scanContent);
  const lines = scanContent.split(/\r?\n/);

  const declared = collectRoundMarkers(content, 'review-method');
  const applied = collectRoundMarkers(content, 'method-applied');
  const reasons: string[] = [];

  if (declared.malformedExcerpts.length > 0) {
    reasons.push(
      `malformed review-method marker(s) in 05-review-findings.md: ${joinBounded(declared.malformedExcerpts, 5, ' | ')} ` +
        "(expected '<!-- review-method[<round>] = normal|rigorous|adversarial -->' with one concrete value)",
    );
  }
  if (applied.malformedExcerpts.length > 0) {
    reasons.push(
      `malformed method-applied marker(s) in 05-review-findings.md: ${joinBounded(applied.malformedExcerpts, 5, ' | ')} ` +
        "(expected '<!-- method-applied[<round>] = normal|rigorous|adversarial -->' with one concrete value)",
    );
  }
  if (declared.conflicts.size > 0) {
    const items = [...declared.conflicts.values()].map((c) => `'${c.round}' (${c.values.join(' vs ')})`);
    reasons.push(
      `conflicting review-method value(s) in 05-review-findings.md for round(s): ${joinBounded(items, 5, ' | ')} ` +
        '(duplicate review-method markers for the same round must agree)',
    );
  }
  if (applied.conflicts.size > 0) {
    const items = [...applied.conflicts.values()].map((c) => `'${c.round}' (${c.values.join(' vs ')})`);
    reasons.push(
      `conflicting method-applied value(s) in 05-review-findings.md for round(s): ${joinBounded(items, 5, ' | ')} ` +
        '(duplicate method-applied markers for the same round must agree)',
    );
  }

  // Backward compatible: no well-formed review-method marker at all → the
  // comparison below never applies, unaffected. (Only true in the narrow
  // sense: the malformed/conflict reasons above already ran unconditionally,
  // so a file with no genuine marker but a near-miss or wrapper-less mention
  // of either field still blocks via those, not via the comparison below.)
  if (declared.markers.size === 0) return { reasons };

  // review finding F2 (round 3, corrected round 4): the `Method:` prose
  // fallback is only safe to associate with a round when its declaration LINE
  // carries exactly one DISTINCT well-formed `review-method[...]` round. Real
  // runs pack several rounds' declarations onto one line followed by a single
  // shared `Method:` summary line (e.g. batch48's `T-011-R1`/`R2`/`R3` sharing
  // one line and one following `Method:` line): reading that one prose line
  // as EACH packed round's own record would let one line silently clear every
  // round packed with it. Round 3 counted raw occurrences per line, which
  // wrongly blocked an agreeing SAME-round duplicate declared twice on one
  // line (`<!-- review-method[R1] = adversarial --> <!-- review-method[R1] =
  // adversarial -->`) as if two different rounds shared it, even though such
  // duplicates are documented (review finding F3) as tolerated when they
  // agree. Round 4 counts DISTINCT lowercased rounds per line instead, so a
  // repeated declaration of the same round does not spoil its own
  // single-occurrence gate.
  const declaredRoundsPerLine = new Map<number, Set<string>>();
  for (const occ of declared.occurrences) {
    const ln = lineIndexForOffset(lineOffsets, occ.endIndex);
    const roundsOnLine = declaredRoundsPerLine.get(ln) ?? new Set<string>();
    roundsOnLine.add(occ.round.toLowerCase());
    declaredRoundsPerLine.set(ln, roundsOnLine);
  }

  const disagreeItems: string[] = [];
  const malformedProseItems: string[] = [];
  const absentItems: string[] = [];
  const weakerItems: string[] = [];

  for (const [lowerRound, decl] of declared.markers) {
    const rec = applied.markers.get(lowerRound);
    const declLine = lineIndexForOffset(lineOffsets, decl.endIndex);
    const singleOccurrenceLine = (declaredRoundsPerLine.get(declLine)?.size ?? 0) === 1;
    const prose = singleOccurrenceLine ? findProseMethodRecord(lines, lineOffsets, decl.endIndex) : undefined;

    if (prose?.kind === 'malformed') {
      malformedProseItems.push(`'${decl.round}'`);
      continue;
    }
    const proseValue = prose?.kind === 'value' ? prose.value : undefined;

    if (rec !== undefined && proseValue !== undefined && rec.value !== proseValue) {
      disagreeItems.push(`'${decl.round}' (marker '${rec.value}' vs prose '${proseValue}')`);
      continue;
    }

    const effectiveValue = rec?.value ?? proseValue;
    if (effectiveValue === undefined) {
      const otherKeys = [...applied.markers.values()].map((v) => v.round);
      const note = otherKeys.length > 0 ? ` (recorded method-applied key(s) present but not matching: ${joinBounded(otherKeys, 5, ', ')})` : '';
      absentItems.push(`'${decl.round}' declared '${decl.value}'${note}`);
      continue;
    }
    if (REVIEW_METHOD_STRENGTH[effectiveValue] < REVIEW_METHOD_STRENGTH[decl.value]) {
      weakerItems.push(`'${decl.round}' declared '${decl.value}', recorded '${effectiveValue}'`);
    }
  }

  if (disagreeItems.length > 0) {
    reasons.push(
      `round(s) with conflicting method_applied records in 05-review-findings.md: ${joinBounded(disagreeItems, 5, ' | ')} ` +
        '(the method-applied marker and the Method: prose line disagree; make them match)',
    );
  }
  if (malformedProseItems.length > 0) {
    reasons.push(
      `round(s) with a malformed 'Method:' prose record in 05-review-findings.md: ${joinBounded(malformedProseItems, 5, ' | ')} ` +
        "(expected 'Method: normal|rigorous|adversarial ...' naming exactly one of the three)",
    );
  }
  if (absentItems.length > 0) {
    reasons.push(
      `round(s) with no matching method_applied record in 05-review-findings.md: ${joinBounded(absentItems, 5, ' | ')} ` +
        "(add '<!-- method-applied[<round>] = <value> -->' once confirmed, or fill in the immediately-following 'Method: <value>' line)",
    );
  }
  if (weakerItems.length > 0) {
    reasons.push(
      `round(s) with a weaker recorded method_applied than declared in 05-review-findings.md: ${joinBounded(weakerItems, 5, ' | ')}`,
    );
  }

  return { reasons };
}

/** Split a `| a | b | ... |` row into trimmed cell strings. */
function splitTableRow(row: string): string[] {
  return row
    .split('|')
    .slice(1, -1)
    .map((c) => c.trim());
}

/** True for a markdown table separator row, e.g. `|---|:--:|` (all dash cells). */
function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function readFileOrNull(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function safeMtimeMs(p: string): number {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
