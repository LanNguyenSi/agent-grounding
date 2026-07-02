// OW run-completeness reader.
//
// Each test builds a throwaway repo under os.tmpdir() with one or more
// `.ai/runs/<date-slug>/` dirs holding fixture handoff + review files, then
// asserts the pure reader's verdict. Fixtures are cleaned up in afterEach.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readOwRunCompleteness } from '../src/ow-run-completeness.js';

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

/** Review file with the shipped placeholder legend row plus any extra rows. */
function reviewDoc(opts: ReviewOpts = {}): string {
  const rows = [
    '| Severity | Category | Description | Suggested Fix | Decision |',
    '|---|---|---|---|---|',
    // The shipped template's legend / placeholder row — must be skipped.
    '| low/medium/high/critical | correctness/architecture/security | <!-- finding --> | <!-- fix --> | accepted/fix/defer/reject |',
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

describe('readOwRunCompleteness — enforcement', () => {
  it('reports enforced:false when there is no .ai/runs/ directory', () => {
    const r = readOwRunCompleteness(repo);
    expect(r).toEqual({
      enforced: false,
      complete: false,
      reasons: ['no .ai/runs/ run directory found'],
      runName: null,
      runBase: null,
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
      review: reviewDoc({ recommendationMarker: 'accept' }),
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
      review: reviewDoc({ recommendationMarker: 'accept' }),
    });
    const r = readOwRunCompleteness(repo);
    expect(r).toEqual({
      enforced: true,
      complete: true,
      reasons: [],
      runName: '2026-06-22-run',
      runBase: null,
    });
  });

  it('accepted_with_notes + accept_with_notes also count as accepted', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted_with_notes'),
      review: reviewDoc({ recommendationMarker: 'accept_with_notes' }),
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
      review: reviewDoc({ recommendationMarker: 'accept' }),
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
  });

  it('returns runBase null when 00-goal.md is missing (legacy run)', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted'),
      review: reviewDoc({ recommendationMarker: 'accept' }),
    });
    const r = readOwRunCompleteness(repo);
    expect(r.runName).toBe('2026-06-22-run');
    expect(r.runBase).toBeNull();
  });

  it('returns runBase null when 00-goal.md has no run-base marker', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted'),
      review: reviewDoc({ recommendationMarker: 'accept' }),
      goal: '# Goal\n\n## Goal\n\nsome goal text\n',
    });
    expect(readOwRunCompleteness(repo).runBase).toBeNull();
  });

  it('treats a TODO run-base placeholder as absent', () => {
    makeRun('2026-06-22-run', {
      handoff: handoffMarker('accepted'),
      review: reviewDoc({ recommendationMarker: 'accept' }),
      goal: goalWithMarker('TODO'),
    });
    expect(readOwRunCompleteness(repo).runBase).toBeNull();
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
});
