// Solution-acceptance gate core + producer.
//
// Core tests use an isolated SOLUTION_VERDICT_DIR so the host's real
// ~/.local/state/agent-grounding/ is never touched. Producer tests spin up a
// throwaway git repo and point SOLUTION_PREFLIGHT_BIN at a stub that emits
// fixture preflight JSON, so they need neither the real `preflight` binary nor
// a network.
//
// `writeVerdict` now always signs (verdict-signing.ts) which resolves +
// lazily creates a shared harness signing key under
// `<HARNESS_HOME>/harness.generated/`; every test here also isolates
// HARNESS_HOME to a tempdir so no test run ever reads or writes the host's
// real ~/.harness (or ~/.claude fallback).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  evaluateGate,
  evaluateSolution,
  readVerdict,
  sanitizeVerdictId,
  verdictDir,
  verdictPath,
  writeVerdict,
  type Verdict,
} from '../src/solution-verdict.js';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

function makeVerdict(over: Partial<Verdict> = {}): Verdict {
  return {
    id: 'task-1',
    head: HEAD_A,
    ready: true,
    confidence: 0.9,
    blockers: [],
    timestamp: '2026-05-30T00:00:00.000Z',
    source: 'preflight',
    ...over,
  };
}

let tmpDir: string;
let savedVerdictDir: string | undefined;
let harnessHomeTmp: string;
let savedHarnessHome: string | undefined;

beforeEach(() => {
  savedVerdictDir = process.env.SOLUTION_VERDICT_DIR;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solution-verdict-'));
  process.env.SOLUTION_VERDICT_DIR = tmpDir;

  savedHarnessHome = process.env.HARNESS_HOME;
  harnessHomeTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'solution-verdict-harness-home-'));
  process.env.HARNESS_HOME = harnessHomeTmp;
});

afterEach(() => {
  if (savedVerdictDir === undefined) delete process.env.SOLUTION_VERDICT_DIR;
  else process.env.SOLUTION_VERDICT_DIR = savedVerdictDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });

  if (savedHarnessHome === undefined) delete process.env.HARNESS_HOME;
  else process.env.HARNESS_HOME = savedHarnessHome;
  fs.rmSync(harnessHomeTmp, { recursive: true, force: true });
});

describe('sanitizeVerdictId', () => {
  it('keeps a clean id intact', () => {
    expect(sanitizeVerdictId('task-123_v2.1')).toBe('task-123_v2.1');
  });

  it('collapses a path-traversal id to a single safe segment inside verdictDir', () => {
    const id = '../../etc/passwd';
    expect(sanitizeVerdictId(id)).not.toContain('/');
    expect(sanitizeVerdictId(id)).not.toContain(path.sep);
    expect(path.dirname(verdictPath(id))).toBe(verdictDir());
  });

  it('rejects empty / dot-only ids', () => {
    expect(() => sanitizeVerdictId('')).toThrow();
    expect(() => sanitizeVerdictId('.')).toThrow();
    expect(() => sanitizeVerdictId('..')).toThrow();
  });
});

describe('writeVerdict / readVerdict', () => {
  it('round-trips a verdict', () => {
    const v = makeVerdict();
    expect(fs.existsSync(writeVerdict(v))).toBe(true);
    expect(readVerdict(v.id)).toEqual(v);
  });

  it('returns null for a missing verdict', () => {
    expect(readVerdict('never-written')).toBeNull();
  });

  it('returns null for a corrupt marker', () => {
    fs.mkdirSync(verdictDir(), { recursive: true });
    fs.writeFileSync(verdictPath('task-1'), '{ not json', 'utf8');
    expect(readVerdict('task-1')).toBeNull();
  });
});

describe('evaluateGate', () => {
  it('PASSES when a ready verdict exists at the current HEAD', () => {
    writeVerdict(makeVerdict({ ready: true, head: HEAD_A }));
    const r = evaluateGate('task-1', HEAD_A);
    expect(r.allowed).toBe(true);
    expect(r.reason).toContain('ready at HEAD');
  });

  it('DENIES when no verdict was recorded', () => {
    const r = evaluateGate('task-1', HEAD_A);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('no verdict recorded');
  });

  it('DENIES a not-ready verdict and surfaces the blockers', () => {
    writeVerdict(makeVerdict({ ready: false, blockers: ['test: 2 failing', 'lint: 1 error'] }));
    const r = evaluateGate('task-1', HEAD_A);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('not ready');
    expect(r.reason).toContain('test: 2 failing');
  });

  it('DENIES a stale verdict on HEAD drift', () => {
    writeVerdict(makeVerdict({ ready: true, head: HEAD_A }));
    const r = evaluateGate('task-1', HEAD_B);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('stale verdict');
    expect(r.reason).toContain(HEAD_A.slice(0, 7));
    expect(r.reason).toContain(HEAD_B.slice(0, 7));
  });

  it('DENIES when the current HEAD cannot be resolved', () => {
    writeVerdict(makeVerdict({ ready: true, head: HEAD_A }));
    const r = evaluateGate('task-1', null);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('cannot resolve current git HEAD');
  });

  it('a not-ready re-run overwrites a prior green verdict at the same HEAD', () => {
    writeVerdict(makeVerdict({ ready: true, head: HEAD_A }));
    expect(evaluateGate('task-1', HEAD_A).allowed).toBe(true);
    writeVerdict(makeVerdict({ ready: false, head: HEAD_A, blockers: ['test: regressed'] }));
    expect(evaluateGate('task-1', HEAD_A).allowed).toBe(false);
  });
});

describe('evaluateSolution (producer)', () => {
  let repo: string;
  let head: string;

  function writeStub(name: string, body: string): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, body, { mode: 0o755 });
    fs.chmodSync(p, 0o755);
    return p;
  }

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'solution-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t.local'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'readme.txt'), 'hello', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
    head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
  });

  afterEach(() => {
    delete process.env.SOLUTION_PREFLIGHT_BIN;
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('records a ready verdict pinned to HEAD from a ready preflight run', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-ready.sh',
      '#!/bin/sh\necho \'{"ready":true,"confidence":0.9,"blockers":[]}\'\n',
    );
    const res = await evaluateSolution('task-1', repo, { timestamp: '2026-05-30T00:00:00.000Z' });
    expect(res.error).toBeUndefined();
    expect(res.verdict).toMatchObject({ id: 'task-1', head, ready: true, source: 'preflight' });
    // and the gate passes at that HEAD
    expect(evaluateGate('task-1', head).allowed).toBe(true);
  });

  it('invalidates a same-id ready marker when an exit-2 ready payload fails re-evaluation, without touching another id', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-ready-then-exit2.sh',
      '#!/bin/sh\necho \'{"ready":true,"confidence":0.9,"blockers":[]}\'\n',
    );
    expect((await evaluateSolution('task-1', repo)).verdict?.ready).toBe(true);
    writeVerdict(makeVerdict({ id: 'other-id', head }));

    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-exit2-ready.sh',
      '#!/bin/sh\necho \'{"ready":true,"confidence":0.9,"blockers":[]}\'\nexit 2\n',
    );
    const res = await evaluateSolution('task-1', repo);

    expect(res.verdict).toBeNull();
    expect(res.markerPath).toBeNull();
    expect(res.error).toContain('invalid execution outcome');
    expect(res.diagnostics).toMatchObject({ availability: 'available', execution: { exitCode: 2, signal: null } });
    expect(evaluateGate('task-1', head).allowed).toBe(false);
    expect(evaluateGate('other-id', head).allowed).toBe(true);
    expect(verdictPath('task-1')).not.toBe(verdictPath('other-id'));
  });

  it('returns complete diagnostics with the original acknowledged payload while keeping it out of the marker', async () => {
    const payload = {
      ready: true,
      confidence: 0.9,
      checks: [
        {
          name: 'test',
          kind: 'test',
          status: 'acknowledged',
          message: 'linux-only suite failed — acknowledged: CI covers it',
          details: ['full output: /tmp/preflight-test.log'],
          durationMs: 12,
          confidenceContribution: 0.1,
        },
      ],
      blockers: [],
      warnings: [],
      limitations: ['test failure acknowledged: CI covers it'],
      durationMs: 12,
      timestamp: '2026-05-30T00:00:00.000Z',
      additiveField: { preserved: true },
    };
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-complete-diagnostics.sh',
      `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(payload)}'\n`,
    );
    const res = await evaluateSolution('task-1', repo);
    expect(res.diagnostics).toMatchObject({
      availability: 'available',
      complete: true,
      execution: { exitCode: 0, signal: null },
      payload,
    });
    expect(res.diagnostics.issues).toEqual([]);
    const onDisk = JSON.parse(fs.readFileSync(res.markerPath as string, 'utf8'));
    expect(onDisk).not.toHaveProperty('diagnostics');
    expect(onDisk).not.toHaveProperty('additiveField');
  });

  it('marks an acknowledged check without its reason incomplete', async () => {
    const payload = {
      ready: true, confidence: 0.9,
      checks: [{ name: 'test', kind: 'test', status: 'acknowledged', durationMs: 2, confidenceContribution: 0 }],
      blockers: [], warnings: [], limitations: [], durationMs: 2, timestamp: '2026-05-30T00:00:00.000Z',
    };
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-unexplained-acknowledged.sh',
      `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(payload)}'\n`,
    );
    const res = await evaluateSolution('task-1', repo);
    expect(res.diagnostics).toMatchObject({ availability: 'available', complete: false });
    expect(res.diagnostics?.issues).toContain('checks[0].acknowledged status is missing its reason in message');
  });

  it('the MCP response verdict is pre-signing (no alg/signature); the written marker carries both (G4, R2-L1/L2)', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-ready-signed.sh',
      '#!/bin/sh\necho \'{"ready":true,"confidence":0.9,"blockers":[]}\'\n',
    );
    const res = await evaluateSolution('task-1', repo, { timestamp: '2026-05-30T00:00:00.000Z' });
    expect(res.error).toBeUndefined();
    expect(res.markerPath).not.toBeNull();

    // Response divergence, documented on `EvaluateResult` and in the README's
    // "Solution-acceptance gate" section: the MCP response's `verdict` is the
    // PRE-SIGNING object `writeVerdict` was called with, not the signed
    // marker it wrote to disk.
    expect(res.verdict).not.toHaveProperty('alg');
    expect(res.verdict).not.toHaveProperty('signature');

    // The on-disk marker DOES carry both, added by `writeVerdict`'s call to
    // `signVerdict`. Deliberately read the raw file here, not `readVerdict()`
    // — `readVerdict` reconstructs a fresh 7-key object (solution-verdict.ts)
    // and would silently drop `alg`/`signature` even if the file has them, so
    // it can't tell "written but stripped on read" apart from "never
    // written". Reading the file is what actually pins the divergence this
    // test exists to catch.
    const onDisk = JSON.parse(fs.readFileSync(res.markerPath as string, 'utf8'));
    expect(onDisk).toHaveProperty('alg');
    expect(onDisk).toHaveProperty('signature');
    expect(typeof onDisk.alg).toBe('string');
    expect(typeof onDisk.signature).toBe('string');
  });

  it('records a not-ready verdict even when preflight exits non-zero (JSON on stdout)', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-notready.sh',
      '#!/bin/sh\necho \'{"ready":false,"confidence":0.4,"blockers":["test: 1 failing"]}\'\nexit 1\n',
    );
    const res = await evaluateSolution('task-1', repo);
    expect(res.error).toBeUndefined();
    expect(res.verdict?.ready).toBe(false);
    expect(res.verdict?.blockers).toContain('test: 1 failing');
    expect(evaluateGate('task-1', head).allowed).toBe(false);
  });

  it('reports an exit-1 not-ready complete diagnostic', async () => {
    const payload = {
      ready: false,
      confidence: 0.4,
      checks: [{ name: 'test', kind: 'test', status: 'fail', durationMs: 4, confidenceContribution: 0 }],
      blockers: ['test: 1 failing'],
      warnings: [],
      limitations: [],
      durationMs: 4,
      timestamp: '2026-05-30T00:00:00.000Z',
    };
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-complete-notready.sh',
      `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(payload)}'\nexit 1\n`,
    );
    const res = await evaluateSolution('task-1', repo);
    expect(res.verdict?.ready).toBe(false);
    expect(res.diagnostics).toMatchObject({
      availability: 'available',
      complete: true,
      execution: { exitCode: 1, signal: null },
    });
  });

  it('fails closed (error, no marker) when the preflight binary is missing', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = path.join(tmpDir, 'does-not-exist-preflight');
    const res = await evaluateSolution('task-1', repo);
    expect(res.verdict).toBeNull();
    expect(res.markerPath).toBeNull();
    expect(res.error).toContain('preflight binary not found');
    expect(readVerdict('task-1')).toBeNull();
    expect(res.diagnostics).toMatchObject({ availability: 'unavailable', complete: false });
  });

  it('invalidates a prior ready marker when HEAD resolution prevents a new preflight launch', async () => {
    writeVerdict(makeVerdict({ id: 'task-no-head', ready: true, head }));
    const res = await evaluateSolution('task-no-head', path.join(tmpDir, 'not-a-repo'));
    expect(res.verdict).toBeNull();
    expect(res.error).toContain('cannot resolve a committed git HEAD');
    expect(res.diagnostics).toMatchObject({ availability: 'unavailable', execution: { exitCode: null, signal: null } });
    expect(evaluateGate('task-no-head', head).allowed).toBe(false);
  });

  it('returns an error for an invalid id without throwing', async () => {
    const res = await evaluateSolution('..', repo);
    expect(res.verdict).toBeNull();
    expect(res.error).toContain('invalid verdict id');
  });

  it('fails closed when preflight exits non-zero with unparseable output', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-garbage.sh',
      '#!/bin/sh\necho "not json at all"\nexit 1\n',
    );
    const res = await evaluateSolution('task-1', repo);
    expect(res.verdict).toBeNull();
    expect(res.markerPath).toBeNull();
    expect(res.error).toContain('not parseable JSON');
    expect(readVerdict('task-1')).toBeNull();
    expect(res.diagnostics).toMatchObject({ availability: 'unavailable', complete: false, execution: { exitCode: 1 } });
  });

  it('records exit 0 when malformed output is unavailable', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub('stub-garbage-exit0.sh', '#!/bin/sh\necho not-json\n');
    const res = await evaluateSolution('task-1', repo);
    expect(res.error).toContain('not parseable JSON');
    expect(res.diagnostics).toMatchObject({ availability: 'unavailable', complete: false, execution: { exitCode: 0, signal: null } });
  });

  it.each(['null', '1', '[]'])('rejects a parseable non-object JSON payload %s with its captured diagnostics', async (scalar) => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub('stub-scalar.sh', `#!/bin/sh\necho '${scalar}'\n`);
    const res = await evaluateSolution('task-1', repo);
    expect(res.verdict).toBeNull();
    expect(res.error).toContain('invalid verdict core');
    expect(res.diagnostics).toMatchObject({ availability: 'available', complete: false, payload: JSON.parse(scalar) });
    expect(res.diagnostics?.issues).toContain('preflight JSON payload must be an object');
  });

  it('rejects a signal termination while preserving its payload and signal diagnostics', async () => {
    const payload = {
      ready: true, confidence: 0.9,
      checks: [{ name: 'lint', kind: 'lint', status: 'pass', durationMs: 1, confidenceContribution: 0.1 }],
      blockers: [], warnings: [], limitations: [], durationMs: 1, timestamp: '2026-05-30T00:00:00.000Z',
    };
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-signal.sh',
      `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(payload)}'\nkill -TERM $$\n`,
    );
    const res = await evaluateSolution('task-1', repo);
    expect(res.verdict).toBeNull();
    expect(res.error).toContain('invalid execution outcome');
    expect(res.diagnostics).toMatchObject({ availability: 'available', complete: false, execution: { signal: 'SIGTERM' }, payload });
    expect(res.diagnostics?.issues).toContain('preflight ended with signal SIGTERM');
  });

  it('fails closed when preflight exits non-zero with no output', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub('stub-empty.sh', '#!/bin/sh\nexit 1\n');
    const res = await evaluateSolution('task-1', repo);
    expect(res.verdict).toBeNull();
    expect(res.markerPath).toBeNull();
    expect(res.error).toContain('preflight invocation failed');
    expect(readVerdict('task-1')).toBeNull();
    expect(res.diagnostics).toMatchObject({ availability: 'unavailable', complete: false, execution: { exitCode: 1 } });
  });

  it('rejects a valid ready core when max-buffer reports an execution error', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-max-buffer.sh',
      '#!/bin/sh\nprintf \'%s\' \'{"ready":true,"confidence":0.9,"blockers":[]}\'\nhead -c 17000000 /dev/zero | tr \'\\000\' \' \'\n',
    );
    const res = await evaluateSolution('task-1', repo);
    expect(res.verdict).toBeNull();
    expect(res.markerPath).toBeNull();
    expect(res.error).toContain('invalid execution outcome');
    expect(res.diagnostics).toMatchObject({
      availability: 'available',
      payload: { ready: true, confidence: 0.9, blockers: [] },
      execution: { error: expect.any(String) },
    });
  });

  it('keeps missing advisory fields available without making them a new verdict gate policy', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-incomplete.sh',
      '#!/bin/sh\necho \'{"ready":true,"confidence":0.9,"blockers":[]}\'\n',
    );
    const res = await evaluateSolution('task-1', repo);
    expect(res.verdict?.ready).toBe(true);
    expect(res.diagnostics).toMatchObject({ availability: 'available', complete: false, execution: { exitCode: 0 } });
    expect(res.diagnostics.issues).toContain('preflight checks must be an array');
  });

  it('rejects an anomalous exit code with otherwise valid ready JSON', async () => {
    const payload = {
      ready: true,
      confidence: 0.9,
      checks: [{ name: 'lint', kind: 'lint', status: 'pass', durationMs: 4, confidenceContribution: 0.1 }],
      blockers: [],
      warnings: [],
      limitations: [],
      durationMs: 4,
      timestamp: '2026-05-30T00:00:00.000Z',
    };
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-exit2-ready.sh',
      `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(payload)}'\nexit 2\n`,
    );
    const res = await evaluateSolution('task-1', repo);
    expect(res.verdict).toBeNull();
    expect(res.error).toContain('invalid execution outcome');
    expect(res.diagnostics).toMatchObject({ availability: 'available', complete: false, execution: { exitCode: 2 } });
    expect(res.diagnostics.issues).toContain('preflight ready=true requires exit code 0, got 2');
  });

  it.each([
    ['ready with exit 1', '{"ready":true,"confidence":0.9,"blockers":[]}', 1],
    ['not-ready with exit 0', '{"ready":false,"confidence":0.4,"blockers":["test failed"]}', 0],
    ['not-ready with exit 2', '{"ready":false,"confidence":0.4,"blockers":["test failed"]}', 2],
  ])('rejects %s as an invalid execution outcome', async (_name, payload, exitCode) => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      `stub-outcome-${exitCode}.sh`,
      `#!/bin/sh\necho '${payload}'\nexit ${exitCode}\n`,
    );
    const res = await evaluateSolution('task-1', repo);
    expect(res.verdict).toBeNull();
    expect(res.error).toContain('invalid execution outcome');
    expect(res.diagnostics).toMatchObject({ execution: { exitCode, signal: null } });
  });

  it.each([
    ['missing ready', '{"confidence":0.9,"blockers":[]}', 'ready'],
    ['non-boolean ready', '{"ready":"yes","confidence":0.9,"blockers":[]}', 'ready'],
    ['missing confidence', '{"ready":true,"blockers":[]}', 'confidence'],
    ['negative confidence', '{"ready":true,"confidence":-0.1,"blockers":[]}', 'confidence'],
    ['non-finite confidence', '{"ready":true,"confidence":1e400,"blockers":[]}', 'confidence'],
    ['out-of-range confidence', '{"ready":true,"confidence":1.1,"blockers":[]}', 'confidence'],
    ['missing blockers', '{"ready":true,"confidence":0.9}', 'blockers'],
    ['non-string blocker', '{"ready":false,"confidence":0.4,"blockers":[42]}', 'blockers'],
    ['ready with blockers', '{"ready":true,"confidence":0.9,"blockers":["contradiction"]}', 'empty blockers'],
  ])('rejects an invalid verdict core: %s', async (_name, payload, expectedError) => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub('stub-invalid-core.sh', `#!/bin/sh\necho '${payload}'\n`);
    const res = await evaluateSolution('task-1', repo);
    expect(res.verdict).toBeNull();
    expect(res.markerPath).toBeNull();
    expect(res.error).toContain('invalid verdict core');
    expect(res.error).toContain(expectedError);
    expect(res.diagnostics).toMatchObject({ availability: 'available', payload: JSON.parse(payload) });
  });

  it('surfaces marker invalidation I/O failure and documents that the previous marker may remain', async () => {
    writeVerdict(makeVerdict({ id: 'task-1', head }));
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub('stub-invalid-after-lock.sh', '#!/bin/sh\necho not-json\nexit 2\n');
    const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
    try {
      const res = await evaluateSolution('task-1', repo);
      expect(res.verdict).toBeNull();
      expect(res.error).toContain('could not invalidate existing verdict marker');
      expect(res.error).toContain('previous marker may remain');
    } finally {
      unlink.mockRestore();
    }
  });

  it('keeps a previous marker invalidated when signing fails after a valid preflight', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub('stub-ready-before-sign-fail.sh', '#!/bin/sh\necho \'{"ready":true,"confidence":0.9,"blockers":[]}\'\n');
    expect((await evaluateSolution('task-1', repo)).verdict?.ready).toBe(true);
    const savedKey = process.env.SOLUTION_VERDICT_SIGNING_KEY;
    process.env.SOLUTION_VERDICT_SIGNING_KEY = path.join(tmpDir, 'missing-parent', 'key');
    fs.mkdirSync(path.join(tmpDir, 'missing-parent'));
    fs.chmodSync(path.join(tmpDir, 'missing-parent'), 0o500);
    try {
      const res = await evaluateSolution('task-1', repo);
      expect(res.verdict).toBeNull();
      expect(res.error).toContain('could not write verdict marker');
      expect(evaluateGate('task-1', head).allowed).toBe(false);
    } finally {
      fs.chmodSync(path.join(tmpDir, 'missing-parent'), 0o700);
      if (savedKey === undefined) delete process.env.SOLUTION_VERDICT_SIGNING_KEY;
      else process.env.SOLUTION_VERDICT_SIGNING_KEY = savedKey;
    }
  });

  it('keeps a previous marker invalidated when the final marker write fails', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub('stub-ready-before-write-fail.sh', '#!/bin/sh\necho \'{"ready":true,"confidence":0.9,"blockers":[]}\'\n');
    expect((await evaluateSolution('task-1', repo)).verdict?.ready).toBe(true);
    // The first evaluation created the signing key, so this spy reaches only
    // the second evaluation's final marker write.
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('injected final marker write failure');
    });
    try {
      const res = await evaluateSolution('task-1', repo);
      expect(res.verdict).toBeNull();
      expect(res.error).toContain('could not write verdict marker');
      expect(evaluateGate('task-1', head).allowed).toBe(false);
    } finally {
      write.mockRestore();
    }
  });

  it('does not start preflight before id and HEAD validation, then invokes it exactly once', async () => {
    const counter = path.join(tmpDir, 'preflight-count');
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-counter.sh',
      `#!/bin/sh\nprintf x >> '${counter}'\necho '{"ready":true,"confidence":0.9,"blockers":[]}'\n`,
    );
    await evaluateSolution('..', repo);
    expect(fs.existsSync(counter)).toBe(false);
    await evaluateSolution('task-no-head', path.join(tmpDir, 'not-a-repo'));
    expect(fs.existsSync(counter)).toBe(false);
    await evaluateSolution('task-1', repo);
    expect(fs.readFileSync(counter, 'utf8')).toBe('x');
  });
});

describe('evaluateSolution (producer) — orchestrator-workflow arm', () => {
  // The 7 keys the harness consumer pins on the verdict marker. OW state must
  // flow ONLY through `ready` + `blockers`, never as a new field.
  const VERDICT_KEYS = [
    'blockers',
    'confidence',
    'head',
    'id',
    'ready',
    'source',
    'timestamp',
  ];

  const GREEN_STUB = '#!/bin/sh\necho \'{"ready":true,"confidence":0.9,"blockers":[]}\'\n';
  const RED_STUB =
    '#!/bin/sh\necho \'{"ready":false,"confidence":0.4,"blockers":["test: 1 failing"]}\'\nexit 1\n';

  let repo: string;
  let head: string;

  function writeStub(name: string, body: string): string {
    const p = path.join(tmpDir, name);
    fs.writeFileSync(p, body, { mode: 0o755 });
    fs.chmodSync(p, 0o755);
    return p;
  }

  /** Write an OW run dir (handoff + review + goal) into the repo working tree. */
  function makeRun(
    runName: string,
    files: { handoff?: string; review?: string; goal?: string },
  ): void {
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
  }

  /**
   * Run dir name dated to the fixture repo's HEAD commit author date, so the
   * legacy date heuristic reads the run as created alongside the change
   * (timezone-safe: both dates come from the same commit).
   */
  function freshRunName(): string {
    const date = execFileSync('git', ['log', '-1', '--format=%ad', '--date=format:%Y-%m-%d'], {
      cwd: repo,
    })
      .toString()
      .trim();
    return `${date}-run`;
  }

  function handoff(finalStatus: string): string {
    return [
      '# Operator Handoff',
      '',
      '## Final Status',
      '',
      `<!-- solution-acceptance: final-status = ${finalStatus} -->`,
      finalStatus,
      '',
    ].join('\n');
  }

  function review(recommendation: string): string {
    return [
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
      `<!-- solution-acceptance: acceptance-recommendation = ${recommendation} -->`,
      recommendation,
      '',
    ].join('\n');
  }

  /** A complete, freshly-dated OW run: accepted handoff + accept review. */
  function makeCompleteRun(): void {
    makeRun(freshRunName(), { handoff: handoff('accepted'), review: review('accept') });
  }

  function writeKnob(value: string): void {
    fs.mkdirSync(path.join(repo, '.ai'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.ai', 'solution-acceptance.json'),
      `${JSON.stringify({ orchestratorWorkflow: value })}\n`,
      'utf8',
    );
  }

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'solution-ow-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t.local'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'readme.txt'), 'hello', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
    head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
  });

  afterEach(() => {
    delete process.env.SOLUTION_PREFLIGHT_BIN;
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('backward-compat: no .ai/runs + green preflight → ready, blockers identical (empty)', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub('stub-green.sh', GREEN_STUB);
    const res = await evaluateSolution('task-1', repo);
    expect(res.error).toBeUndefined();
    expect(res.verdict?.ready).toBe(true);
    // byte-identical to the pre-OW output: preflight's blockers ([]) unchanged.
    expect(res.verdict?.blockers).toEqual([]);
    expect(evaluateGate('task-1', head).allowed).toBe(true);
  });

  it('OW run present + green preflight + complete run → ready', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub('stub-green.sh', GREEN_STUB);
    makeCompleteRun();
    const res = await evaluateSolution('task-1', repo);
    expect(res.error).toBeUndefined();
    expect(res.verdict?.ready).toBe(true);
    expect(res.verdict?.blockers).toEqual([]);
  });

  it('OW run present + green preflight + blocked handoff → not ready, OW blocker surfaced', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub('stub-green.sh', GREEN_STUB);
    makeRun(freshRunName(), { handoff: handoff('blocked'), review: review('accept') });
    const res = await evaluateSolution('task-1', repo);
    expect(res.error).toBeUndefined();
    expect(res.verdict?.ready).toBe(false);
    expect(res.verdict?.blockers.some((b) => /orchestrator-workflow/.test(b))).toBe(true);
    expect(res.diagnostics).toMatchObject({
      availability: 'available',
      complete: false,
      payload: { ready: true, confidence: 0.9, blockers: [] },
    });
    expect(evaluateGate('task-1', head).allowed).toBe(false);
  });

  it('red preflight + complete OW run → not ready (preflight still gates)', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub('stub-red.sh', RED_STUB);
    makeCompleteRun();
    const res = await evaluateSolution('task-1', repo);
    expect(res.error).toBeUndefined();
    expect(res.verdict?.ready).toBe(false);
    expect(res.verdict?.blockers).toContain('test: 1 failing');
  });

  it("knob 'off' + green preflight + blocked handoff → ready (OW never gates)", async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub('stub-green.sh', GREEN_STUB);
    makeRun(freshRunName(), { handoff: handoff('blocked'), review: review('fix_required') });
    writeKnob('off');
    const res = await evaluateSolution('task-1', repo);
    expect(res.error).toBeUndefined();
    expect(res.verdict?.ready).toBe(true);
    expect(res.verdict?.blockers).toEqual([]);
  });

  it("knob 'on' + no .ai/runs → not ready with the on-but-no-runs blocker", async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub('stub-green.sh', GREEN_STUB);
    writeKnob('on');
    const res = await evaluateSolution('task-1', repo);
    expect(res.error).toBeUndefined();
    expect(res.verdict?.ready).toBe(false);
    const blocker = res.verdict?.blockers.find((b) => /orchestrator-workflow/.test(b));
    expect(blocker).toBeDefined();
    expect(blocker).toContain(
      'enforcement is on but no OW run was found (no .ai/run pointer and no .ai/runs/ run directory)',
    );
  });

  it("knob 'on' + complete OW run + green preflight → ready (enforced run passes)", async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub('stub-green.sh', GREEN_STUB);
    writeKnob('on');
    makeCompleteRun();
    const res = await evaluateSolution('task-1', repo);
    expect(res.error).toBeUndefined();
    expect(res.verdict?.ready).toBe(true);
    expect(res.verdict?.blockers).toEqual([]);
    expect(evaluateGate('task-1', head).allowed).toBe(true);
  });

  it('valid knob JSON with a bogus value fails SAFE to auto (still gates when a run is present)', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub('stub-green.sh', GREEN_STUB);
    makeRun(freshRunName(), { handoff: handoff('blocked'), review: review('accept') });
    // valid JSON, but orchestratorWorkflow is not one of auto/on/off → must
    // resolve to 'auto' (fail-safe), NOT silently disable the OW arm.
    writeKnob('nonsense');
    const res = await evaluateSolution('task-1', repo);
    expect(res.error).toBeUndefined();
    expect(res.verdict?.ready).toBe(false);
    expect(res.verdict?.blockers.some((b) => /orchestrator-workflow/.test(b))).toBe(true);
  });

  it('malformed knob file fails SAFE to auto (still gates when a run is present)', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub('stub-green.sh', GREEN_STUB);
    makeRun(freshRunName(), { handoff: handoff('blocked'), review: review('accept') });
    fs.mkdirSync(path.join(repo, '.ai'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.ai', 'solution-acceptance.json'), '{ not json', 'utf8');
    const res = await evaluateSolution('task-1', repo);
    expect(res.verdict?.ready).toBe(false);
    expect(res.verdict?.blockers.some((b) => /orchestrator-workflow/.test(b))).toBe(true);
  });

  it('staleness repro (fail-open fix): old COMPLETE run + new commits, no new run → not ready', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub('stub-green.sh', GREEN_STUB);
    // The run is complete and was legitimately accepted once — but it is dated
    // before the current change's commits and carries no run-base binding, so
    // no OW run claims THIS change. Pre-fix this produced ready:true forever.
    makeRun('2026-06-20-old', { handoff: handoff('accepted'), review: review('accept') });
    const res = await evaluateSolution('task-1', repo);
    expect(res.error).toBeUndefined();
    expect(res.verdict?.ready).toBe(false);
    const blocker = res.verdict?.blockers.find((b) => /orchestrator-workflow/.test(b));
    expect(blocker).toBeDefined();
    expect(blocker).toContain('no OW run claims this change');
    expect(evaluateGate('task-1', head).allowed).toBe(false);
  });

  it('a run-base marker bound to HEAD beats the date heuristic (old dir name, valid marker → ready)', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub('stub-green.sh', GREEN_STUB);
    makeRun('2026-06-20-old', {
      handoff: handoff('accepted'),
      review: review('accept'),
      goal: `# Goal\n\n<!-- solution-acceptance: run-base = ${head} -->\n`,
    });
    const res = await evaluateSolution('task-1', repo);
    expect(res.error).toBeUndefined();
    expect(res.verdict?.ready).toBe(true);
    expect(res.verdict?.blockers).toEqual([]);
  });

  it('parity guard: the verdict still carries exactly the 7 pinned keys', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub('stub-green.sh', GREEN_STUB);
    makeRun(freshRunName(), { handoff: handoff('blocked'), review: review('accept') });
    const res = await evaluateSolution('task-1', repo);
    expect(res.verdict).not.toBeNull();
    expect(Object.keys(res.verdict as object).sort()).toEqual(VERDICT_KEYS);
    // the on-disk marker carries the same shape (no smuggled OW field)
    const onDisk = readVerdict('task-1');
    expect(Object.keys(onDisk as object).sort()).toEqual(VERDICT_KEYS);
  });

  it('preflight absent still fails closed even with an OW run present (unchanged)', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = path.join(tmpDir, 'does-not-exist-preflight');
    makeCompleteRun();
    const res = await evaluateSolution('task-1', repo);
    expect(res.verdict).toBeNull();
    expect(res.markerPath).toBeNull();
    expect(res.error).toContain('preflight binary not found');
    expect(readVerdict('task-1')).toBeNull();
  });
});
