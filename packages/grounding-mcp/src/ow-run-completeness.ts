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
//     silent pass.
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
//   - The findings table is located by anchoring on the table HEADER ROW (cells
//     include both `Severity` and `Decision`), not the `## Findings` heading
//     text, so a drifted heading (`## Findings (summary)`) cannot fail open.
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

  const finalStatus = resolveMarkerOrProse(handoff, 'final-status', 'Final Status');
  if (finalStatus === null) {
    reasons.push(
      "handoff final-status is unset (no solution-acceptance marker and no filled '## Final Status')",
    );
  } else if (!ACCEPTED_FINAL_STATUS.has(finalStatus.toLowerCase())) {
    reasons.push(`handoff final-status is '${finalStatus}'`);
  }

  const recommendation = resolveMarkerOrProse(
    review,
    'acceptance-recommendation',
    'Acceptance Recommendation',
  );
  if (recommendation === null) {
    reasons.push(
      "review recommendation is unset (no solution-acceptance marker and no filled '## Acceptance Recommendation')",
    );
  } else if (!ACCEPT_RECOMMENDATION.has(recommendation.toLowerCase())) {
    reasons.push(`review recommendation is '${recommendation}'`);
  }

  for (const f of findUnresolvedFindings(review)) {
    reasons.push(`unresolved ${f.severity} finding: ${f.description} (Decision=${f.decision})`);
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
  const marker = matchMarker(goal, 'run-base');
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
 * Resolve an acceptance value marker-first, then fail-closed prose fallback.
 * Returns the concrete value string, or null when it cannot be resolved to a
 * filled value (file missing, marker `TODO`, prose placeholder legend, prose
 * `TODO`, or no value line at all).
 */
function resolveMarkerOrProse(
  content: string | null,
  markerField: string,
  proseHeading: string,
): string | null {
  if (content === null) return null;

  const marker = matchMarker(content, markerField);
  if (marker !== null) return marker === 'TODO' ? null : marker;

  return resolveProseValue(content, proseHeading);
}

/** Match `<!-- solution-acceptance: <field> = <value> -->`, returning the value. */
function matchMarker(content: string, field: string): string | null {
  const re = new RegExp(`solution-acceptance:\\s*${escapeRegExp(field)}\\s*=\\s*(\\S+)`);
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

  let headerIdx = -1;
  let severityIdx = -1;
  let decisionIdx = -1;
  let descriptionIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith('|')) continue;
    const cells = splitTableRow(t);
    const sIdx = cells.findIndex((c) => c.toLowerCase() === 'severity');
    const dIdx = cells.findIndex((c) => c.toLowerCase() === 'decision');
    if (sIdx !== -1 && dIdx !== -1) {
      headerIdx = i;
      severityIdx = sIdx;
      decisionIdx = dIdx;
      descriptionIdx = cells.findIndex((c) => c.toLowerCase() === 'description');
      break;
    }
  }
  if (headerIdx === -1) return [];

  const out: UnresolvedFinding[] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '') break; // blank line ends the table
    if (!t.startsWith('|')) break; // non-table line ends the table
    const cells = splitTableRow(t);
    if (isSeparatorRow(cells)) continue; // the |---| separator row
    if (severityIdx >= cells.length) continue; // no severity cell to classify

    const severity = (cells[severityIdx] ?? '').toLowerCase();
    // Real-finding test: SEVERITY must be a single concrete value. The legend
    // row's slash-list severity fails this and is skipped.
    if (!CONCRETE_SEVERITIES.has(severity)) continue;
    if (!ARMING_SEVERITIES.has(severity)) continue; // low/medium never arm

    // A missing decision cell reads as blank → unset → arms (fail-closed).
    const decision = (cells[decisionIdx] ?? '').toLowerCase();
    if (RESOLVED_DECISIONS.has(decision)) continue; // accepted/defer → resolved

    const description =
      descriptionIdx !== -1 && descriptionIdx < cells.length
        ? cells[descriptionIdx]
        : cells.filter((_, idx) => idx !== severityIdx && idx !== decisionIdx).join(' | ');
    out.push({
      severity,
      description,
      decision: decision === '' ? 'unset' : decision,
    });
  }
  return out;
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
