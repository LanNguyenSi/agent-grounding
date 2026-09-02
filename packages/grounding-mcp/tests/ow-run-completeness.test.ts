// OW run-completeness reader.
//
// Each test builds a throwaway repo under os.tmpdir() with one or more
// `.ai/runs/<date-slug>/` dirs holding fixture handoff + review files, then
// asserts the pure reader's verdict. Fixtures are cleaned up in afterEach.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { OW_FINDINGS_PLACEHOLDER_ROW, readOwRunCompleteness } from '../src/ow-run-completeness.js';

let repo: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-run-completeness-'));
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

interface RunFiles {
  handoff?: string;
  review?: string;
  goal?: string;
}

function makeRun(runName: string, files: RunFiles): string {
  const dir = path.join(repo, '.ai', 'runs', runName);
  fs.mkdirSync(dir, { recursive: true });
  if (files.handoff !== undefined) {
    fs.writeFileSync(path.join(dir, '06-handoff.md'), files.handoff, 'utf8');
  }
  if (files.review !== undefined) {
    fs.writeFileSync(path.join(dir, '05-review-findings.md'), files.review, 'utf8');
  }
  if (files.goal !== undefined) {
    fs.writeFileSync(path.join(dir, '00-goal.md'), files.goal, 'utf8');
  }
  return dir;
}

/** Handoff with a filled solution-acceptance marker. */
function handoffMarker(value: string): string {
  return [
    '# Operator Handoff',
    '',
    '## Final Status',
    '',
    `<!-- solution-acceptance: final-status = ${value} -->`,
    value,
    '',
  ].join('\n');
}

/** Handoff with NO marker; prose section is the unfilled enum legend. */
function handoffProseLegend(): string {
  return [
    '# Operator Handoff',
    '',
    '## Final Status',
    '',
    'accepted | accepted_with_notes | needs_followup | blocked',
    '',
  ].join('\n');
}

interface ReviewOpts {
  /** Marker value; when omitted, the recommendation section is the unfilled legend. */
  recommendationMarker?: string;
  /** Extra concrete findings table rows (full `| ... |` markdown rows). */
  findingRows?: string[];
}

/**
 * Review file with the shipped placeholder legend row plus any extra rows.
 * The legend row is the byte-exact current template row (see
 * `OW_FINDINGS_PLACEHOLDER_ROW` in the reader): with NO `findingRows`, this
 * reproduces the mixed-state bypass shape (placeholder present, nothing
 * transferred) — tests that want a genuinely complete review must pass a
 * concrete `findingRows` entry or use `reviewDocNoFindings()` instead.
 */
function reviewDoc(opts: ReviewOpts = {}): string {
  const rows = [
    '| Severity | Category | Description | Suggested Fix | Decision |',
    '|---|---|---|---|---|',
    // The shipped template's legend / placeholder row — must be skipped as a
    // finding, but its untouched presence with no concrete row anywhere is
    // itself the mixed-state bypass this test file also covers below.
    OW_FINDINGS_PLACEHOLDER_ROW,
    ...(opts.findingRows ?? []),
  ];
  const recommendationBlock =
    opts.recommendationMarker !== undefined
      ? [
          `<!-- solution-acceptance: acceptance-recommendation = ${opts.recommendationMarker} -->`,
          opts.recommendationMarker,
        ]
      : ['accept | accept_with_notes | fix_required | reject'];
  return [
    '# Review Findings',
    '',
    '## Findings',
    '',
    ...rows,
    '',
    '## Acceptance Recommendation',
    '',
    ...recommendationBlock,
    '',
  ].join('\n');
}

/**
 * Review file for a genuine zero-findings review: header + separator, NO
 * placeholder row and no data rows (the operator deleted the placeholder row
 * per its documented escape hatch). Used by tests whose point is the overall
 * acceptance flow, not the findings table itself, so they are not entangled
 * with the mixed-state bypass guard covered separately below.
 */
function reviewDocNoFindings(opts: ReviewOpts = {}): string {
  const recommendationBlock =
    opts.recommendationMarker !== undefined
      ? [
          `<!-- solution-acceptance: acceptance-recommendation = ${opts.recommendationMarker} -->`,
          opts.recommendationMarker,
        ]
      : ['accept | accept_with_notes | fix_required | reject'];
  return [
    '# Review Findings',
    '',
    '## Findings',
    '',
    '| Severity | Category | Description | Suggested Fix | Decision |',
    '|---|---|---|---|---|',
    ...(opts.findingRows ?? []),
    '',
    '## Acceptance Recommendation',
    '',
    ...recommendationBlock,
    '',
  ].join('\n');
}

describe('readOwRunCompleteness — enforcement', () => {
  it('reports enforced:false when there is no .ai/runs/ directory', () => {
    const r = readOwRunCompleteness(repo);
    expect(r).toEqual({
      enforced: false,
      complete: false,
      reasons: ['no .ai/runs/ run directory found'],
      runName: null,
      runBase: null,
      runSource: null,
      runBaseKind: 'absent',
    });
  });

  it('reports enforced:false when .ai/runs/ exists but holds no run dir', () => {
    const runsDir = path.join(repo, '.ai', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    fs.writeFileSync(path.join(runsDir, 'README.md'), 'not a run dir', 'utf8');
    const r = readOwRunCompleteness(repo);
    expect(r.enforced).toBe(false);
    expect(r.complete).toBe(false);
  });
});

describe('readOwRunCompleteness — newest-run selection', () => {
  it('reads the newest run dir by name (date prefix → chronological)', () => {
    // Older run is blocked; newest run is fully accepted → reads the newest.
    makeRun('2026-06-20-old', {
      handoff: handoffMarker('blocked'),
      review: reviewDoc({ recommendationMarker: 'fix_required' }),
    });
    makeRun('2026-06-22-new', {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
    });
    const r = readOwRunCompleteness(repo);
    expect(r.enforced).toBe(true);
    expect(r.complete).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('flips the verdict when the date prefixes are flipped', () => {
    // Same two content blocks, but the newest dir now carries the bad one.
    makeRun('2026-06-20-old', {
      handoff: handoffMarker('accepted'),
      review: reviewDoc({ recommendationMarker: 'accept' }),
    });
    makeRun('2026-06-22-new', {
      handoff: handoffMarker('blocked'),
      review: reviewDoc({ recommendationMarker: 'fix_required' }),
    });
    const r = readOwRunCompleteness(repo);
    expect(r.enforced).toBe(true);
    expect(r.complete).toBe(false);
  });
});

describe('readOwRunCompleteness — completeness verdict', () => {
  it('happy path: accepted handoff + accept review + no high/critical-fix → complete', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
    });
    const r = readOwRunCompleteness(repo);
    expect(r).toEqual({
      enforced: true,
      complete: true,
      reasons: [],
      runName: '2026-06-22-run',
      runBase: null,
      runSource: 'scan',
      runBaseKind: 'absent',
    });
  });

  it('accepted_with_notes + accept_with_notes also count as accepted', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted_with_notes'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept_with_notes' }),
    });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('blocked handoff → not complete, reason names final-status and blocked', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('blocked'),
      review: reviewDoc({ recommendationMarker: 'accept' }),
    });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    const reason = r.reasons.find((x) => x.includes('final-status'));
    expect(reason).toBeDefined();
    expect(reason).toContain('blocked');
  });

  it('fix_required review → not complete, reason names the recommendation', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted'),
      review: reviewDoc({ recommendationMarker: 'fix_required' }),
    });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    const reason = r.reasons.find((x) => x.includes('recommendation'));
    expect(reason).toBeDefined();
    expect(reason).toContain('fix_required');
  });

  it('a critical/fix finding arms the gate even when the recommendation is accept_with_notes', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted'),
      review: reviewDoc({
        recommendationMarker: 'accept_with_notes',
        findingRows: ['| critical | correctness | data loss on save | add a guard | fix |'],
      }),
    });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    const reason = r.reasons.find((x) => x.startsWith('unresolved'));
    expect(reason).toBeDefined();
    expect(reason).toContain('critical');
    expect(reason).toContain('data loss on save');
    expect(reason).toContain('Decision=fix');
  });

  it('a high/reject finding also arms the gate', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted'),
      review: reviewDoc({
        recommendationMarker: 'accept',
        findingRows: ['| high | security | auth bypass | enforce check | reject |'],
      }),
    });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    expect(r.reasons.some((x) => x.includes('high') && x.includes('Decision=reject'))).toBe(true);
  });

  it('a low/fix finding and a high/defer finding do NOT arm the gate', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted'),
      review: reviewDoc({
        recommendationMarker: 'accept',
        findingRows: [
          '| low | tests | flaky test | stabilize | fix |',
          '| high | performance | slow query | index later | defer |',
        ],
      }),
    });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(true);
    expect(r.reasons).toEqual([]);
  });
});

describe('readOwRunCompleteness — fail-closed fallback', () => {
  it('no marker + prose enum legend → not complete (treated as unset)', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffProseLegend(),
      review: reviewDoc(), // no recommendationMarker → prose legend
    });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    expect(r.reasons.some((x) => x.includes('final-status') && x.includes('unset'))).toBe(true);
    expect(r.reasons.some((x) => x.includes('recommendation') && x.includes('unset'))).toBe(true);
  });

  it('no marker + filled prose value is honored', () => {
    const handoff = ['# Operator Handoff', '', '## Final Status', '', 'accepted', ''].join('\n');
    const review = [
      '# Review Findings',
      '',
      '## Findings',
      '',
      '| Severity | Category | Description | Suggested Fix | Decision |',
      '|---|---|---|---|---|',
      '| low/medium/high/critical | x | <!-- finding --> | <!-- fix --> | accepted/fix/defer/reject |',
      '',
      '## Acceptance Recommendation',
      '',
      'accept',
      '',
    ].join('\n');
    makeRun('2026-06-22-run', { handoff, review });
    const r = readOwRunCompleteness(repo);
    expect(r).toEqual({
      enforced: true,
      complete: true,
      reasons: [],
      runName: '2026-06-22-run',
      runBase: null,
      runSource: 'scan',
      runBaseKind: 'absent',
    });
  });

  it('TODO marker is never a valid acceptance value and names itself in the reason', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('TODO'),
      review: reviewDoc({ recommendationMarker: 'accept' }),
    });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    const reason = r.reasons.find((x) => x.includes('final-status'));
    expect(reason).toBeDefined();
    expect(reason).toContain('handoff final-status marker is still TODO');
  });

  it('TODO marker + FILLED prose still blocks with the TODO reason, not the misleading unset one', () => {
    // The marker is the machine channel; a TODO marker must never silently
    // fall back to the (filled) prose value, and the reason must name the
    // actual problem instead of claiming there is no marker at all.
    const handoff = [
      '# Operator Handoff',
      '',
      '## Final Status',
      '',
      '<!-- solution-acceptance: final-status = TODO -->',
      'accepted',
      '',
    ].join('\n');
    makeRun('2026-06-22-run', {
      handoff,
      review: reviewDoc({ recommendationMarker: 'accept' }),
    });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    const reason = r.reasons.find((x) => x.includes('final-status'));
    expect(reason).toContain('handoff final-status marker is still TODO');
    expect(reason).not.toContain('unset');
  });

  it('TODO recommendation marker names itself too', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted'),
      review: reviewDoc({ recommendationMarker: 'TODO' }),
    });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    expect(
      r.reasons.some((x) => x.includes('review recommendation marker is still TODO')),
    ).toBe(true);
  });

  it('sloppy marker spacing (`= accepted-->`) resolves to the enum value', () => {
    const handoff = [
      '# Operator Handoff',
      '',
      '## Final Status',
      '',
      '<!-- solution-acceptance: final-status = accepted-->',
      'accepted',
      '',
    ].join('\n');
    const review = [
      '# Review Findings',
      '',
      '## Findings',
      '',
      '| Severity | Category | Description | Suggested Fix | Decision |',
      '|---|---|---|---|---|',
      '| low/medium/high/critical | x | <!-- finding --> | <!-- fix --> | accepted/fix/defer/reject |',
      '',
      '## Acceptance Recommendation',
      '',
      '<!-- solution-acceptance: acceptance-recommendation = accept-->',
      'accept',
      '',
    ].join('\n');
    makeRun('2026-06-22-run', { handoff, review });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('missing handoff and review files → not complete (fail-closed)', () => {
    makeRun('2026-06-22-run', {}); // empty run dir, no files
    const r = readOwRunCompleteness(repo);
    expect(r.enforced).toBe(true);
    expect(r.complete).toBe(false);
    expect(r.reasons.length).toBeGreaterThanOrEqual(2);
  });
});

describe('readOwRunCompleteness — findings table located by header row (Fix 1)', () => {
  it('a critical/fix finding under a drifted `## Findings (summary)` heading STILL blocks', () => {
    const review = [
      '# Review Findings',
      '',
      '## Findings (summary)', // drifted heading — must not hide the finding
      '',
      '| Severity | Category | Description | Suggested Fix | Decision |',
      '|---|---|---|---|---|',
      '| low/medium/high/critical | x | <!-- finding --> | <!-- fix --> | accepted/fix/defer/reject |',
      '| critical | correctness | silent data loss | add guard | fix |',
      '',
      '## Acceptance Recommendation',
      '',
      '<!-- solution-acceptance: acceptance-recommendation = accept -->',
      'accept',
      '',
    ].join('\n');
    makeRun('2026-06-22-run', { handoff: handoffMarker('accepted'), review });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    const reason = r.reasons.find((x) => x.startsWith('unresolved'));
    expect(reason).toBeDefined();
    expect(reason).toContain('critical');
    expect(reason).toContain('silent data loss');
    expect(reason).toContain('Decision=fix');
  });
});

describe('readOwRunCompleteness — undecided high/critical arms the gate (Fix 2)', () => {
  it('a high finding with a BLANK decision and a critical finding with `open` both BLOCK', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted'),
      review: reviewDoc({
        recommendationMarker: 'accept',
        findingRows: [
          '| high | security | secret leak | rotate | |', // blank Decision
          '| critical | correctness | crash on null | guard | open |', // unknown Decision
        ],
      }),
    });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    expect(
      r.reasons.some((x) => x.includes('high') && x.includes('secret leak') && x.includes('Decision=unset')),
    ).toBe(true);
    expect(
      r.reasons.some(
        (x) => x.includes('critical') && x.includes('crash on null') && x.includes('Decision=open'),
      ),
    ).toBe(true);
  });

  it('a high/accepted finding and a critical/defer finding are resolved → do NOT block', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted'),
      review: reviewDoc({
        recommendationMarker: 'accept',
        findingRows: [
          '| high | security | handled leak | rotated | accepted |',
          '| critical | correctness | mitigated crash | patched | defer |',
        ],
      }),
    });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(true);
    expect(r.reasons).toEqual([]);
  });
});

describe('readOwRunCompleteness — active-run selection requires a date prefix (Fix 3)', () => {
  it('a non-date-prefixed sibling dir (`archive`) is ignored; the dated run wins', () => {
    // `archive` sorts AHEAD of the dated dir under a plain descending name sort
    // ('a' > '2'), so without the date filter it would hijack the active run.
    makeRun('archive', {
      handoff: handoffMarker('blocked'),
      review: reviewDoc({ recommendationMarker: 'fix_required' }),
    });
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
    });
    const r = readOwRunCompleteness(repo);
    expect(r.enforced).toBe(true);
    expect(r.complete).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('when only non-dated dirs exist → enforced:false (negative control)', () => {
    makeRun('archive', {
      handoff: handoffMarker('accepted'),
      review: reviewDoc({ recommendationMarker: 'accept' }),
    });
    const r = readOwRunCompleteness(repo);
    expect(r.enforced).toBe(false);
    expect(r.complete).toBe(false);
  });
});

describe('readOwRunCompleteness — multi-table and non-table findings', () => {
  it('an unresolved critical in a SECOND appended table arms the gate', () => {
    // A second review round appended its own table below the first. Before
    // the multi-table fix only the first table was parsed (fail-open).
    const review = [
      '# Review Findings',
      '',
      '## Findings',
      '',
      '| Severity | Category | Description | Suggested Fix | Decision |',
      '|---|---|---|---|---|',
      '| low/medium/high/critical | x | <!-- finding --> | <!-- fix --> | accepted/fix/defer/reject |',
      '| high | security | round-one leak | rotate | accepted |',
      '',
      '## Findings (round 2)',
      '',
      '| Severity | Category | Description | Suggested Fix | Decision |',
      '|---|---|---|---|---|',
      '| critical | correctness | round-two data loss | add guard | fix |',
      '',
      '## Acceptance Recommendation',
      '',
      '<!-- solution-acceptance: acceptance-recommendation = accept -->',
      'accept',
      '',
    ].join('\n');
    makeRun('2026-06-22-run', { handoff: handoffMarker('accepted'), review });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    expect(
      r.reasons.some((x) => x.includes('critical') && x.includes('round-two data loss')),
    ).toBe(true);
  });

  it('findings from BOTH tables are collected', () => {
    const review = [
      '## Findings',
      '',
      '| Severity | Category | Description | Suggested Fix | Decision |',
      '|---|---|---|---|---|',
      '| high | security | first-table leak | rotate | fix |',
      '',
      '| Severity | Category | Description | Suggested Fix | Decision |',
      '|---|---|---|---|---|',
      '| critical | correctness | second-table crash | guard | reject |',
      '',
      '## Acceptance Recommendation',
      '',
      '<!-- solution-acceptance: acceptance-recommendation = accept -->',
      'accept',
      '',
    ].join('\n');
    makeRun('2026-06-22-run', { handoff: handoffMarker('accepted'), review });
    const r = readOwRunCompleteness(repo);
    expect(r.reasons.some((x) => x.includes('first-table leak'))).toBe(true);
    expect(r.reasons.some((x) => x.includes('second-table crash'))).toBe(true);
  });

  it('list-format findings with NO table anywhere yield an explicit format blocker', () => {
    const review = [
      '# Review Findings',
      '',
      '## Findings',
      '',
      '- critical: silent data loss on save (decision: fix)',
      '',
      '## Acceptance Recommendation',
      '',
      '<!-- solution-acceptance: acceptance-recommendation = accept -->',
      'accept',
      '',
    ].join('\n');
    makeRun('2026-06-22-run', { handoff: handoffMarker('accepted'), review });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    expect(r.reasons.some((x) => x.includes('not in the expected table format'))).toBe(true);
  });

  it('must-pass pair: a proper table with resolved findings raises no format blocker', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted'),
      review: reviewDoc({
        recommendationMarker: 'accept',
        findingRows: ['| high | security | handled leak | rotated | accepted |'],
      }),
    });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('a malformed marker value + filled accepted prose still BLOCKS (no prose override)', () => {
    // The machine channel is present but broken; a filled prose line must not
    // silently win. Before this fix the failed enum match fell through to the
    // prose fallback and the gate passed.
    const handoff = [
      '# Operator Handoff',
      '',
      '## Final Status',
      '',
      '<!-- solution-acceptance: final-status = 1accepted -->',
      'accepted',
      '',
    ].join('\n');
    makeRun('2026-06-22-run', {
      handoff,
      review: reviewDoc({ recommendationMarker: 'accept' }),
    });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    const reason = r.reasons.find((x) => x.includes('final-status'));
    expect(reason).toContain("handoff final-status marker value '1accepted' is malformed");
  });

  it('a multi-line HTML comment in the findings section raises no spurious format blocker', () => {
    const review = [
      '## Findings',
      '',
      '<!-- one row per finding,',
      'spanning multiple lines -->',
      '',
      '## Acceptance Recommendation',
      '',
      '<!-- solution-acceptance: acceptance-recommendation = accept -->',
      'accept',
      '',
    ].join('\n');
    makeRun('2026-06-22-run', { handoff: handoffMarker('accepted'), review });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('list content under a SECOND findings heading still raises the format blocker', () => {
    const review = [
      '## Findings',
      '',
      '## Findings (round 2)',
      '',
      '- critical: hidden list finding (fix)',
      '',
      '## Acceptance Recommendation',
      '',
      '<!-- solution-acceptance: acceptance-recommendation = accept -->',
      'accept',
      '',
    ].join('\n');
    makeRun('2026-06-22-run', { handoff: handoffMarker('accepted'), review });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    expect(r.reasons.some((x) => x.includes('not in the expected table format'))).toBe(true);
  });

  it('pins the live-convention drift: a Decision-less table (Severity/Finding/Resolution) blocks', () => {
    // Some reviewer outputs in the wild use `| Severity | Finding | Resolution |`.
    // That header cannot be verified (no Decision column), so the fail-closed
    // format blocker fires; converging the convention is a kit concern.
    const review = [
      '## Findings',
      '',
      '| Severity | Finding | Resolution |',
      '|---|---|---|',
      '| high | leak | rotated |',
      '',
      '## Acceptance Recommendation',
      '',
      '<!-- solution-acceptance: acceptance-recommendation = accept -->',
      'accept',
      '',
    ].join('\n');
    makeRun('2026-06-22-run', { handoff: handoffMarker('accepted'), review });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    expect(r.reasons.some((x) => x.includes('not in the expected table format'))).toBe(true);
  });

  it('an EMPTY findings section (comments/blank only) raises no format blocker', () => {
    const review = [
      '## Findings',
      '',
      '<!-- one row per finding -->',
      '',
      '## Acceptance Recommendation',
      '',
      '<!-- solution-acceptance: acceptance-recommendation = accept -->',
      'accept',
      '',
    ].join('\n');
    makeRun('2026-06-22-run', { handoff: handoffMarker('accepted'), review });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(true);
    expect(r.reasons).toEqual([]);
  });
});

describe('readOwRunCompleteness — run-base binding marker extraction', () => {
  const SHA = '7872f3c4e266786ba3d60f6200f20b45ac47e193';

  function goalWithMarker(value: string): string {
    return ['# Goal', '', `<!-- solution-acceptance: run-base = ${value} -->`, '', '## Goal', ''].join(
      '\n',
    );
  }

  it('extracts the run-base marker value and the run dir basename', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted'),
      review: reviewDoc({ recommendationMarker: 'accept' }),
      goal: goalWithMarker(SHA),
    });
    const r = readOwRunCompleteness(repo);
    expect(r.runName).toBe('2026-06-22-run');
    expect(r.runBase).toBe(SHA);
    expect(r.runBaseKind).toBe('sha');
  });

  it('returns runBase null when 00-goal.md is missing (legacy run)', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted'),
      review: reviewDoc({ recommendationMarker: 'accept' }),
    });
    const r = readOwRunCompleteness(repo);
    expect(r.runName).toBe('2026-06-22-run');
    expect(r.runBase).toBeNull();
    expect(r.runBaseKind).toBe('absent');
  });

  it('returns runBase null when 00-goal.md has no run-base marker', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted'),
      review: reviewDoc({ recommendationMarker: 'accept' }),
      goal: '# Goal\n\n## Goal\n\nsome goal text\n',
    });
    const r = readOwRunCompleteness(repo);
    expect(r.runBase).toBeNull();
    expect(r.runBaseKind).toBe('absent');
  });

  it('treats a TODO run-base placeholder as absent', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted'),
      review: reviewDoc({ recommendationMarker: 'accept' }),
      goal: goalWithMarker('TODO'),
    });
    const r = readOwRunCompleteness(repo);
    expect(r.runBase).toBeNull();
    expect(r.runBaseKind).toBe('todo');
  });

  it('hands a malformed marker value through raw (validation is the verdict layer)', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted'),
      review: reviewDoc({ recommendationMarker: 'accept' }),
      goal: goalWithMarker('not-a-sha'),
    });
    expect(readOwRunCompleteness(repo).runBase).toBe('not-a-sha');
  });

  it('extracts the run-base marker from a CRLF 00-goal.md', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted'),
      review: reviewDoc({ recommendationMarker: 'accept' }),
      goal: ['# Goal', '', `<!-- solution-acceptance: run-base = ${SHA} -->`, ''].join('\r\n'),
    });
    expect(readOwRunCompleteness(repo).runBase).toBe(SHA);
  });
});

describe('readOwRunCompleteness — CRLF fixtures (Fix 4)', () => {
  it('parses markers and the findings table when the files use \\r\\n line endings', () => {
    const handoff = [
      '# Operator Handoff',
      '',
      '## Final Status',
      '',
      '<!-- solution-acceptance: final-status = accepted -->',
      'accepted',
      '',
    ].join('\r\n');
    const review = [
      '# Review Findings',
      '',
      '## Findings',
      '',
      '| Severity | Category | Description | Suggested Fix | Decision |',
      '|---|---|---|---|---|',
      '| low/medium/high/critical | x | <!-- finding --> | <!-- fix --> | accepted/fix/defer/reject |',
      '| critical | correctness | crlf data loss | add guard | fix |',
      '',
      '## Acceptance Recommendation',
      '',
      '<!-- solution-acceptance: acceptance-recommendation = accept -->',
      'accept',
      '',
    ].join('\r\n');
    makeRun('2026-06-22-run', { handoff, review });
    const r = readOwRunCompleteness(repo);
    // Markers parsed: no unset final-status / recommendation reasons.
    expect(r.reasons.some((x) => x.includes('final-status'))).toBe(false);
    expect(r.reasons.some((x) => x.includes('recommendation'))).toBe(false);
    // Table parsed: the legend row was skipped, the real critical/fix row armed.
    expect(r.complete).toBe(false);
    expect(
      r.reasons.some(
        (x) => x.includes('critical') && x.includes('crlf data loss') && x.includes('Decision=fix'),
      ),
    ).toBe(true);
  });

  it('the mixed-state bypass guard fires under CRLF line endings too (exact placeholder row, no concrete row)', () => {
    const handoff = [
      '# Operator Handoff',
      '',
      '## Final Status',
      '',
      '<!-- solution-acceptance: final-status = accepted -->',
      'accepted',
      '',
    ].join('\r\n');
    const review = [
      '# Review Findings',
      '',
      '## Findings',
      '',
      '| Severity | Category | Description | Suggested Fix | Decision |',
      '|---|---|---|---|---|',
      OW_FINDINGS_PLACEHOLDER_ROW,
      '',
      '## Acceptance Recommendation',
      '',
      '<!-- solution-acceptance: acceptance-recommendation = accept -->',
      'accept',
      '',
    ].join('\r\n');
    makeRun('2026-06-22-run', { handoff, review });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    expect(
      r.reasons.some(
        (x) =>
          x.includes('placeholder row') &&
          x.includes('transfer') &&
          x.includes('zero-findings review'),
      ),
    ).toBe(true);
  });
});

describe('readOwRunCompleteness — mixed-state findings-table bypass guard', () => {
  /**
   * Byte-identical to a real shipped run's `05-review-findings.md`
   * (`.ai/runs/2026-07-17-better-sqlite3-node26-release/05-review-findings.md`
   * in this workspace, itself byte-identical to the agent-dx
   * orchestrator-workflow template of that vintage) except for the trailing
   * `acceptance-recommendation` marker value, which each test below
   * substitutes explicitly — this is the exact repro pair from the run plan
   * (repro-a: TODO marker; repro-b: marker flipped to `accept`, table never
   * touched).
   */
  function belegRunReview(recommendationValue: string): string {
    return [
      '# Review Findings',
      '',
      '## Review Summary',
      '',
      '<!-- Short summary. -->',
      '',
      '## Findings',
      '',
      '<!-- The Severity and Decision column headers below are load-bearing: the orchestrator-workflow completeness reader locates this table by its header row and verifies unresolved findings from those two columns. Do not rename or drop them. -->',
      "<!-- Decision legend: a high/critical finding counts as RESOLVED (the completeness gate passes) only when its Decision is `accepted` (finding addressed or consciously accepted) or `defer` (recorded as a tracked follow-up). Every other value (`fix`, `reject`, blank, `open`, `TODO`) leaves the finding unresolved and ARMS the gate until you change the Decision to `accepted`/`defer` or drop the finding. This mirrors grounding-mcp's RESOLVED_DECISIONS = {accepted, defer}; keep the two in sync. -->",
      '| Severity | Category | Description | Suggested Fix | Decision |',
      '|---|---|---|---|---|',
      OW_FINDINGS_PLACEHOLDER_ROW,
      '',
      '## Missing Tests',
      '',
      '- <!-- missing test -->',
      '',
      '## Residual Risks',
      '',
      '- <!-- risk -->',
      '',
      '## Acceptance Recommendation',
      '',
      'accept | accept_with_notes | fix_required | reject',
      '',
      `<!-- solution-acceptance: acceptance-recommendation = ${recommendationValue} -->`,
      '',
    ].join('\n');
  }

  it('repro-a: the byte-identical untouched template (TODO marker) still blocks via the TODO reason', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted'),
      review: belegRunReview('TODO'),
    });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    expect(
      r.reasons.some((x) => x.includes('review recommendation marker is still TODO')),
    ).toBe(true);
  });

  it('repro-b (the mixed-state bypass): marker flipped to accept, findings table left as the untouched placeholder → still blocks', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted'),
      review: belegRunReview('accept'),
    });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    expect(
      r.reasons.some(
        (x) =>
          x.includes('placeholder row') &&
          x.includes('transfer') &&
          x.includes('zero-findings review'),
      ),
    ).toBe(true);
  });

  it('a header row with NO data rows at all (placeholder already deleted) → complete', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
    });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('a concrete resolved finding row with NO placeholder row left behind → complete (findings transferred, placeholder deleted)', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({
        recommendationMarker: 'accept',
        findingRows: ['| low | tests | flaky test noted, no fix needed | n/a | accepted |'],
      }),
    });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('a concrete resolved finding row NEXT TO a left-behind placeholder row → still complete (unaffected, as before)', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted'),
      review: reviewDoc({
        recommendationMarker: 'accept',
        findingRows: ['| low | tests | flaky test noted, no fix needed | n/a | accepted |'],
      }),
    });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('fail-open boundary: a NON-EXACT (pre-0.7.4) legend row with no concrete row does NOT arm the bypass guard', () => {
    // Pins the byte-exact match from the fail-open side: this legend row is
    // structurally the same kind of thing (slash-list Severity, comment
    // cells) but is NOT the current shipped placeholder text (older 4-value
    // Decision legend, narrower Category list), so isPlaceholderRow() must
    // NOT recognize it — the mixed-state bypass guard stays silent and prior
    // (pre-guard) behavior is preserved for this row.
    const review = [
      '# Review Findings',
      '',
      '## Findings',
      '',
      '| Severity | Category | Description | Suggested Fix | Decision |',
      '|---|---|---|---|---|',
      '| low/medium/high/critical | correctness/architecture/security | <!-- finding --> | <!-- fix --> | accepted/fix/defer/reject |',
      '',
      '## Acceptance Recommendation',
      '',
      '<!-- solution-acceptance: acceptance-recommendation = accept -->',
      'accept',
      '',
    ].join('\n');
    makeRun('2026-06-22-run', { handoff: handoffMarker('accepted'), review });
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(true);
    expect(r.reasons).toEqual([]);
  });
});

describe('readOwRunCompleteness — worktree-local run pointer', () => {
  // Extra tmp dirs outside `repo` (a run outside the repo, or a differently
  // named root for the run-base keyed-selection tests below) are tracked here
  // and cleaned up alongside `repo`.
  let extraDirs: string[];

  beforeEach(() => {
    extraDirs = [];
  });

  afterEach(() => {
    for (const d of extraDirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function externalTmpDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-run-completeness-ext-'));
    extraDirs.push(d);
    return d;
  }

  /** A directory with an exact chosen basename, outside `repo`. */
  function namedRoot(basename: string): string {
    const root = path.join(externalTmpDir(), basename);
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  /** Write a run's fixture files at an arbitrary absolute directory. */
  function makeRunAt(dir: string, files: RunFiles): string {
    fs.mkdirSync(dir, { recursive: true });
    if (files.handoff !== undefined) {
      fs.writeFileSync(path.join(dir, '06-handoff.md'), files.handoff, 'utf8');
    }
    if (files.review !== undefined) {
      fs.writeFileSync(path.join(dir, '05-review-findings.md'), files.review, 'utf8');
    }
    if (files.goal !== undefined) {
      fs.writeFileSync(path.join(dir, '00-goal.md'), files.goal, 'utf8');
    }
    return dir;
  }

  function writePointer(worktreeRoot: string, content: string): void {
    const dir = path.join(worktreeRoot, '.ai');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run'), content, 'utf8');
  }

  it('pointer wins over a newer run directory', () => {
    const external = externalTmpDir();
    const runA = path.join(external, '.ai', 'runs', '2026-01-01-a');
    makeRunAt(runA, {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
    });
    writePointer(repo, runA);
    // A newer run under the repo's own .ai/runs/, NOT complete — must be ignored.
    makeRun('2026-02-02-b', {
      handoff: handoffMarker('blocked'),
      review: reviewDoc({ recommendationMarker: 'fix_required' }),
    });

    const r = readOwRunCompleteness(repo);
    expect(r.runName).toBe('2026-01-01-a');
    expect(r.complete).toBe(true);
    expect(r.runSource).toBe('pointer');
  });

  it('second pointer line base=<sha> is ignored', () => {
    const runA = makeRun('2026-01-01-a', {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
    });
    writePointer(repo, `${runA}\nbase=deadbeef\n`);

    const r = readOwRunCompleteness(repo);
    expect(r.runName).toBe('2026-01-01-a');
    expect(r.runSource).toBe('pointer');
  });

  it('pointer that is a directory is rejected', () => {
    const dir = path.join(repo, '.ai');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'run'), { recursive: true });

    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    expect(r.reasons[0]).toContain('could not be read as a file');
    expect(r.runSource).toBe('pointer');
  });

  it('pointer content with CRLF and BOM resolves', () => {
    const runA = makeRun('2026-01-01-a', {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
    });
    writePointer(repo, `﻿${runA}\r\n`);

    const r = readOwRunCompleteness(repo);
    expect(r.runName).toBe('2026-01-01-a');
    expect(r.runSource).toBe('pointer');
  });

  it('missing pointer falls back to the newest-run scan', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
    });

    const r = readOwRunCompleteness(repo);
    expect(r.runName).toBe('2026-06-22-run');
    expect(r.complete).toBe(true);
    expect(r.runSource).toBe('scan');
  });

  it('dangling pointer blocks with a distinct reason', () => {
    writePointer(repo, path.join(repo, '.ai', 'runs', '2026-09-09-missing'));
    // A valid, complete newest run under .ai/runs/ — must NOT be used as a fallback.
    makeRun('2026-08-08-real', {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
    });

    const r = readOwRunCompleteness(repo);
    expect(r.enforced).toBe(true);
    expect(r.complete).toBe(false);
    expect(r.runName).toBeNull();
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toMatch(/^run pointer '.*\/\.ai\/run' does not resolve: target '.*' does not exist/);
  });

  it('pointer with a relative path is rejected', () => {
    writePointer(repo, '.ai/runs/2026-01-01-a');
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    expect(r.reasons[0]).toContain('relative');
  });

  it('empty pointer file is rejected', () => {
    writePointer(repo, '');
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    expect(r.reasons[0]).toContain('is empty');
  });

  it('pointer to a non-dated directory is rejected', () => {
    const target = path.join(repo, 'not-a-run-dir');
    fs.mkdirSync(target, { recursive: true });
    writePointer(repo, target);
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    expect(r.reasons[0]).toContain('is not a dated run directory');
  });

  it('pointer target that is a file is rejected', () => {
    const target = path.join(repo, 'a-file.txt');
    fs.writeFileSync(target, 'not a directory', 'utf8');
    writePointer(repo, target);
    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    expect(r.reasons[0]).toContain('is not a directory');
  });

  it('symlinked pointer target resolves to the real run directory', () => {
    const runA = makeRun('2026-01-01-a', {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
    });
    const link = path.join(repo, '2026-05-05-link');
    fs.symlinkSync(runA, link, 'dir');
    writePointer(repo, link);

    const r = readOwRunCompleteness(repo);
    expect(r.runName).toBe('2026-01-01-a');
    expect(r.runSource).toBe('pointer');
  });

  it('symlinked pointer target whose real basename is not dated is rejected', () => {
    const realDir = path.join(repo, 'not-dated-dir');
    fs.mkdirSync(realDir, { recursive: true });
    const link = path.join(repo, '2026-05-05-link');
    fs.symlinkSync(realDir, link, 'dir');
    writePointer(repo, link);

    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    expect(r.reasons[0]).toContain('is not a dated run directory');
  });

  it('dangling .git symlink still marks the worktree root', () => {
    fs.symlinkSync('/nonexistent-target', path.join(repo, '.git'));
    const runA = makeRun('2026-01-01-a', {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
    });
    writePointer(repo, runA);
    const subdir = path.join(repo, 'packages', 'x');
    fs.mkdirSync(subdir, { recursive: true });

    const r = readOwRunCompleteness(subdir);
    expect(r.runName).toBe('2026-01-01-a');
    expect(r.runSource).toBe('pointer');
  });

  it('pointer is found from a subdirectory of the worktree', () => {
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    const runA = makeRun('2026-01-01-a', {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
    });
    writePointer(repo, runA);
    const subdir = path.join(repo, 'packages', 'x');
    fs.mkdirSync(subdir, { recursive: true });

    const r = readOwRunCompleteness(subdir);
    expect(r.runName).toBe('2026-01-01-a');
    expect(r.runSource).toBe('pointer');
  });

  it('without any .git entry the repoPath itself is the worktree root', () => {
    const runA = makeRun('2026-01-01-a', {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
    });
    writePointer(repo, runA);

    const r = readOwRunCompleteness(repo);
    expect(r.runName).toBe('2026-01-01-a');
    expect(r.runSource).toBe('pointer');
  });

  it('keyed run-base selected by repo basename', () => {
    const root = namedRoot('alpha');
    const goal = [
      '# Goal',
      '<!-- solution-acceptance: run-base[alpha] = aaaaaaa -->',
      '<!-- solution-acceptance: run-base = bbbbbbb -->',
      '',
    ].join('\n');
    makeRunAt(path.join(root, '.ai', 'runs', '2026-01-01-a'), {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(root);
    expect(r.runBase).toBe('aaaaaaa');
    expect(r.runBaseKind).toBe('sha');
  });

  it('unkeyed run-base used when no keyed marker matches', () => {
    const root = namedRoot('alpha');
    const goal = [
      '# Goal',
      '<!-- solution-acceptance: run-base[other] = ccccccc -->',
      '<!-- solution-acceptance: run-base = bbbbbbb -->',
      '',
    ].join('\n');
    makeRunAt(path.join(root, '.ai', 'runs', '2026-01-01-a'), {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(root);
    expect(r.runBase).toBe('bbbbbbb');
  });

  it('keyed TODO marker resolves to null without falling back to the unkeyed marker', () => {
    const root = namedRoot('alpha');
    const goal = [
      '# Goal',
      '<!-- solution-acceptance: run-base[alpha] = TODO -->',
      '<!-- solution-acceptance: run-base = bbbbbbb -->',
      '',
    ].join('\n');
    makeRunAt(path.join(root, '.ai', 'runs', '2026-01-01-a'), {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(root);
    expect(r.runBase).toBeNull();
    expect(r.runBaseKind).toBe('todo');
  });

  it('keyed markers for other repos only block with an explicit reason', () => {
    const goal = [
      '# Goal',
      '<!-- solution-acceptance: run-base[other] = ccccccc -->',
      '',
    ].join('\n');
    makeRun('2026-01-01-a', {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    expect(r.runBase).toBeNull();
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toMatch(/^run-base markers in 00-goal\.md are keyed \(keys: other\)/);
    expect(r.reasons[0]).toContain('no unkeyed run-base marker');
    expect(r.runBaseKind).toBe('unmatched-keyed');
  });

  it('key match is case-insensitive', () => {
    const root = namedRoot('Alpha');
    const goal = [
      '# Goal',
      '<!-- solution-acceptance: run-base[alpha] = aaaaaaa -->',
      '<!-- solution-acceptance: run-base = bbbbbbb -->',
      '',
    ].join('\n');
    makeRunAt(path.join(root, '.ai', 'runs', '2026-01-01-a'), {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(root);
    expect(r.runBase).toBe('aaaaaaa');
  });

  it('duplicate keyed marker: first occurrence wins', () => {
    const root = namedRoot('alpha');
    const goal = [
      '# Goal',
      '<!-- solution-acceptance: run-base[alpha] = aaaaaaa -->',
      '<!-- solution-acceptance: run-base[alpha] = zzzzzzz -->',
      '',
    ].join('\n');
    makeRunAt(path.join(root, '.ai', 'runs', '2026-01-01-a'), {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(root);
    expect(r.runBase).toBe('aaaaaaa');
  });

  it('a prose line quoting a concrete keyed marker inside a single backtick span is exempt (D-027 quotation)', () => {
    // The quoted key is deliberately the ROOT BASENAME itself and the quoted
    // value a concrete sha: an un-anchored strict grammar would match
    // mid-line and wrongly select 'aaaaaaa' instead of falling through to the
    // unkeyed marker. A placeholder-shaped key would not discriminate here —
    // the placeholder filter would drop it either way. That SELECTION
    // behavior is unaffected either way: the quoting line still isn't a
    // marker, so 'bbbbbbb' still wins. Round 1 additionally blocked the
    // quoting line as an attempted marker embedded in prose. Round 2's D-027
    // (review finding 2, measured against the real corpus: this exact
    // pattern self-blocked two real run directories that only ever quoted
    // the marker syntax) narrows that: the whole phrase here sits INSIDE one
    // backtick pair that opens and closes on this same line, so it reads as
    // a quotation, not an attempted marker, and does not block.
    const root = namedRoot('alpha');
    const goal = [
      '# Goal',
      '<!-- solution-acceptance: run-base = bbbbbbb -->',
      'Use `<!-- solution-acceptance: run-base[alpha] = aaaaaaa -->` per repo.',
      '',
    ].join('\n');
    makeRunAt(path.join(root, '.ai', 'runs', '2026-01-01-a'), {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(root);
    expect(r.runBase).toBe('bbbbbbb');
    expect(r.runBaseKind).toBe('sha');
    expect(r.complete).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('the same quoted marker also naming both tokens again OUTSIDE the backticks still blocks (negative control)', () => {
    // Negative control for D-027 (review finding 2): a code span on the line
    // does not blanket-exempt the whole line — only the phrase occurrence
    // that is actually inside it. A second, unquoted mention of both tokens
    // on the same line still trips the phrase check.
    const root = namedRoot('alpha');
    const goal = [
      '# Goal',
      '<!-- solution-acceptance: run-base = bbbbbbb -->',
      'The `run-base` marker uses solution-acceptance run-base syntax, see below.',
      '',
    ].join('\n');
    makeRunAt(path.join(root, '.ai', 'runs', '2026-01-01-a'), {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(root);
    expect(r.runBase).toBe('bbbbbbb');
    expect(r.complete).toBe(false);
    expect(
      r.reasons.some((x) => x.startsWith('run-base marker mention(s) in 00-goal.md are not well-formed:')),
    ).toBe(true);
  });

  it('a pure prose sentence naming both marker tokens blocks as malformed (phrase in prose, no other marker)', () => {
    // Cleanest form of the "phrase in prose" variant: no comment syntax at
    // all, no other marker present, just a sentence that happens to name
    // both tokens. Before the fail-closed phrase check this read as
    // markerless (runBaseKind 'absent', complete true) and fell through to
    // the legacy date heuristic.
    const goal = [
      '# Goal',
      'The solution-acceptance run-base binding for this run is still TBD.',
      '',
    ].join('\n');
    makeRun('2026-01-01-a', {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(repo);
    expect(r.runBaseKind).toBe('malformed');
    expect(r.runBase).toBeNull();
    expect(r.complete).toBe(false);
    // Phrase-only hit (review finding 5): no `run-base[` bracket syntax was
    // ever attempted, so this must NOT get the keyed-marker-shape hint —
    // that hint names a fix ('run-base[<key>] = <sha>') this line never
    // tried and would mislead an operator.
    expect(
      r.reasons.some((x) => x.startsWith('run-base marker mention(s) in 00-goal.md are not well-formed:')),
    ).toBe(true);
    expect(r.reasons.some((x) => x.startsWith('malformed keyed run-base marker(s)'))).toBe(false);
    expect(
      r.reasons.some((x) =>
        x.includes(
          "line 2 names the run-base marker tokens but is not a well-formed marker: The solution-acceptance run-base binding for this run is still TBD.",
        ),
      ),
    ).toBe(true);
  });

  it('placeholder-shaped keyed marker on its own line is ignored', () => {
    const goal = [
      '# Goal',
      '<!-- solution-acceptance: run-base[<repo-basename>] = <sha> -->',
      '<!-- solution-acceptance: run-base = bbbbbbb -->',
      '',
    ].join('\n');
    makeRun('2026-01-01-a', {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(repo);
    expect(r.runBase).toBe('bbbbbbb');
    expect(r.complete).toBe(true);
  });

  it('placeholder-only keyed marker with no unkeyed marker reads as markerless', () => {
    // No unkeyed marker to fall back on, so the placeholder filter is the
    // ONLY thing standing between this goal file and an 'unmatched-keyed'
    // blocker: the documentation example must not count as a present key.
    const goal = [
      '# Goal',
      '<!-- solution-acceptance: run-base[<repo-basename>] = <sha> -->',
      '',
    ].join('\n');
    makeRun('2026-01-01-a', {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(repo);
    expect(r.runBaseKind).toBe('absent');
    expect(r.runBase).toBeNull();
    expect(r.reasons).toEqual([]);
    expect(r.complete).toBe(true);
  });

  it('near-miss keyed syntax with a space before the bracket is a malformed blocker', () => {
    const goal = ['# Goal', '<!-- solution-acceptance: run-base [alpha] = aaaaaaa -->', ''].join(
      '\n',
    );
    makeRun('2026-01-01-a', {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    expect(r.runBaseKind).toBe('malformed');
    expect(
      r.reasons.some((x) => x.startsWith('malformed keyed run-base marker(s) in 00-goal.md:')),
    ).toBe(true);
  });

  it('near-miss keyed syntax with a missing closing bracket is a malformed blocker', () => {
    const goal = ['# Goal', '<!-- solution-acceptance: run-base[alpha = aaaaaaa -->', ''].join(
      '\n',
    );
    makeRun('2026-01-01-a', {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    expect(r.runBaseKind).toBe('malformed');
    expect(
      r.reasons.some((x) => x.startsWith('malformed keyed run-base marker(s) in 00-goal.md:')),
    ).toBe(true);
  });

  it('keyed marker with an empty value is a malformed blocker', () => {
    const goal = [
      '# Goal',
      '<!-- solution-acceptance: run-base[alpha] = -->',
      '<!-- solution-acceptance: run-base[other] = ccccccc -->',
      '',
    ].join('\n');
    makeRun('2026-01-01-a', {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    expect(r.runBaseKind).toBe('malformed');
    expect(r.runBase).toBeNull();
    expect(r.runBase).not.toBe('<!--');
  });

  it('keyed marker whose value is the comment terminator is malformed', () => {
    // The key matches the root basename, so without the strict grammar's
    // `(?!-->)` value guard the `\S+` capture would swallow the FIRST `-->`
    // as a bogus value and this would resolve to runBase '-->'.
    const root = namedRoot('alpha');
    const goal = ['# Goal', '<!-- solution-acceptance: run-base[alpha] = --> -->', ''].join('\n');
    makeRunAt(path.join(root, '.ai', 'runs', '2026-01-01-a'), {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(root);
    expect(r.runBaseKind).toBe('malformed');
    expect(r.runBase).toBeNull();
    expect(r.complete).toBe(false);
  });

  it('uppercase field name in a keyed marker line is malformed', () => {
    // The strict grammar stays exact (lowercase), but the LOOSE net is
    // case-insensitive, so a recognisable attempt blocks instead of falling
    // through to the legacy date heuristic.
    const root = namedRoot('alpha');
    const goal = ['# Goal', '<!-- solution-acceptance: RUN-BASE[alpha] = aaaaaaa -->', ''].join(
      '\n',
    );
    makeRunAt(path.join(root, '.ai', 'runs', '2026-01-01-a'), {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(root);
    expect(r.runBaseKind).toBe('malformed');
    expect(r.runBase).toBeNull();
    expect(r.complete).toBe(false);
    expect(
      r.reasons.some((x) => x.startsWith('malformed keyed run-base marker(s) in 00-goal.md:')),
    ).toBe(true);
  });

  it('whitespace before the colon in a keyed marker line is malformed', () => {
    const root = namedRoot('alpha');
    const goal = ['# Goal', '<!-- solution-acceptance : run-base[alpha] = aaaaaaa -->', ''].join(
      '\n',
    );
    makeRunAt(path.join(root, '.ai', 'runs', '2026-01-01-a'), {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(root);
    expect(r.runBaseKind).toBe('malformed');
    expect(r.runBase).toBeNull();
    expect(r.complete).toBe(false);
  });

  it('extra dashes in the comment opener of a keyed marker line are malformed', () => {
    const root = namedRoot('alpha');
    const goal = ['# Goal', '<!--- solution-acceptance: run-base[alpha] = aaaaaaa -->', ''].join(
      '\n',
    );
    makeRunAt(path.join(root, '.ai', 'runs', '2026-01-01-a'), {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(root);
    expect(r.runBaseKind).toBe('malformed');
    expect(r.runBase).toBeNull();
    expect(r.complete).toBe(false);
  });

  it('keyed marker line without the colon blocks as malformed (fail-closed follow-up)', () => {
    // This is the exact residual the loose net left standing (review round
    // 4): the loose net requires the literal colon, so a colon-less attempt
    // was markerless (fail-open, legacy heuristic). The follow-up phrase
    // check closes it: the line still names both marker tokens, so it now
    // blocks instead of falling through. It is caught by the phrase net, not
    // the keyed loose net (which requires the literal colon), so it gets the
    // phrase-only reason (review finding 5), not the keyed-shape hint.
    const root = namedRoot('alpha');
    const goal = ['# Goal', '<!-- solution-acceptance run-base[alpha] = aaaaaaa -->', ''].join(
      '\n',
    );
    makeRunAt(path.join(root, '.ai', 'runs', '2026-01-01-a'), {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(root);
    expect(r.runBaseKind).toBe('malformed');
    expect(r.runBase).toBeNull();
    expect(r.complete).toBe(false);
    expect(
      r.reasons.some((x) => x.startsWith('run-base marker mention(s) in 00-goal.md are not well-formed:')),
    ).toBe(true);
  });

  it('placeholder example with a tolerated deviation blocks as malformed', () => {
    // The placeholder skip applies to STRICT matches only: an example line
    // that deviates from the strict shape is an attempt like any other.
    const root = namedRoot('alpha');
    const goal = [
      '# Goal',
      '<!-- Solution-Acceptance: run-base[<repo-basename>] = <sha> -->',
      '',
    ].join('\n');
    makeRunAt(path.join(root, '.ai', 'runs', '2026-01-01-a'), {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(root);
    expect(r.runBaseKind).toBe('malformed');
    expect(r.runBase).toBeNull();
    expect(r.complete).toBe(false);
  });

  it('a malformed line beside a well-formed matching keyed marker keeps the value but still blocks', () => {
    const root = namedRoot('alpha');
    const goal = [
      '# Goal',
      '<!-- solution-acceptance: run-base[alpha] = aaaaaaa -->',
      '<!-- solution-acceptance: run-base [other] = zzzzzzz -->',
      '',
    ].join('\n');
    makeRunAt(path.join(root, '.ai', 'runs', '2026-01-01-a'), {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(root);
    expect(r.runBase).toBe('aaaaaaa');
    expect(r.runBaseKind).toBe('sha');
    expect(r.complete).toBe(false);
    expect(
      r.reasons.some((x) => x.startsWith('malformed keyed run-base marker(s) in 00-goal.md:')),
    ).toBe(true);
  });

  it('keyed marker not starting its line is ignored for selection, but blocks as malformed (leading text)', () => {
    // Root basename 'alpha' matches the embedded marker's key, so an
    // un-anchored implementation that let the match start mid-line would
    // wrongly select 'aaaaaaa' instead of falling through to the unkeyed
    // marker. That SELECTION behavior is unchanged. But the "note " prefix
    // means this line names both marker tokens without being a well-formed
    // marker, so it now ALSO blocks as an attempted marker with leading
    // text. Caught by the phrase net (the keyed loose net is anchored at
    // the line start and "note " breaks that anchor), so it gets the
    // phrase-only reason (review finding 5), not the keyed-shape hint.
    const root = namedRoot('alpha');
    const goal = [
      '# Goal',
      'note <!-- solution-acceptance: run-base[alpha] = aaaaaaa -->',
      '<!-- solution-acceptance: run-base = bbbbbbb -->',
      '',
    ].join('\n');
    makeRunAt(path.join(root, '.ai', 'runs', '2026-01-01-a'), {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(root);
    expect(r.runBase).toBe('bbbbbbb');
    expect(r.runBaseKind).toBe('sha');
    expect(r.complete).toBe(false);
    expect(
      r.reasons.some((x) => x.startsWith('run-base marker mention(s) in 00-goal.md are not well-formed:')),
    ).toBe(true);
  });

  it('a keyed attempt with leading text and no other marker blocks as malformed', () => {
    // Same variant as above, but with no unkeyed marker to fall back on: the
    // run must resolve to no run-base at all, blocked as malformed.
    const root = namedRoot('alpha');
    const goal = ['# Goal', 'note <!-- solution-acceptance: run-base[alpha] = aaaaaaa -->', ''].join(
      '\n',
    );
    makeRunAt(path.join(root, '.ai', 'runs', '2026-01-01-a'), {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(root);
    expect(r.runBaseKind).toBe('malformed');
    expect(r.runBase).toBeNull();
    expect(r.complete).toBe(false);
  });

  it('keyed marker in a list bullet blocks as malformed (bullet-wrapped keyed marker)', () => {
    // Both nets used to be anchored at the line start, so a keyed marker
    // behind a list bullet was neither well-formed nor malformed and the run
    // read as markerless (fail-open). The fail-closed phrase check closes
    // this: the line still names both marker tokens, so it blocks instead.
    // Caught by the phrase net (the bullet breaks the keyed loose net's
    // line-start anchor), so it gets the phrase-only reason (review finding
    // 5), not the keyed-shape hint.
    const root = namedRoot('alpha');
    const goal = ['# Goal', '- <!-- solution-acceptance: run-base[alpha] = aaaaaaa -->', ''].join(
      '\n',
    );
    makeRunAt(path.join(root, '.ai', 'runs', '2026-01-01-a'), {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(root);
    expect(r.runBaseKind).toBe('malformed');
    expect(r.runBase).toBeNull();
    expect(r.complete).toBe(false);
    expect(
      r.reasons.some((x) => x.startsWith('run-base marker mention(s) in 00-goal.md are not well-formed:')),
    ).toBe(true);
  });

  it('a bare marker attempt naming solution-acceptance without the comment wrapper blocks as malformed', () => {
    // "A marker without the comment wrapper" variant: a real attempt still
    // names the 'solution-acceptance' field, it just dropped the `<!-- -->`
    // HTML-comment delimiters. That names both marker tokens, so it blocks.
    const root = namedRoot('alpha');
    const goal = ['# Goal', 'solution-acceptance: run-base[alpha] = aaaaaaa', ''].join('\n');
    makeRunAt(path.join(root, '.ai', 'runs', '2026-01-01-a'), {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(root);
    expect(r.runBaseKind).toBe('malformed');
    expect(r.runBase).toBeNull();
    expect(r.complete).toBe(false);
  });

  it('a bare mention of run-base alone (no solution-acceptance token) stays markerless', () => {
    // Boundary of the phrase check: detection requires BOTH exact tokens.
    // A line mentioning only 'run-base' (no 'solution-acceptance' anywhere)
    // does not carry the marker phrase, so it is not an attempted marker at
    // all and the run stays markerless (legacy date-heuristic fallthrough).
    const root = namedRoot('alpha');
    const goal = ['# Goal', 'run-base[alpha] = aaaaaaa', ''].join('\n');
    makeRunAt(path.join(root, '.ai', 'runs', '2026-01-01-a'), {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(root);
    expect(r.runBaseKind).toBe('absent');
    expect(r.runBase).toBeNull();
    expect(r.reasons).toEqual([]);
    expect(r.complete).toBe(true);
  });

  it('a well-formed unkeyed run-base marker is exempt from the phrase check', () => {
    // The canonical unkeyed marker line itself names both marker tokens
    // ('solution-acceptance' and 'run-base'). It must stay a legitimate,
    // well-formed marker, not be misread as an attempted-but-broken keyed
    // one merely for naming both tokens.
    const goal = ['# Goal', '<!-- solution-acceptance: run-base = bbbbbbb -->', ''].join('\n');
    makeRun('2026-01-01-a', {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(repo);
    expect(r.runBase).toBe('bbbbbbb');
    expect(r.runBaseKind).toBe('sha');
    expect(r.complete).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('the pandora multi-repo unkeyed convention line, byte-exact, is exempt and the keyed marker for this repo wins (review finding 1)', () => {
    // Byte-exact line from the real pandora run corpus (batch 33/34/35/etc):
    // this ends its value at the first whitespace ('multi-repo;'), so the
    // legacy unkeyed matcher DOES read a value from it — the earlier
    // whole-line-only exemption shape did not recognise this as an unkeyed
    // marker line and reported it malformed even though a value resolved.
    const root = namedRoot('agent-dx');
    const goal = [
      '# Goal',
      '<!-- solution-acceptance: run-base = multi-repo; see keyed markers below -->',
      '<!-- solution-acceptance: run-base[harness] = 50b60f5355aa39e744af48e22b1ef987ec277163 -->',
      '<!-- solution-acceptance: run-base[agent-dx] = 672932fa9c50f412a57b1e3372caa4719769b18b -->',
      '<!-- solution-acceptance: run-base[agent-tasks] = efcabd2ab1e6341f0e49cb02d39f6ed02c456f3b -->',
      '',
    ].join('\n');
    makeRunAt(path.join(root, '.ai', 'runs', '2026-01-01-a'), {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(root);
    expect(r.runBase).toBe('672932fa9c50f412a57b1e3372caa4719769b18b');
    expect(r.runBaseKind).toBe('sha');
    expect(r.complete).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('an unkeyed marker annotated with per-repo shas, byte-exact, is exempt (review finding 1)', () => {
    // Byte-exact line from the real pandora run corpus
    // (2026-08-23-home-widgets-plus-five): the value ends at the first
    // whitespace ('863800c'), with a parenthetical + more shas trailing on
    // the same, unclosed-looking line.
    const goal = [
      '# Goal',
      '<!-- solution-acceptance: run-base = 863800c (agent-tasks); harness 031f154; codebase-oracle 23bf28e; agent-preflight bcb23ff -->',
      '',
    ].join('\n');
    makeRun('2026-01-01-a', {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(repo);
    expect(r.runBase).toBe('863800c');
    expect(r.runBaseKind).toBe('sha');
    expect(r.complete).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  it('a phrase-carrying attempt inside a fenced code block is exempt (D-027 quotation, amends round 1)', () => {
    // Round 1's choice, "a fence is not an excuse for an unreadable marker",
    // is amended by round 2's D-027 (review finding 2): a fenced code block
    // reads as a quotation of the marker syntax, not an attempted marker, so
    // it no longer trips the phrase check. Nothing else in this goal file
    // resolves a run-base marker, so the run falls through to the ordinary
    // markerless path.
    const goal = [
      '# Goal',
      '```',
      '- <!-- solution-acceptance: run-base[alpha] = aaaaaaa -->',
      '```',
      '',
    ].join('\n');
    makeRun('2026-01-01-a', {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(repo);
    expect(r.runBaseKind).toBe('absent');
    expect(r.runBase).toBeNull();
    expect(r.reasons).toEqual([]);
    expect(r.complete).toBe(true);
  });

  it('a phrase-carrying line OUTSIDE a fence, adjacent to one, still blocks (negative control)', () => {
    // The fence exemption is scoped to lines actually between the fence
    // delimiters. A phrase-carrying line just outside the fence is unaffected.
    const goal = [
      '# Goal',
      '- <!-- solution-acceptance: run-base[alpha] = aaaaaaa -->',
      '```',
      'plain code, no marker mentions here',
      '```',
      '',
    ].join('\n');
    makeRun('2026-01-01-a', {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(repo);
    expect(r.runBaseKind).toBe('malformed');
    expect(r.runBase).toBeNull();
    expect(r.complete).toBe(false);
    expect(
      r.reasons.some((x) => x.startsWith('run-base marker mention(s) in 00-goal.md are not well-formed:')),
    ).toBe(true);
  });

  it('the malformed reason pins the exact "line N: <excerpt>" text, with the marker off line 1 (review finding 3)', () => {
    // Before this test, dropping the 'line N: ' prefix (or an off-by-one in
    // the line number) left 94/94 green — nothing pinned the prefix or the
    // exact line number. The marker is deliberately on line 5 (not line 1),
    // so a 0-based/1-based mixup fails this assertion.
    const goal = [
      '# Goal',
      '',
      '## Section',
      '',
      '- <!-- solution-acceptance: run-base[alpha] = aaaaaaa -->',
      '',
    ].join('\n');
    makeRun('2026-01-01-a', {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(repo);
    expect(r.runBaseKind).toBe('malformed');
    expect(
      r.reasons.some((x) =>
        x.includes(
          'line 5 names the run-base marker tokens but is not a well-formed marker: - <!-- solution-acceptance: run-base[alpha] = aaaaaaa -->',
        ),
      ),
    ).toBe(true);
  });

  it('the keyed-attempt excerpt gets its full character budget, not eaten by the "line N: " prefix (review finding 6)', () => {
    // Before this fix, boundedList truncated the ALREADY-PREFIXED string to
    // 80 chars, so the prefix ('line 3: ') ate into the excerpt's own
    // budget and the excerpt itself was cut 8 characters short of 80.
    const root = namedRoot('alpha');
    const longKey = 'k'.repeat(120);
    const goal = [
      '# Goal',
      '',
      `<!-- solution-acceptance: run-base[${longKey}] = aaaaaaa`,
      '',
    ].join('\n');
    makeRunAt(path.join(root, '.ai', 'runs', '2026-01-01-a'), {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(root);
    expect(r.runBaseKind).toBe('malformed');
    const reason = r.reasons.find((x) => x.startsWith('malformed keyed run-base marker(s)'));
    expect(reason).toBeDefined();
    const line3 = `<!-- solution-acceptance: run-base[${longKey}] = aaaaaaa`.trim();
    const expectedExcerpt = line3.slice(0, 80);
    expect(expectedExcerpt.length).toBe(80); // sanity: the excerpt is long enough to actually get truncated
    expect(reason).toContain(`line 3: ${expectedExcerpt}`);
  });

  it('blocker messages are bounded for long and many keys', () => {
    const lines = ['# Goal'];
    for (let i = 0; i < 25; i++) {
      const key = `other-repo-${i}-` + 'x'.repeat(190);
      lines.push(`<!-- solution-acceptance: run-base[${key}] = aaaaaaa -->`);
    }
    lines.push('');
    const goal = lines.join('\n');
    makeRun('2026-01-01-a', {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });

    const r = readOwRunCompleteness(repo);
    expect(r.complete).toBe(false);
    expect(r.runBaseKind).toBe('unmatched-keyed');
    const reason = r.reasons.find((x) => x.startsWith('run-base markers in 00-goal.md are keyed'));
    expect(reason).toBeDefined();
    expect(reason!.length).toBeLessThan(1500);
    expect(reason).toContain('(+15 more)');
  });

  /** Build a fake linked-worktree layout: <ext>/main and <ext>/wt1. */
  function makeLinkedWorktree(withCommondir: boolean): { mainRoot: string; wt1Root: string } {
    const ext = externalTmpDir();
    const mainRoot = path.join(ext, 'main');
    const wt1Root = path.join(ext, 'wt1');
    const wt1Gitdir = path.join(mainRoot, '.git', 'worktrees', 'wt1');
    fs.mkdirSync(wt1Gitdir, { recursive: true });
    if (withCommondir) {
      fs.writeFileSync(path.join(wt1Gitdir, 'commondir'), '../..', 'utf8');
    }
    fs.mkdirSync(wt1Root, { recursive: true });
    fs.writeFileSync(path.join(wt1Root, '.git'), `gitdir: ${wt1Gitdir}\n`, 'utf8');
    return { mainRoot, wt1Root };
  }

  it('linked worktree selects the main repository basename key', () => {
    const { wt1Root } = makeLinkedWorktree(true);
    const goal = [
      '# Goal',
      '<!-- solution-acceptance: run-base[main] = ddddddd -->',
      '<!-- solution-acceptance: run-base = bbbbbbb -->',
      '',
    ].join('\n');
    const runDir = path.join(wt1Root, '.ai', 'runs', '2026-01-01-a');
    makeRunAt(runDir, {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });
    writePointer(wt1Root, runDir);

    const r = readOwRunCompleteness(wt1Root);
    expect(r.runBase).toBe('ddddddd');
  });

  it('linked worktree prefers the worktree basename key over the main repository key', () => {
    const { wt1Root } = makeLinkedWorktree(true);
    const goal = [
      '# Goal',
      '<!-- solution-acceptance: run-base[wt1] = eeeeeee -->',
      '<!-- solution-acceptance: run-base[main] = ddddddd -->',
      '',
    ].join('\n');
    const runDir = path.join(wt1Root, '.ai', 'runs', '2026-01-01-a');
    makeRunAt(runDir, {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });
    writePointer(wt1Root, runDir);

    const r = readOwRunCompleteness(wt1Root);
    expect(r.runBase).toBe('eeeeeee');
  });

  it('linked worktree without commondir derives the main repository from the gitdir path', () => {
    const { wt1Root } = makeLinkedWorktree(false);
    const goal = [
      '# Goal',
      '<!-- solution-acceptance: run-base[main] = ddddddd -->',
      '<!-- solution-acceptance: run-base = bbbbbbb -->',
      '',
    ].join('\n');
    const runDir = path.join(wt1Root, '.ai', 'runs', '2026-01-01-a');
    makeRunAt(runDir, {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });
    writePointer(wt1Root, runDir);

    const r = readOwRunCompleteness(wt1Root);
    expect(r.runBase).toBe('ddddddd');
  });

  it('commondir not ending in .git falls through to the gitdir-path fallback', () => {
    const ext = externalTmpDir();
    const mainRoot = path.join(ext, 'main');
    const wt1Root = path.join(ext, 'wt1');
    const wt1Gitdir = path.join(mainRoot, '.git', 'worktrees', 'wt1');
    fs.mkdirSync(wt1Gitdir, { recursive: true });
    // Present, but resolves to a basename that is NOT `.git` — must fall
    // through to the gitdir-path fallback instead of giving up (F6).
    fs.writeFileSync(path.join(wt1Gitdir, 'commondir'), 'not-a-git-dir', 'utf8');
    fs.mkdirSync(wt1Root, { recursive: true });
    fs.writeFileSync(path.join(wt1Root, '.git'), `gitdir: ${wt1Gitdir}\n`, 'utf8');

    const goal = [
      '# Goal',
      '<!-- solution-acceptance: run-base[main] = ddddddd -->',
      '<!-- solution-acceptance: run-base = bbbbbbb -->',
      '',
    ].join('\n');
    const runDir = path.join(wt1Root, '.ai', 'runs', '2026-01-01-a');
    makeRunAt(runDir, {
      handoff: handoffMarker('accepted'),
      review: reviewDocNoFindings({ recommendationMarker: 'accept' }),
      goal,
    });
    writePointer(wt1Root, runDir);

    const r = readOwRunCompleteness(wt1Root);
    expect(r.runBase).toBe('ddddddd');
  });
});

/**
 * Reciprocal pinning test: this package's `OW_FINDINGS_PLACEHOLDER_ROW` must
 * stay byte-identical to the placeholder row shipped in agent-dx's
 * packages/orchestrator-workflow/assets/templates/05-review-findings.md,
 * which agent-dx pins on its side in
 * packages/orchestrator-workflow/test/template-markers.test.ts ("carries the
 * exact placeholder row grounding-mcp's completeness reader matches
 * literally"). The two repos have no shared build step, so this is a
 * deliberate manual lockstep: if either literal changes, update both.
 */
describe('OW_FINDINGS_PLACEHOLDER_ROW — reciprocal template lockstep pin', () => {
  it('matches the known agent-dx 05-review-findings.md template placeholder row byte-exactly', () => {
    expect(OW_FINDINGS_PLACEHOLDER_ROW).toBe(
      '| low/medium/high/critical | correctness/architecture/security/tests/maintainability/performance/docs | <!-- finding --> | <!-- fix --> | accepted/defer |',
    );
  });
});
