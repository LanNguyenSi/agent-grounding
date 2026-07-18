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

import fs from 'node:fs';
import path from 'node:path';

export interface OwRunCompleteness {
  /** true iff an OW run dir was found at `<repoPath>/.ai/runs/`. */
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
  const activeRun = findActiveRun(repoPath);
  if (activeRun === null) {
    return {
      enforced: false,
      complete: false,
      reasons: ['no .ai/runs/ run directory found'],
      runName: null,
      runBase: null,
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

  return {
    enforced: true,
    complete: reasons.length === 0,
    reasons,
    runName: path.basename(activeRun),
    runBase: resolveRunBase(goal),
  };
}

/**
 * The `run-base` binding marker value from a run's `00-goal.md` content, or
 * null when the file/marker is missing or the marker is the `TODO`
 * placeholder. No validation happens here — the raw value is handed to the
 * verdict layer, which validates it (strict hex) BEFORE any git invocation.
 */
function resolveRunBase(goal: string | null): string | null {
  if (goal === null) return null;
  // Raw \S+ capture on purpose: sha values may start with a digit (the enum
  // charset would reject them), and a malformed value must reach the verdict
  // layer's hex guard so it blocks explicitly instead of downgrading silently
  // to the date heuristic.
  const marker = matchMarker(goal, 'run-base', '\\S+');
  return marker === null || marker === 'TODO' ? null : marker;
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
