// OW run-to-change binding (owBlockersFor, binding arm).
//
// Unit tests for the staleness fail-open fix: a complete OW run must CLAIM
// the current change. Marker path (run-base sha in 00-goal.md) and legacy
// date-heuristic path are pinned in both fail directions. Fixtures build
// throwaway git repos — the fork-point cases clone from a local upstream so
// origin/HEAD resolves exactly like a real checkout.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { owBlockersFor } from '../src/solution-verdict.js';

const IDENT = {
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 't@t.local',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 't@t.local',
};

function git(cwd: string, args: string[], dateIso?: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env, ...IDENT };
  if (dateIso !== undefined) {
    env.GIT_AUTHOR_DATE = dateIso;
    env.GIT_COMMITTER_DATE = dateIso;
  }
  return execFileSync('git', args, { cwd, env }).toString().trim();
}

/** Commit a file change; optional fixed author/committer date (ISO). */
function commit(cwd: string, file: string, content: string, dateIso?: string): string {
  fs.writeFileSync(path.join(cwd, file), content, 'utf8');
  git(cwd, ['add', '-A']);
  git(cwd, ['commit', '-q', '-m', `add ${file}`], dateIso);
  return git(cwd, ['rev-parse', 'HEAD']);
}

/** `YYYY-MM-DD` author date of HEAD, in the commit's own timezone. */
function headAuthorDate(cwd: string): string {
  return git(cwd, ['log', '-1', '--format=%ad', '--date=format:%Y-%m-%d']);
}

interface RunOpts {
  /** run-base marker value written into 00-goal.md; omitted → legacy run. */
  runBase?: string;
  /** handoff final-status (default accepted → complete run). */
  finalStatus?: string;
}

/** A process-complete (by default) OW run dir with optional run-base marker. */
function makeRun(repo: string, runName: string, opts: RunOpts = {}): void {
  const dir = path.join(repo, '.ai', 'runs', runName);
  fs.mkdirSync(dir, { recursive: true });
  const finalStatus = opts.finalStatus ?? 'accepted';
  fs.writeFileSync(
    path.join(dir, '06-handoff.md'),
    [
      '# Operator Handoff',
      '',
      '## Final Status',
      '',
      `<!-- solution-acceptance: final-status = ${finalStatus} -->`,
      finalStatus,
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, '05-review-findings.md'),
    [
      '# Review Findings',
      '',
      '## Findings',
      '',
      '| Severity | Category | Description | Suggested Fix | Decision |',
      '|---|---|---|---|---|',
      '| low/medium/high/critical | correctness | <!-- finding --> | <!-- fix --> | accepted/fix/defer/reject |',
      '',
      '## Acceptance Recommendation',
      '',
      '<!-- solution-acceptance: acceptance-recommendation = accept -->',
      'accept',
      '',
    ].join('\n'),
    'utf8',
  );
  if (opts.runBase !== undefined) {
    fs.writeFileSync(
      path.join(dir, '00-goal.md'),
      ['# Goal', '', `<!-- solution-acceptance: run-base = ${opts.runBase} -->`, ''].join('\n'),
      'utf8',
    );
  }
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-run-binding-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Plain local repo (no remote) with one commit. */
function makeLocalRepo(): { repo: string; head: string } {
  const repo = path.join(tmp, 'local');
  fs.mkdirSync(repo);
  git(repo, ['init', '-q', '-b', 'master']);
  const head = commit(repo, 'a.txt', 'a');
  return { repo, head };
}

/**
 * Upstream master with commits O → M, cloned to a working repo (so
 * origin/HEAD and refs/remotes/origin/master resolve), plus a feature branch
 * carrying one change commit W. Fork point of the change is M.
 */
function makeClonedRepo(): { repo: string; o: string; m: string; w: string } {
  const upstream = path.join(tmp, 'upstream');
  fs.mkdirSync(upstream);
  git(upstream, ['init', '-q', '-b', 'master']);
  const o = commit(upstream, 'base.txt', 'base', '2026-06-01T10:00:00 +0000');
  const m = commit(upstream, 'main.txt', 'main', '2026-06-10T10:00:00 +0000');
  const repo = path.join(tmp, 'clone');
  git(tmp, ['clone', '-q', upstream, repo]);
  git(repo, ['checkout', '-q', '-b', 'feature']);
  const w = commit(repo, 'work.txt', 'work');
  return { repo, o, m, w };
}

describe('owBlockersFor — legacy date heuristic (no run-base marker)', () => {
  it('staleness repro: a complete run dated before the change commits blocks', async () => {
    const { repo } = makeLocalRepo();
    makeRun(repo, '2000-01-02-old-run');
    const blockers = await owBlockersFor(repo);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatch(/^orchestrator-workflow: /);
    expect(blockers[0]).toContain('no OW run claims this change');
    expect(blockers[0]).toContain('2000-01-02-old-run');
  });

  it('tolerant fail direction: a same-day legacy run passes (negative control)', async () => {
    const { repo } = makeLocalRepo();
    makeRun(repo, `${headAuthorDate(repo)}-fresh-run`);
    await expect(owBlockersFor(repo)).resolves.toEqual([]);
  });

  it('multi-day change: run dated at the FIRST change commit never false-blocks', async () => {
    const { repo } = makeClonedRepo();
    // Two change commits on the feature branch: one old, one now. The run was
    // created alongside the first one — the heuristic compares against the
    // OLDEST commit since the fork point, so the run still claims the change.
    git(repo, ['reset', '-q', '--hard', 'origin/master']);
    commit(repo, 'w1.txt', 'w1', '2026-06-11T09:00:00 +0000');
    commit(repo, 'w2.txt', 'w2');
    makeRun(repo, '2026-06-11-multi-day-run');
    await expect(owBlockersFor(repo)).resolves.toEqual([]);
  });

  it('stale legacy run blocks even when commits exist since the fork point', async () => {
    const { repo } = makeClonedRepo();
    // Change commit W is authored "now"; the run predates it by years.
    makeRun(repo, '2000-01-02-old-run');
    const blockers = await owBlockersFor(repo);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('no OW run claims this change');
  });

  it('author-date skew: the heuristic compares against the true MINIMUM author date, not log order', async () => {
    const { repo } = makeClonedRepo();
    // Rebuild the change so the NEWER commit (by topology) carries the OLDER
    // author date (cherry-pick/rebase skew). git log lists w2 first, w1 last;
    // taking the last line would read 2026-06-15 and false-block the
    // 2026-06-12 run. The true minimum (2026-06-11) must win → no block.
    git(repo, ['reset', '-q', '--hard', 'origin/master']);
    commit(repo, 'w1.txt', 'w1', '2026-06-15T09:00:00 +0000');
    commit(repo, 'w2.txt', 'w2', '2026-06-11T09:00:00 +0000');
    makeRun(repo, '2026-06-12-run');
    await expect(owBlockersFor(repo)).resolves.toEqual([]);
  });
});

describe('owBlockersFor — run-base marker binding', () => {
  it('marker at HEAD passes regardless of the run dir date (marker beats heuristic)', async () => {
    const { repo, head } = makeLocalRepo();
    makeRun(repo, '2000-01-02-old-run', { runBase: head });
    await expect(owBlockersFor(repo)).resolves.toEqual([]);
  });

  it('marker at the fork point passes (run created when the branch was cut)', async () => {
    const { repo, m } = makeClonedRepo();
    makeRun(repo, '2000-01-02-run', { runBase: m });
    await expect(owBlockersFor(repo)).resolves.toEqual([]);
  });

  it('stale marker: a run-base behind the fork point blocks', async () => {
    const { repo, o, m } = makeClonedRepo();
    makeRun(repo, '2000-01-02-run', { runBase: o });
    const blockers = await owBlockersFor(repo);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('predates the current change');
    expect(blockers[0]).toContain(o.slice(0, 7));
    expect(blockers[0]).toContain(m.slice(0, 7));
  });

  it('a run-base from a different branch history blocks (not an ancestor of HEAD)', async () => {
    const { repo } = makeClonedRepo();
    // Sibling branch commit X is not part of feature's history.
    git(repo, ['checkout', '-q', '-b', 'sibling', 'origin/master']);
    const x = commit(repo, 'x.txt', 'x');
    git(repo, ['checkout', '-q', 'feature']);
    makeRun(repo, '2000-01-02-run', { runBase: x });
    const blockers = await owBlockersFor(repo);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('not an ancestor of HEAD');
  });

  it('an unresolvable run-base sha blocks', async () => {
    const { repo } = makeLocalRepo();
    makeRun(repo, '2000-01-02-run', { runBase: 'deadbeef'.repeat(5) });
    const blockers = await owBlockersFor(repo);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('does not resolve to a commit');
  });

  it('a malformed run-base value blocks BEFORE any git invocation', async () => {
    const { repo } = makeLocalRepo();
    makeRun(repo, '2000-01-02-run', { runBase: '--upload-pack=evil' });
    const blockers = await owBlockersFor(repo);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('malformed run-base marker');
  });

  it('a TODO run-base placeholder falls back to the legacy heuristic', async () => {
    const { repo } = makeLocalRepo();
    makeRun(repo, '2000-01-02-run', { runBase: 'TODO' });
    const blockers = await owBlockersFor(repo);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('no OW run claims this change');
  });

  it('an abbreviated (8-hex) resolvable run-base is accepted', async () => {
    const { repo, m } = makeClonedRepo();
    makeRun(repo, '2000-01-02-run', { runBase: m.slice(0, 8) });
    await expect(owBlockersFor(repo)).resolves.toEqual([]);
  });

  it('an UPPERCASE run-base sha is normalized and accepted', async () => {
    const { repo, head } = makeLocalRepo();
    makeRun(repo, '2000-01-02-run', { runBase: head.toUpperCase() });
    await expect(owBlockersFor(repo)).resolves.toEqual([]);
  });

  it('pinned fail direction: evaluating at an already-pushed default-branch tip false-blocks an older marker', async () => {
    // HEAD == origin/master tip (fork point == HEAD): a base recorded before
    // the tip is then strictly behind the fork point. Deliberately fail-closed
    // — the gate is pre-merge by design; skipping here would reopen the
    // staleness hole for post-push evaluation.
    const { repo, o } = makeClonedRepo();
    git(repo, ['checkout', '-q', 'master']);
    makeRun(repo, '2000-01-02-run', { runBase: o });
    const blockers = await owBlockersFor(repo);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('predates the current change');
  });

  it('pinned fail direction: a dangling origin/HEAD skips the fork-point check (no crash, no block)', async () => {
    // origin/HEAD still points at refs/remotes/origin/master, but that ref is
    // gone → merge-base fails → fork point unresolvable → check 3 skipped,
    // consistent with the no-remote downgrade.
    const { repo, o } = makeClonedRepo();
    git(repo, ['update-ref', '-d', 'refs/remotes/origin/master']);
    makeRun(repo, '2000-01-02-run', { runBase: o });
    await expect(owBlockersFor(repo)).resolves.toEqual([]);
  });
});

describe('owBlockersFor — interaction with completeness and the knob', () => {
  it('an incomplete AND stale run reports both the completeness and binding blockers', async () => {
    const { repo } = makeLocalRepo();
    makeRun(repo, '2000-01-02-run', { finalStatus: 'blocked' });
    const blockers = await owBlockersFor(repo);
    expect(blockers.some((b) => b.includes("final-status is 'blocked'"))).toBe(true);
    expect(blockers.some((b) => b.includes('no OW run claims this change'))).toBe(true);
  });

  it("knob 'off' disables the binding arm too", async () => {
    const { repo } = makeLocalRepo();
    makeRun(repo, '2000-01-02-old-run');
    fs.mkdirSync(path.join(repo, '.ai'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.ai', 'solution-acceptance.json'),
      '{"orchestratorWorkflow":"off"}\n',
      'utf8',
    );
    await expect(owBlockersFor(repo)).resolves.toEqual([]);
  });
});
