// Orchestrator-workflow (OW) run-completeness reader.
//
// Pure, side-effect-free read of a repo's OW run files. It answers one
// question: is the *active* OW run process-complete (handoff accepted, review
// recommended accept, no unresolved high/critical findings)?
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
//     (`low/medium/high/critical`, `accepted/fix/defer/reject`). That row is
//     not a real finding; we decide whether a row is a real finding by its
//     SEVERITY cell carrying a single concrete value (the slash-list legend is
//     therefore skipped), and only then judge the Decision.
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
  } else if (recommendation.kind === 'missing') {
    reasons.push(
      "review recommendation is unset (no solution-acceptance marker and no filled '## Acceptance Recommendation')",
    );
  } else if (!ACCEPT_RECOMMENDATION.has(recommendation.value.toLowerCase())) {
    reasons.push(`review recommendation is '${recommendation.value}'`);
  }

  for (const f of findUnresolvedFindings(review)) {
    reasons.push(`unresolved ${f.severity} finding: ${f.description} (Decision=${f.decision})`);
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
  | { kind: 'missing' };

/**
 * Resolve an acceptance value marker-first, then fail-closed prose fallback.
 * A `TODO` marker never falls back to prose: the marker is the machine
 * channel, and an unfilled machine channel must surface as exactly that.
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

/**
 * Findings rows that arm the gate.
 *
 * Location (Fix 1): the table is found by anchoring on its HEADER ROW — the
 * first markdown table row whose cells include both `Severity` and `Decision`
 * (case-insensitive) — not by the `## Findings` heading text. A drifted heading
 * (`## Findings (summary)`) therefore cannot hide a real finding. The column
 * positions of Severity and Decision are taken from that header. Data rows are
 * read after the `|---|` separator until the table ends (blank or non-table
 * line).
 *
 * Arming (Fix 2): whether a row is a real finding is decided by the SEVERITY
 * cell carrying a single concrete value — the slash-list legend row
 * (`low/medium/high/critical`), the separator, and the header are all skipped
 * this way. A concrete high/critical row then ARMS the gate UNLESS its Decision
 * is explicitly resolved ({accepted, defer}); fix, reject, blank, `open`,
 * `TODO`, and any unrecognized decision all block (fail-closed).
 */
function findUnresolvedFindings(content: string | null): UnresolvedFinding[] {
  if (content === null) return [];
  const lines = content.split(/\r?\n/);

  const out: UnresolvedFinding[] = [];
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
      if (header.severityIdx >= cells.length) continue; // no severity cell to classify

      const severity = (cells[header.severityIdx] ?? '').toLowerCase();
      // Real-finding test: SEVERITY must be a single concrete value. The legend
      // row's slash-list severity fails this and is skipped.
      if (!CONCRETE_SEVERITIES.has(severity)) continue;
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
      out.push({
        severity,
        description,
        decision: decision === '' ? 'unset' : decision,
      });
    }
    i = j;
  }
  return out;
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
  const lines = content.split(/\r?\n/);

  if (lines.some((l) => parseFindingsHeaderRow(l) !== null)) return null;

  const headingIdx = lines.findIndex((l) => /^#{1,6}\s*findings\b/i.test(l.trim()));
  if (headingIdx === -1) return null;

  for (let i = headingIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^#{1,6}\s/.test(t)) break; // next section ends the findings section
    if (t === '') continue;
    if (t.startsWith('<!--')) continue; // template placeholder comments
    return (
      'review findings are present but not in the expected table format ' +
      '(header row with Severity and Decision columns); rewrite them as the ' +
      'findings table so they can be verified'
    );
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
