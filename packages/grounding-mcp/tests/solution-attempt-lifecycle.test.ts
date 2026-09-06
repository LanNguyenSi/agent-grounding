// Attempt lifecycle for solution_evaluate: bounded wait plus running handle,
// per-sanitized-id attempt log, cross-process mutual exclusion through
// proper-lockfile, and the two read-only lookups.
//
// Isolation mirrors solution-verdict.test.ts: an isolated SOLUTION_VERDICT_DIR
// (which is where the attempt log and the lock anchor live too) and an
// isolated HARNESS_HOME, so no test run touches the host's real state or its
// real signing key. The `preflight` child process is always an executable stub
// script, never a JS mock, and every "exactly one invocation" assertion reads a
// COUNTER FILE the stub itself appends to: a counter the stub never touches
// could not tell a real join apart from a race that started two children.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import lockfile from 'proper-lockfile';

import {
  SolutionAttemptRegistry,
  appendAttemptRecord,
  attemptLockAnchorPath,
  attemptLogPath,
  compactUnderLock,
  encodeRecord,
  latestAttemptId,
  readAttemptRecords,
  reconcileOrphanedAttempts,
  resolveAttempts,
  MAX_RECORD_BYTES,
  RETENTION_POLL_MARGIN,
  type AttemptRecord,
} from '../src/solution-attempt-log.js';
import { sanitizeVerdictId, verdictDir, verdictPath } from '../src/solution-verdict.js';

let tmpDir: string;
let harnessHomeTmp: string;
let repo: string;
let counter: string;
let savedVerdictDir: string | undefined;
let savedHarnessHome: string | undefined;
let savedPreflightBin: string | undefined;

function writeStub(name: string, body: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, body, { mode: 0o755 });
  fs.chmodSync(p, 0o755);
  return p;
}

/** Ready stub that records every invocation in the counter file. */
function readyStub(name: string, sleepSeconds = 0): string {
  const sleep = sleepSeconds > 0 ? `sleep ${sleepSeconds}\n` : '';
  return writeStub(
    name,
    `#!/bin/sh\nprintf 'x\\n' >> '${counter}'\n${sleep}echo '{"ready":true,"confidence":0.9,"blockers":[]}'\n`,
  );
}

function invocations(): number {
  if (!fs.existsSync(counter)) return 0;
  return fs.readFileSync(counter, 'utf8').split('\n').filter((l) => l.length > 0).length;
}

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function waitFor<T>(fn: () => Promise<T> | T, predicate: (v: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (predicate(value)) return value;
    if (Date.now() > deadline) throw new Error(`waitFor timed out on ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Wait until an id's lock is free again. The lock is held for the attempt's
 * WHOLE lifetime, so its release is the observable end of an attempt: a call
 * arriving before that still joins the in-flight attempt (and receives its
 * result), which is the join rule working, not a retry.
 */
async function waitForLockFree(id: string): Promise<void> {
  await waitFor(
    () => fs.existsSync(`${attemptLockAnchorPath(id)}.lock`),
    (held) => held === false,
  );
}

/** Take the id's lock exactly the way the implementation does. */
async function takeForeignLock(id: string): Promise<() => Promise<void>> {
  fs.mkdirSync(verdictDir(), { recursive: true });
  const anchor = attemptLockAnchorPath(id);
  if (!fs.existsSync(anchor)) fs.writeFileSync(anchor, '', { mode: 0o600 });
  return lockfile.lock(anchor, { retries: 0, realpath: false, stale: 30_000 });
}

function appendStart(id: string, attemptId: string, startedAt = iso()): void {
  appendAttemptRecord(sanitizeVerdictId(id), {
    kind: 'start',
    attemptId,
    id,
    head: null,
    startedAt,
    pid: 424_242,
    status: 'running',
  });
}

function recordsFor(id: string): AttemptRecord[] {
  return readAttemptRecords(sanitizeVerdictId(id));
}

function countKind(id: string, kind: AttemptRecord['kind'], attemptId?: string): number {
  return recordsFor(id).filter((r) => r.kind === kind && (attemptId === undefined || r.attemptId === attemptId)).length;
}

beforeEach(() => {
  savedVerdictDir = process.env.SOLUTION_VERDICT_DIR;
  savedHarnessHome = process.env.HARNESS_HOME;
  savedPreflightBin = process.env.SOLUTION_PREFLIGHT_BIN;

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attempt-lifecycle-'));
  harnessHomeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'attempt-lifecycle-harness-home-'));
  process.env.SOLUTION_VERDICT_DIR = path.join(tmpDir, 'verdicts');
  process.env.HARNESS_HOME = harnessHomeTmp;
  counter = path.join(tmpDir, 'preflight-invocations');

  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'attempt-lifecycle-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t.local'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'readme.txt'), 'hello', 'utf8');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
});

afterEach(() => {
  if (savedVerdictDir === undefined) delete process.env.SOLUTION_VERDICT_DIR;
  else process.env.SOLUTION_VERDICT_DIR = savedVerdictDir;
  if (savedHarnessHome === undefined) delete process.env.HARNESS_HOME;
  else process.env.HARNESS_HOME = savedHarnessHome;
  if (savedPreflightBin === undefined) delete process.env.SOLUTION_PREFLIGHT_BIN;
  else process.env.SOLUTION_PREFLIGHT_BIN = savedPreflightBin;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(harnessHomeTmp, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

// ── Bounded wait and the running handle ──────────────────────────────────

describe('solution_evaluate bounded wait', () => {
  it('returns the terminal result unchanged, plus status and attemptId, when preflight finishes inside the bound', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = readyStub('stub-fast.sh');
    const registry = new SolutionAttemptRegistry({ waitBoundMs: 10_000 });
    const res = (await registry.evaluate('bound-fast', repo)) as Record<string, unknown>;

    expect(res.status).toBe('completed');
    expect(typeof res.attemptId).toBe('string');
    expect(res.verdict).toMatchObject({ id: 'bound-fast', ready: true });
    expect(res.markerPath).toBe(verdictPath('bound-fast'));
    expect(res.diagnostics).toMatchObject({ availability: 'available' });
    expect(invocations()).toBe(1);
  }, 20_000);

  it('falls back to {status:"running", attemptId, id, pollAfterMs} once the bound elapses, and the result lands later', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = readyStub('stub-slow.sh', 1);
    const registry = new SolutionAttemptRegistry({ waitBoundMs: 80, pollAfterMs: 20 });
    const res = (await registry.evaluate('bound-slow', repo)) as Record<string, unknown>;

    expect(res.status).toBe('running');
    expect(res.id).toBe('bound-slow');
    expect(typeof res.attemptId).toBe('string');
    expect(res.pollAfterMs).toBe(20);
    expect(res.verdict).toBeUndefined();

    const attemptId = res.attemptId as string;
    const later = await waitFor(
      () => registry.result('bound-slow', attemptId),
      (r) => r.status !== 'running',
    );
    expect(later.status).toBe('completed');
    expect(later.attemptId).toBe(attemptId);
    expect(later.verdict).toMatchObject({ ready: true });
    expect(invocations()).toBe(1);
  }, 30_000);
});

// ── Same-process join ────────────────────────────────────────────────────

describe('same-process join', () => {
  it('two concurrent calls for one id invoke preflight exactly once and share one attemptId', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = readyStub('stub-concurrent.sh', 1);
    const registry = new SolutionAttemptRegistry({ waitBoundMs: 10_000 });

    const first = registry.evaluate('join-concurrent', repo);
    const second = registry.evaluate('join-concurrent', repo);
    const [a, b] = (await Promise.all([first, second])) as Record<string, unknown>[];

    expect(invocations()).toBe(1);
    expect(a.attemptId).toBe(b.attemptId);
    expect(a.status).toBe('completed');
    expect(b.status).toBe('completed');
    expect(countKind('join-concurrent', 'start')).toBe(1);
  }, 30_000);

  it('joins a running attempt, then licenses a genuinely new attempt once it is terminal', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = readyStub('stub-join.sh', 1);
    const registry = new SolutionAttemptRegistry({ waitBoundMs: 80, pollAfterMs: 20 });

    const first = (await registry.evaluate('join-then-retry', repo)) as Record<string, unknown>;
    expect(first.status).toBe('running');
    const joined = (await registry.evaluate('join-then-retry', repo)) as Record<string, unknown>;
    expect(joined.status).toBe('running');
    expect(joined.attemptId).toBe(first.attemptId);
    expect(countKind('join-then-retry', 'start')).toBe(1);
    await waitFor(() => invocations(), (n) => n >= 1);
    expect(invocations()).toBe(1);

    await waitForLockFree('join-then-retry');
    expect((await registry.status('join-then-retry', first.attemptId as string)).status).toBe('completed');

    const retry = (await registry.evaluate('join-then-retry', repo)) as Record<string, unknown>;
    expect(retry.attemptId).not.toBe(first.attemptId);
    await waitForLockFree('join-then-retry');
    expect(invocations()).toBe(2);
    // The retry never overwrote the prior attempt: both rows are present.
    expect(countKind('join-then-retry', 'start')).toBe(2);
    expect(countKind('join-then-retry', 'terminal', first.attemptId as string)).toBe(1);
  }, 40_000);

  it('refuses forceNewAttempt while an attempt for the id is running, and starts nothing', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = readyStub('stub-force.sh', 1);
    const registry = new SolutionAttemptRegistry({ waitBoundMs: 80, pollAfterMs: 20 });

    const first = (await registry.evaluate('force-running', repo)) as Record<string, unknown>;
    expect(first.status).toBe('running');
    const forced = (await registry.evaluate('force-running', repo, { forceNewAttempt: true })) as Record<string, unknown>;

    expect(forced.status).toBe('refused');
    expect(String(forced.error)).toContain('forceNewAttempt is refused');
    expect(countKind('force-running', 'start')).toBe(1);
    await waitForLockFree('force-running');
    expect(invocations()).toBe(1);
  }, 30_000);
});

// ── Cross-process join (the test holds the real lock) ────────────────────

describe('cross-process join', () => {
  it('joins the lock holder by attemptId, spawns nothing, and answers status/result for that foreign attemptId', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = readyStub('stub-cross.sh');
    const release = await takeForeignLock('cross-join');
    appendStart('cross-join', 'foreign-attempt-1');
    try {
      const registry = new SolutionAttemptRegistry({ waitBoundMs: 5_000, pollAfterMs: 20 });
      const res = (await registry.evaluate('cross-join', repo)) as Record<string, unknown>;

      expect(res.status).toBe('running');
      expect(res.attemptId).toBe('foreign-attempt-1');
      expect(res.pollAfterMs).toBe(20);
      expect(invocations()).toBe(0);

      const status = await registry.status('cross-join', 'foreign-attempt-1');
      expect(status.status).toBe('running');
      expect(status.attemptId).toBe('foreign-attempt-1');
      const result = await registry.result('cross-join', 'foreign-attempt-1');
      expect(result.status).toBe('running');
      expect(countKind('cross-join', 'reconciled-unknown')).toBe(0);
    } finally {
      await release();
    }
  }, 30_000);

  it('never waits on the lock: the join answers while the holder still holds it, and does not turn into a run when it is released', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = readyStub('stub-no-wait.sh');
    const release = await takeForeignLock('no-wait');
    appendStart('no-wait', 'foreign-attempt-3');
    const registry = new SolutionAttemptRegistry({ waitBoundMs: 20_000, pollAfterMs: 20 });

    // Fired without awaiting: a retry-free acquisition answers within this
    // window, long before the holder releases. An acquisition WITH retries
    // would still be waiting here, and would then acquire and spawn below.
    const pending = registry.evaluate('no-wait', repo);
    await new Promise((r) => setTimeout(r, 250));
    await release();

    const res = (await pending) as Record<string, unknown>;
    expect(res.status).toBe('running');
    expect(res.attemptId).toBe('foreign-attempt-3');
    expect(invocations()).toBe(0);
    expect(countKind('no-wait', 'start')).toBe(1);
  }, 30_000);

  it('refuses forceNewAttempt while the id lock is held by another holder', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = readyStub('stub-cross-force.sh');
    const release = await takeForeignLock('cross-force');
    appendStart('cross-force', 'foreign-attempt-2');
    try {
      const registry = new SolutionAttemptRegistry({ waitBoundMs: 5_000 });
      const res = (await registry.evaluate('cross-force', repo, { forceNewAttempt: true })) as Record<string, unknown>;
      expect(res.status).toBe('refused');
      expect(invocations()).toBe(0);
    } finally {
      await release();
    }
  }, 30_000);

  it('reports running-unconfirmed for a held lock whose newest attempt already carries an outcome record', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = readyStub('stub-abandoned-lock.sh');
    const key = sanitizeVerdictId('abandoned-lock');
    appendStart('abandoned-lock', 'finished-attempt');
    appendAttemptRecord(key, {
      kind: 'terminal',
      attemptId: 'finished-attempt',
      id: 'abandoned-lock',
      status: 'completed',
      terminalAt: iso(),
      outcomeClass: 'ready',
      summary: 'ready=true confidence=0.9 blockers=0',
    });
    // A lock left behind by a killed holder: nothing running is under it, so
    // there is no attemptId to hand back and nothing may be spawned either.
    const release = await takeForeignLock('abandoned-lock');
    try {
      const registry = new SolutionAttemptRegistry({ waitBoundMs: 5_000, pollAfterMs: 20 });
      const res = (await registry.evaluate('abandoned-lock', repo)) as Record<string, unknown>;
      expect(res.status).toBe('running-unconfirmed');
      expect(res.attemptId).toBeUndefined();
      expect(invocations()).toBe(0);
      // A lookup answers from the log for a row that already carries an
      // outcome; it does not need the lock for that.
      expect((await registry.status('abandoned-lock')).status).toBe('completed');
    } finally {
      await release();
    }
  }, 30_000);

  it('reports running-unconfirmed for a held lock with no running row, and starts an attempt once it is free', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = readyStub('stub-unconfirmed.sh');
    const release = await takeForeignLock('unconfirmed-id');
    const registry = new SolutionAttemptRegistry({ waitBoundMs: 5_000, pollAfterMs: 20 });

    const held = (await registry.evaluate('unconfirmed-id', repo)) as Record<string, unknown>;
    expect(held.status).toBe('running-unconfirmed');
    expect(held.attemptId).toBeUndefined();
    expect(held.pollAfterMs).toBe(20);
    expect(invocations()).toBe(0);
    expect((await registry.status('unconfirmed-id')).status).toBe('running-unconfirmed');

    await release();

    // A lock this pass can acquire has no attempt under it: nothing to reconcile.
    const summary = await reconcileOrphanedAttempts({ staleMs: 30_000 });
    expect(summary.reconciled).toEqual([]);

    const started = (await registry.evaluate('unconfirmed-id', repo)) as Record<string, unknown>;
    expect(started.status).toBe('completed');
    expect(invocations()).toBe(1);
  }, 30_000);
});

// ── Restart simulation and reconciliation ────────────────────────────────

describe('restart simulation and reconciliation', () => {
  it('does not report unknown while the lock is held, reconciles exactly once when it is free, and only then licenses a new attempt', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = readyStub('stub-restart.sh');
    const release = await takeForeignLock('restart-id');
    appendStart('restart-id', 'pre-restart-attempt');

    // A fresh registry is a restarted process: empty in-memory registry, the
    // on-disk row still `running`, the lock still held by the holder.
    const fresh = new SolutionAttemptRegistry({ waitBoundMs: 5_000, pollAfterMs: 20 });
    const held = await fresh.status('restart-id', 'pre-restart-attempt');
    expect(held.status).toBe('running');
    const blocked = (await fresh.evaluate('restart-id', repo)) as Record<string, unknown>;
    expect(blocked.status).toBe('running');
    expect(blocked.attemptId).toBe('pre-restart-attempt');
    expect(invocations()).toBe(0);

    await release();

    const summary = await reconcileOrphanedAttempts({ staleMs: 30_000 });
    expect(summary.reconciled).toEqual([{ key: 'restart-id', attemptId: 'pre-restart-attempt' }]);
    expect(countKind('restart-id', 'reconciled-unknown', 'pre-restart-attempt')).toBe(1);
    expect((await fresh.status('restart-id', 'pre-restart-attempt')).status).toBe('unknown');

    // A second pass must not append a second record for the same attemptId.
    await reconcileOrphanedAttempts({ staleMs: 30_000 });
    expect(countKind('restart-id', 'reconciled-unknown', 'pre-restart-attempt')).toBe(1);

    const started = (await fresh.evaluate('restart-id', repo)) as Record<string, unknown>;
    expect(started.status).toBe('completed');
    expect(invocations()).toBe(1);
  }, 30_000);

  it('resolves an unrecognized attemptId to unknown without appending anything', async () => {
    const registry = new SolutionAttemptRegistry({ waitBoundMs: 100 });
    const status = await registry.status('never-seen', 'no-such-attempt');
    expect(status.status).toBe('unknown');
    expect(status.attemptId).toBe('no-such-attempt');
    expect(fs.existsSync(attemptLogPath('never-seen'))).toBe(false);
  });

  it('a read-path lookup, not a startup pass, reconciles a holder that died after the last startup, exactly once under two concurrent lookups', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = readyStub('stub-readpath.sh');
    // An unrelated, earlier attempt the startup pass does reconcile.
    appendStart('earlier-id', 'earlier-attempt');
    // The attempt whose holder is still alive across that startup pass.
    const release = await takeForeignLock('later-id');
    appendStart('later-id', 'later-attempt');

    const summary = await reconcileOrphanedAttempts({ staleMs: 30_000 });
    expect(summary.reconciled).toEqual([{ key: 'earlier-id', attemptId: 'earlier-attempt' }]);
    expect(summary.skippedLocked).toContain('later-id');
    expect(countKind('later-id', 'reconciled-unknown')).toBe(0);

    // The holder goes away only now, long after that startup pass.
    await release();
    const registry = new SolutionAttemptRegistry({ waitBoundMs: 5_000 });
    const [statusA, statusB] = await Promise.all([
      registry.status('later-id', 'later-attempt'),
      registry.result('later-id', 'later-attempt'),
    ]);
    expect([statusA.status, statusB.status]).toContain('unknown');
    expect(countKind('later-id', 'reconciled-unknown', 'later-attempt')).toBe(1);
    expect((await registry.status('later-id', 'later-attempt')).status).toBe('unknown');
  }, 30_000);
});

// ── Retention, compaction, tombstones ────────────────────────────────────

describe('retention and compaction', () => {
  it('compacts a terminal attempt to a tombstone that resolves to expired, and prunes it from the in-memory registry', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = readyStub('stub-retention.sh', 1);
    let clockValue = Date.now();
    const registry = new SolutionAttemptRegistry({
      waitBoundMs: 80,
      pollAfterMs: 20,
      retentionMs: 5_000,
      now: () => clockValue,
    });

    const running = (await registry.evaluate('retention-id', repo)) as Record<string, unknown>;
    expect(running.status).toBe('running');
    const advertisedPollAfterMs = running.pollAfterMs as number;
    // The invariant itself, not just the mechanism: retention exceeds the
    // pollAfterMs this very call advertised, by the stated margin.
    expect(registry.retentionMs).toBeGreaterThan(advertisedPollAfterMs * RETENTION_POLL_MARGIN - 1);

    const attemptId = running.attemptId as string;
    await waitForLockFree('retention-id');
    expect((await registry.status('retention-id', attemptId)).status).toBe('completed');
    expect(registry.ownsAttempt(attemptId)).toBe(true);

    clockValue += 60_000;
    expect(registry.pruneOwned()).toEqual([attemptId]);
    expect(registry.ownsAttempt(attemptId)).toBe(false);

    // Compaction only ever runs as the tail step of an acquisition made for
    // another reason; a genuinely new attempt for the id is one such reason.
    await registry.evaluate('retention-id', repo);
    await waitFor(
      () => recordsFor('retention-id').filter((r) => r.kind === 'tombstone').length,
      (n) => n === 1,
    );

    const tombstones = recordsFor('retention-id').filter((r) => r.kind === 'tombstone');
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({ attemptId, outcomeClass: 'ready' });
    const pruned = await registry.result('retention-id', attemptId);
    expect(pruned.status).toBe('expired');
    expect(pruned.verdict).toBeUndefined();
  }, 40_000);

  it('clamps retention up to RETENTION_POLL_MARGIN x the advertised pollAfterMs, and leaves a roomier one alone', () => {
    // The clamp is the invariant, so it is asserted where it BINDS: a
    // configured retention below the floor must come back AS the floor. The
    // retention test above configures 5000 ms against a 20 ms poll hint, which
    // is already above the floor and therefore holds with or without the
    // clamp; this one does not.
    const clamped = new SolutionAttemptRegistry({ pollAfterMs: 1_000, retentionMs: 10 });
    expect(clamped.pollAfterMs).toBe(1_000);
    expect(clamped.retentionMs).toBe(1_000 * RETENTION_POLL_MARGIN);

    // Above the floor, the configured value is kept exactly.
    const roomy = new SolutionAttemptRegistry({ pollAfterMs: 10, retentionMs: 500_000 });
    expect(roomy.retentionMs).toBe(500_000);
  });

  it('ages a terminal attempt out of the in-memory registry on an ordinary evaluate, with nothing calling pruneOwned by hand', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = readyStub('stub-prune-evaluate.sh');
    let clockValue = Date.now();
    const registry = new SolutionAttemptRegistry({
      waitBoundMs: 20_000,
      pollAfterMs: 20,
      retentionMs: 5_000,
      now: () => clockValue,
    });

    const first = (await registry.evaluate('prune-evaluate', repo)) as Record<string, unknown>;
    expect(first.status).toBe('completed');
    const attemptId = first.attemptId as string;
    expect(registry.ownsAttempt(attemptId)).toBe(true);

    // Past the retention window on the injected clock. Nothing in this test
    // calls pruneOwned(): a long-lived server never would either, which is
    // exactly the reason the call has to live on a production path.
    clockValue += 60_000;
    expect(registry.ownsAttempt(attemptId)).toBe(true);

    const second = (await registry.evaluate('prune-evaluate', repo)) as Record<string, unknown>;
    expect(second.status).toBe('completed');
    expect(registry.ownsAttempt(attemptId)).toBe(false);
    // The attempt that just finished is inside the window and is kept.
    expect(registry.ownsAttempt(second.attemptId as string)).toBe(true);
  }, 40_000);

  it('ages a terminal attempt out of the in-memory registry on an ordinary lookup that takes the lock', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = readyStub('stub-prune-lookup.sh');
    let clockValue = Date.now();
    const registry = new SolutionAttemptRegistry({
      waitBoundMs: 20_000,
      pollAfterMs: 20,
      retentionMs: 5_000,
      now: () => clockValue,
    });

    const own = (await registry.evaluate('prune-lookup', repo)) as Record<string, unknown>;
    const attemptId = own.attemptId as string;
    expect(registry.ownsAttempt(attemptId)).toBe(true);

    // A newer, orphaned row for the same id: the lookup below therefore takes
    // the read-path liveness acquisition, which is the second place the
    // in-memory registry ages out.
    appendStart('prune-lookup', 'orphan-attempt', new Date(clockValue + 1_000).toISOString());
    clockValue += 60_000;

    expect((await registry.status('prune-lookup')).status).toBe('unknown');
    expect(registry.ownsAttempt(attemptId)).toBe(false);
  }, 40_000);

  it('does not let an EXPIRED prior attempt license a new one while the id lock is live', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = readyStub('stub-expired-locked.sh');
    const key = sanitizeVerdictId('expired-locked');
    const old = new Date(Date.now() - 3_600_000).toISOString();
    appendStart('expired-locked', 'old-attempt', old);
    appendAttemptRecord(key, {
      kind: 'terminal',
      attemptId: 'old-attempt',
      id: 'expired-locked',
      status: 'completed',
      terminalAt: old,
      outcomeClass: 'ready',
      summary: 'ready=true confidence=0.9 blockers=0',
    });
    expect(compactUnderLock(key, Date.now(), 5_000)).toBe(true);

    const reader = new SolutionAttemptRegistry({ waitBoundMs: 5_000, pollAfterMs: 20 });
    expect((await reader.status('expired-locked', 'old-attempt')).status).toBe('expired');

    // The other half of "only an acquisition licenses a new attempt": the
    // completed/unknown halves are covered above, this is `expired`. A settled
    // prior fate, however final it reads, never licenses one on its own.
    const release = await takeForeignLock('expired-locked');
    try {
      const registry = new SolutionAttemptRegistry({ waitBoundMs: 5_000, pollAfterMs: 20 });
      const res = (await registry.evaluate('expired-locked', repo)) as Record<string, unknown>;
      expect(res.status).toBe('running-unconfirmed');
      expect(invocations()).toBe(0);
      expect(countKind('expired-locked', 'start')).toBe(0);

      const forced = (await registry.evaluate('expired-locked', repo, { forceNewAttempt: true })) as Record<string, unknown>;
      expect(forced.status).toBe('refused');
      expect(invocations()).toBe(0);
    } finally {
      await release();
    }

    // The acquisition is what licenses it, and it does so only now.
    const after = new SolutionAttemptRegistry({ waitBoundMs: 20_000 });
    const started = (await after.evaluate('expired-locked', repo)) as Record<string, unknown>;
    expect(started.status).toBe('completed');
    expect(invocations()).toBe(1);
    expect(countKind('expired-locked', 'start')).toBe(1);
  }, 40_000);

  it('keeps a compacted reconciled-unknown attempt at unknown, never laundering it into expired', () => {
    const key = sanitizeVerdictId('compact-unknown');
    const old = new Date(Date.now() - 3_600_000).toISOString();
    appendStart('compact-unknown', 'settled-unknown', old);
    appendAttemptRecord(key, { kind: 'reconciled-unknown', attemptId: 'settled-unknown', id: 'compact-unknown', reconciledAt: old });
    appendStart('compact-unknown', 'settled-terminal', old);
    appendAttemptRecord(key, {
      kind: 'terminal',
      attemptId: 'settled-terminal',
      id: 'compact-unknown',
      status: 'completed',
      terminalAt: old,
      outcomeClass: 'ready',
      summary: 'ready=true confidence=0.9 blockers=0',
    });

    expect(compactUnderLock(key, Date.now(), 5_000)).toBe(true);
    const resolved = resolveAttempts(readAttemptRecords(key));
    expect(resolved.get('settled-unknown')).toMatchObject({ status: 'unknown', outcomeClass: 'unknown' });
    expect(resolved.get('settled-terminal')).toMatchObject({ status: 'expired', outcomeClass: 'ready' });
  });

  it('skips compaction entirely when the acquisition came back ELOCKED, leaving the log byte-identical', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = readyStub('stub-elocked-compaction.sh');
    const key = sanitizeVerdictId('elocked-compaction');
    const old = new Date(Date.now() - 3_600_000).toISOString();
    appendStart('elocked-compaction', 'old-attempt', old);
    appendAttemptRecord(key, {
      kind: 'terminal',
      attemptId: 'old-attempt',
      id: 'elocked-compaction',
      status: 'completed',
      terminalAt: old,
      outcomeClass: 'ready',
      summary: 'ready=true confidence=0.9 blockers=0',
    });
    appendStart('elocked-compaction', 'live-attempt');

    const release = await takeForeignLock('elocked-compaction');
    const before = fs.readFileSync(attemptLogPath('elocked-compaction'));
    try {
      const registry = new SolutionAttemptRegistry({ waitBoundMs: 5_000, retentionMs: 5_000 });
      const res = (await registry.evaluate('elocked-compaction', repo)) as Record<string, unknown>;
      expect(res.status).toBe('running');
      expect(res.attemptId).toBe('live-attempt');
      expect(fs.readFileSync(attemptLogPath('elocked-compaction')).equals(before)).toBe(true);
      expect(invocations()).toBe(0);
    } finally {
      await release();
    }
  }, 30_000);
});

// ── Record size bound, unparseable lines, file modes ─────────────────────

describe('attempt log record discipline', () => {
  it('caps a record at 2 KiB with the persisted error truncated first and marked', async () => {
    // Empty stdout plus a very large stderr makes execFile's own error message
    // (command line plus stderr) the oversized field.
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-huge-stderr.sh',
      `#!/bin/sh\nprintf 'x\\n' >> '${counter}'\nawk 'BEGIN{while(i++<20000)printf "E"}' >&2\nexit 3\n`,
    );
    const registry = new SolutionAttemptRegistry({ waitBoundMs: 20_000 });
    const res = (await registry.evaluate('huge-error', repo)) as Record<string, unknown>;
    expect(res.status).toBe('failed');

    const raw = fs.readFileSync(attemptLogPath('huge-error'), 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(Buffer.byteLength(line, 'utf8') + 1).toBeLessThanOrEqual(MAX_RECORD_BYTES);
    }
    const terminal = recordsFor('huge-error').find((r) => r.kind === 'terminal');
    expect(terminal).toMatchObject({ status: 'failed', outcomeClass: 'error', errorTruncated: true });
    expect(String((terminal as { error: string }).error)).toContain('[truncated]');

    // The owning process still holds the full error in memory; the persisted,
    // size-bounded copy is what any other process reads back.
    const foreign = new SolutionAttemptRegistry({ waitBoundMs: 100 });
    const readBack = await foreign.result('huge-error', res.attemptId as string);
    expect(String(readBack.error)).toContain('[truncated]');
    expect(Buffer.byteLength(String(readBack.error), 'utf8')).toBeLessThanOrEqual(MAX_RECORD_BYTES);
  }, 30_000);

  it('skips an unparseable line, reports the attempt from its remaining records, and never rewrites the file', async () => {
    const key = sanitizeVerdictId('corrupt-line');
    appendStart('corrupt-line', 'corrupt-attempt');
    fs.appendFileSync(attemptLogPath('corrupt-line'), '{ this is not json\n');
    appendAttemptRecord(key, {
      kind: 'terminal',
      attemptId: 'corrupt-attempt',
      id: 'corrupt-line',
      status: 'completed',
      terminalAt: iso(),
      outcomeClass: 'ready',
      summary: 'ready=true confidence=0.9 blockers=0',
    });

    const before = fs.readFileSync(attemptLogPath('corrupt-line'));
    const registry = new SolutionAttemptRegistry({ waitBoundMs: 100 });
    const status = await registry.status('corrupt-line', 'corrupt-attempt');

    expect(status.status).toBe('completed');
    expect(fs.readFileSync(attemptLogPath('corrupt-line')).equals(before)).toBe(true);
  });

  it('creates the attempt log and the lock anchor with mode 0600', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = readyStub('stub-modes.sh');
    const registry = new SolutionAttemptRegistry({ waitBoundMs: 20_000 });
    await registry.evaluate('mode-id', repo);

    expect(fs.statSync(attemptLogPath('mode-id')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(attemptLockAnchorPath('mode-id')).mode & 0o777).toBe(0o600);
  }, 30_000);

  it('encodes an oversized record without an error field by dropping free-form fields, never by emitting a longer line', () => {
    const line = encodeRecord({
      kind: 'terminal',
      attemptId: 'x',
      id: 'y',
      status: 'failed',
      terminalAt: iso(),
      outcomeClass: 'error',
      summary: 'S'.repeat(9_000),
    });
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(MAX_RECORD_BYTES);
  });
});

// ── Reader-side precedence and the late terminal write ───────────────────

describe('reader-side precedence over last-record-wins', () => {
  it('resolves to unknown even when a terminal record for the same attemptId is physically later in the file', async () => {
    const key = sanitizeVerdictId('reader-precedence');
    appendStart('reader-precedence', 'raced-attempt');
    appendAttemptRecord(key, {
      kind: 'reconciled-unknown',
      attemptId: 'raced-attempt',
      id: 'reader-precedence',
      reconciledAt: iso(),
    });
    // Hand-assembled: bypasses the write path entirely, so the reader is
    // isolated from the writer's own re-read-and-skip optimization.
    appendAttemptRecord(key, {
      kind: 'terminal',
      attemptId: 'raced-attempt',
      id: 'reader-precedence',
      status: 'completed',
      terminalAt: iso(),
      outcomeClass: 'ready',
      summary: 'ready=true confidence=0.9 blockers=0',
    });

    const registry = new SolutionAttemptRegistry({ waitBoundMs: 100 });
    const status = await registry.status('reader-precedence', 'raced-attempt');
    const result = await registry.result('reader-precedence', 'raced-attempt');

    expect(status.status).toBe('unknown');
    expect(result.status).toBe('unknown');
    expect(result.outcomeClass).toBeUndefined();
    expect(resolveAttempts(recordsFor('reader-precedence')).get('raced-attempt')?.status).toBe('unknown');
  });

  it('discards a late terminal write for an already-reconciled attempt without touching the newer attempt', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = readyStub('stub-late-write.sh');
    const release = await takeForeignLock('late-write');
    appendStart('late-write', 'first-attempt');
    await release();
    await reconcileOrphanedAttempts({ staleMs: 30_000 });
    expect(countKind('late-write', 'reconciled-unknown', 'first-attempt')).toBe(1);

    const registry = new SolutionAttemptRegistry({ waitBoundMs: 20_000 });
    const second = (await registry.evaluate('late-write', repo)) as Record<string, unknown>;
    expect(second.status).toBe('completed');

    // Any concurrent writer arriving late for the FIRST attempt, through the
    // real terminal-write path.
    registry.appendTerminalRecordForTest('late-write', 'first-attempt', 'completed', 'ready', 'late arrival');

    // The write-side re-read is an optimization, so assert it directly: no
    // terminal record for the first attempt is ever appended. The reader rule
    // below is the actual guarantee and is asserted separately.
    expect(countKind('late-write', 'terminal', 'first-attempt')).toBe(0);
    const resolved = resolveAttempts(recordsFor('late-write'));
    expect(resolved.get('first-attempt')?.status).toBe('unknown');
    expect(resolved.get(second.attemptId as string)?.status).toBe('completed');
    const latest = await registry.result('late-write', second.attemptId as string);
    expect(latest.isLatestForId).toBe(true);
    expect(latest.status).toBe('completed');
  }, 30_000);
});

// ── Result payloads ──────────────────────────────────────────────────────

describe('solution_evaluate_result payloads', () => {
  it('refuses a ready verdict for a superseded attempt and returns the full payload for the latest one', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = readyStub('stub-superseded.sh');
    const registry = new SolutionAttemptRegistry({ waitBoundMs: 20_000 });

    const first = (await registry.evaluate('superseded-id', repo)) as Record<string, unknown>;
    const second = (await registry.evaluate('superseded-id', repo)) as Record<string, unknown>;
    expect(first.attemptId).not.toBe(second.attemptId);

    const stale = await registry.result('superseded-id', first.attemptId as string);
    expect(stale.isLatestForId).toBe(false);
    expect(stale.status).toBe('completed');
    expect(stale.outcomeClass).toBe('ready');
    expect(stale).not.toHaveProperty('verdict');
    expect(stale).not.toHaveProperty('markerPath');
    expect(stale.markerPresent).toBe(true);

    const current = await registry.result('superseded-id', second.attemptId as string);
    expect(current.isLatestForId).toBe(true);
    expect(current.verdict).toMatchObject({ ready: true });
    expect(current.markerPath).toBe(verdictPath('superseded-id'));

    // markerPresent is a fresh filesystem check, not a cached value.
    fs.unlinkSync(verdictPath('superseded-id'));
    expect((await registry.result('superseded-id', second.attemptId as string)).markerPresent).toBe(false);
  }, 40_000);

  it('returns the reduced shape to a process that does not own the attempt, for a completed and for a failed attempt', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = readyStub('stub-owner.sh');
    const owner = new SolutionAttemptRegistry({ waitBoundMs: 20_000 });
    const completed = (await owner.evaluate('owned-ok', repo)) as Record<string, unknown>;
    expect(completed.status).toBe('completed');

    process.env.SOLUTION_PREFLIGHT_BIN = path.join(tmpDir, 'no-such-preflight');
    const failed = (await owner.evaluate('owned-failed', repo)) as Record<string, unknown>;
    expect(failed.status).toBe('failed');

    // A registry that never ran either attempt: a different process, or this
    // one after a restart.
    const foreign = new SolutionAttemptRegistry({ waitBoundMs: 20_000 });

    const foreignOk = await foreign.result('owned-ok', completed.attemptId as string);
    expect(Object.keys(foreignOk).sort()).toEqual(
      ['attemptId', 'id', 'isLatestForId', 'markerPath', 'markerPresent', 'outcomeClass', 'status', 'summary', 'verdict'].sort(),
    );
    expect(foreignOk).not.toHaveProperty('diagnostics');
    expect(foreignOk.outcomeClass).toBe('ready');
    expect(foreignOk.verdict).toMatchObject({ id: 'owned-ok', ready: true });

    const foreignFailed = await foreign.result('owned-failed', failed.attemptId as string);
    expect(Object.keys(foreignFailed).sort()).toEqual(
      ['attemptId', 'error', 'id', 'isLatestForId', 'markerPresent', 'outcomeClass', 'status', 'summary'].sort(),
    );
    expect(foreignFailed).not.toHaveProperty('diagnostics');
    expect(foreignFailed.outcomeClass).toBe('error');
    expect(foreignFailed.markerPresent).toBe(false);
    expect(String(foreignFailed.error)).toContain('preflight binary not found');

    // The owning registry still answers with the full EvaluateResult shape.
    const ownedOk = await owner.result('owned-ok', completed.attemptId as string);
    expect(ownedOk.diagnostics).toMatchObject({ availability: 'available' });
    expect(ownedOk.verdict).toMatchObject({ ready: true });
    const ownedFailed = await owner.result('owned-failed', failed.attemptId as string);
    expect(ownedFailed.diagnostics).toMatchObject({ availability: 'unavailable' });
  }, 40_000);
});

// ── Compromised holder ───────────────────────────────────────────────────

describe('compromised holder', () => {
  it('writes no marker, records outcomeClass compromised, and returns an explicit error', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = readyStub('stub-compromised.sh', 4);
    // stale 2000 makes the library's heartbeat fire about once a second
    // (`lock()` floors `update` at 1000 ms and `stale` at 2000 ms), so removing
    // the lock directory surfaces as a compromise roughly a second later.
    const registry = new SolutionAttemptRegistry({ waitBoundMs: 30_000, lockStaleMs: 2_000 });
    const pending = registry.evaluate('compromised-id', repo);

    // Wait until the attempt is genuinely under way (its own stub has run), so
    // the removal cannot land inside the library's own acquisition sequence.
    await waitFor(() => invocations(), (n) => n >= 1, 10_000);
    fs.rmdirSync(`${attemptLockAnchorPath('compromised-id')}.lock`);

    const res = (await pending) as Record<string, unknown>;
    expect(res.status).toBe('failed');
    expect(String(res.error)).toContain('lost its lock');
    expect(res.verdict).toBeNull();
    // Asserted against disk, not against a spy: the marker is the only thing
    // the gate would ever read.
    expect(fs.existsSync(verdictPath('compromised-id'))).toBe(false);

    const terminal = recordsFor('compromised-id').find((r) => r.kind === 'terminal');
    expect(terminal).toMatchObject({ status: 'failed', outcomeClass: 'compromised' });
    expect(invocations()).toBe(1);
  }, 40_000);
});

// ── Startup wiring ───────────────────────────────────────────────────────

describe('startup reconciliation in the CLI entrypoint', () => {
  it('reconciles an orphaned running row before the server answers its first request', async () => {
    appendStart('startup-id', 'startup-attempt');
    const serverBin = path.resolve(__dirname, '..', 'dist', 'server.js');
    const child = spawn(process.execPath, [serverBin], {
      env: { ...process.env, SOLUTION_VERDICT_DIR: verdictDir(), HARNESS_HOME: harnessHomeTmp },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const firstResponse = new Promise<string>((resolve, reject) => {
        let buffered = '';
        child.stdout.on('data', (chunk: Buffer) => {
          buffered += chunk.toString('utf8');
          const newline = buffered.indexOf('\n');
          if (newline >= 0) resolve(buffered.slice(0, newline));
        });
        child.on('error', reject);
        setTimeout(() => reject(new Error('no initialize response')), 15_000).unref?.();
      });
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'startup-test', version: '0.0.0' },
          },
        })}\n`,
      );
      const line = await firstResponse;
      expect(line).toContain('grounding-mcp');
      // The pass ran BEFORE the transport answered anything.
      expect(countKind('startup-id', 'reconciled-unknown', 'startup-attempt')).toBe(1);
    } finally {
      child.kill('SIGKILL');
    }
  }, 30_000);
});

// ── Log helpers ──────────────────────────────────────────────────────────

describe('attempt log helpers', () => {
  it('picks the latest attempt by startedAt and ignores compacted attempts', () => {
    const key = sanitizeVerdictId('latest-id');
    appendStart('latest-id', 'older', '2026-01-01T00:00:00.000Z');
    appendStart('latest-id', 'newer', '2026-02-01T00:00:00.000Z');
    expect(latestAttemptId(readAttemptRecords(key))).toBe('newer');
  });

  it('reads an empty list for an id that has no log at all', () => {
    expect(readAttemptRecords(sanitizeVerdictId('no-log-id'))).toEqual([]);
    expect(latestAttemptId([])).toBeNull();
  });
});

// ── Terminal write order (write, then release) ───────────────────────────

describe('terminal write order', () => {
  it('appends the terminal record while this process still holds the id lock, and never leaves a started attempt uncovered', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = readyStub('stub-write-order.sh', 1);
    const lockDir = `${attemptLockAnchorPath('write-order')}.lock`;
    const logPath = attemptLogPath('write-order');

    // The order, observed deterministically rather than raced for: sample
    // whether this process's lock directory still exists at the instant the
    // terminal line is handed to the kernel. That directory IS the lock under
    // `proper-lockfile` (it creates it to acquire and removes it to release),
    // and `stale` is 30 s here, so mid-attempt it cannot be a stale leftover:
    // its presence is the readable form of "the writer still holds the lock".
    // A release moved before the append inverts this sample; a poller cannot
    // see that window reliably, because the release and the append that
    // follows it are one microtask chain.
    const lockHeldAtTerminalWrite: boolean[] = [];
    const realWriteSync = fs.writeSync;
    const patched = ((fd: number, data: unknown, ...rest: unknown[]): number => {
      if (typeof data === 'string' && data.includes('"kind":"terminal"')) {
        try {
          const parsed = JSON.parse(data) as { kind?: string; id?: string };
          if (parsed.kind === 'terminal' && parsed.id === 'write-order') {
            lockHeldAtTerminalWrite.push(fs.existsSync(lockDir));
          }
        } catch {
          // Not one of ours; every other writer on this fd is left alone.
        }
      }
      return (realWriteSync as unknown as (...args: unknown[]) => number)(fd, data, ...rest);
    }) as unknown as typeof fs.writeSync;

    // The same invariant from the outside, sampled in lockstep with the run:
    // an attempt that has a `start` record and no outcome record yet must
    // never be observable while the id's lock is free, because that is exactly
    // the state a reconciler would settle as `unknown`.
    const violations: string[] = [];
    const poll = setInterval(() => {
      let raw: string;
      try {
        raw = fs.readFileSync(logPath, 'utf8');
      } catch {
        return;
      }
      if (!raw.includes('"kind":"start"')) return;
      if (raw.includes('"kind":"terminal"')) return;
      if (!fs.existsSync(lockDir)) violations.push(new Date().toISOString());
    }, 1);

    (fs as { writeSync: typeof fs.writeSync }).writeSync = patched;
    try {
      const registry = new SolutionAttemptRegistry({ waitBoundMs: 20_000 });
      const res = (await registry.evaluate('write-order', repo)) as Record<string, unknown>;
      expect(res.status).toBe('completed');
    } finally {
      (fs as { writeSync: typeof fs.writeSync }).writeSync = realWriteSync;
      clearInterval(poll);
    }

    expect(lockHeldAtTerminalWrite).toEqual([true]);
    expect(violations).toEqual([]);
    expect(countKind('write-order', 'terminal')).toBe(1);
    // The lock is free afterwards: the release still happens, just later.
    expect(fs.existsSync(lockDir)).toBe(false);
  }, 40_000);
});

// ── Unusable ids on the read-only lookups ────────────────────────────────

describe('unusable ids on the lookups', () => {
  it('answers with {status:"unknown", id, error} instead of throwing, and creates nothing anywhere', async () => {
    const registry = new SolutionAttemptRegistry({ waitBoundMs: 100 });
    for (const bad of ['..', '.', 'L'.repeat(5_000)]) {
      const status = await registry.status(bad);
      expect(status.status).toBe('unknown');
      expect(status.id).toBe(bad);
      expect(String(status.error)).toContain('this id cannot be looked up');
      expect(status.attemptId).toBeUndefined();

      const result = await registry.result(bad);
      expect(result.status).toBe('unknown');
      expect(result.id).toBe(bad);
      expect(String(result.error)).toContain('this id cannot be looked up');
    }

    // The attemptId the caller passed is echoed back on the same shape.
    const withAttempt = await registry.status('..', 'some-attempt');
    expect(withAttempt).toMatchObject({ status: 'unknown', id: '..', attemptId: 'some-attempt' });
    expect(String(withAttempt.error)).toContain('invalid verdict id');

    // No log, no lock anchor, nothing inside verdictDir() and nothing outside
    // it: `sanitizeVerdictId` is still the only path builder on this route.
    expect(fs.existsSync(verdictDir()) ? fs.readdirSync(verdictDir()) : []).toEqual([]);
  }, 20_000);

  it('answers a traversal-shaped id the same way, and writes nothing outside the verdict dir', async () => {
    const registry = new SolutionAttemptRegistry({ waitBoundMs: 100 });
    const escape = path.join(tmpDir, 'escaped-by-lookup');
    const status = await registry.status(`../../../../../..${escape}`);
    // Collapsed to one safe segment by the sanitizer, so it is an ordinary
    // never-seen id rather than an error, and it resolves inside the dir.
    expect(status.status).toBe('unknown');
    expect(fs.existsSync(escape)).toBe(false);
    expect(fs.existsSync(`${escape}${'.attempts.jsonl'}`)).toBe(false);
  }, 20_000);
});

// ── Two REAL server processes on one id (shape a) ────────────────────────

describe('two grounding-mcp processes, one id', () => {
  interface StdioClient {
    child: ReturnType<typeof spawn>;
    send: (method: string, params: unknown) => Promise<{ result?: { content?: { text: string }[] } }>;
    notify: (method: string, params: unknown) => void;
  }

  function startServer(env: NodeJS.ProcessEnv): StdioClient {
    const serverBin = path.resolve(__dirname, '..', 'dist', 'server.js');
    const child = spawn(process.execPath, [serverBin], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const pending = new Map<number, (msg: { result?: { content?: { text: string }[] } }) => void>();
    let buffered = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline < 0) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.trim().length === 0) continue;
        let msg: { id?: number };
        try {
          msg = JSON.parse(line) as { id?: number };
        } catch {
          continue;
        }
        if (typeof msg.id === 'number' && pending.has(msg.id)) {
          pending.get(msg.id)?.(msg as { result?: { content?: { text: string }[] } });
          pending.delete(msg.id);
        }
      }
    });
    let nextId = 1;
    const send = (method: string, params: unknown): Promise<{ result?: { content?: { text: string }[] } }> =>
      new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    const notify = (method: string, params: unknown): void => {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    };
    return { child, send, notify };
  }

  function payload(raw: { result?: { content?: { text: string }[] } }): Record<string, unknown> {
    const text = raw.result?.content?.[0]?.text;
    expect(typeof text).toBe('string');
    return JSON.parse(text as string) as Record<string, unknown>;
  }

  it('starts exactly one preflight process for one id, and the loser joins instead of spawning', async () => {
    // The counter file is the discriminator and the stub itself appends to it,
    // so a second `preflight` started by the OTHER OS process is counted even
    // though neither this test nor either server could observe it in memory.
    process.env.SOLUTION_PREFLIGHT_BIN = readyStub('stub-two-proc.sh', 2);
    const env = {
      ...process.env,
      SOLUTION_VERDICT_DIR: verdictDir(),
      HARNESS_HOME: harnessHomeTmp,
      SOLUTION_PREFLIGHT_BIN: process.env.SOLUTION_PREFLIGHT_BIN as string,
    };
    const a = startServer(env);
    const b = startServer(env);
    try {
      for (const c of [a, b]) {
        await c.send('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'two-proc-test', version: '0.0.0' },
        });
        c.notify('notifications/initialized', {});
      }

      // Fired without awaiting the first: whichever acquisition loses the
      // atomic mkdir gets ELOCKED, and ELOCKED means join, never spawn.
      const callA = a.send('tools/call', {
        name: 'solution_evaluate',
        arguments: { id: 'two-real-processes', repoPath: repo },
      });
      const callB = b.send('tools/call', {
        name: 'solution_evaluate',
        arguments: { id: 'two-real-processes', repoPath: repo },
      });
      const [rawA, rawB] = await Promise.all([callA, callB]);
      const outA = payload(rawA);
      const outB = payload(rawB);

      expect(invocations()).toBe(1);
      expect(countKind('two-real-processes', 'start')).toBe(1);

      const statuses = [outA.status, outB.status].sort();
      // One process ran it to completion; the other either joined it by
      // attemptId or answered running-unconfirmed, if it got there before the
      // winner had written its start record. Both are the join rule; neither
      // is a second run.
      expect(statuses).toContain('completed');
      const loser = outA.status === 'completed' ? outB : outA;
      const winner = outA.status === 'completed' ? outA : outB;
      expect(['running', 'running-unconfirmed']).toContain(loser.status);
      if (loser.status === 'running') expect(loser.attemptId).toBe(winner.attemptId);

      // The loser can look the winner's FOREIGN attemptId up across the
      // process boundary, out of the shared on-disk log.
      const loserClient = outA.status === 'completed' ? b : a;
      const lookedUp = payload(
        await loserClient.send('tools/call', {
          name: 'solution_evaluate_status',
          arguments: { id: 'two-real-processes', attemptId: winner.attemptId as string },
        }),
      );
      expect(lookedUp.status).toBe('completed');
      expect(lookedUp.attemptId).toBe(winner.attemptId);
    } finally {
      a.child.kill('SIGKILL');
      b.child.kill('SIGKILL');
    }
  }, 60_000);
});
