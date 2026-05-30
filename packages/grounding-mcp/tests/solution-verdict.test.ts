// Solution-acceptance gate core + producer.
//
// Core tests use an isolated SOLUTION_VERDICT_DIR so the host's real
// ~/.local/state/agent-grounding/ is never touched. Producer tests spin up a
// throwaway git repo and point SOLUTION_PREFLIGHT_BIN at a stub that emits
// fixture preflight JSON, so they need neither the real `preflight` binary nor
// a network.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

beforeEach(() => {
  savedVerdictDir = process.env.SOLUTION_VERDICT_DIR;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solution-verdict-'));
  process.env.SOLUTION_VERDICT_DIR = tmpDir;
});

afterEach(() => {
  if (savedVerdictDir === undefined) delete process.env.SOLUTION_VERDICT_DIR;
  else process.env.SOLUTION_VERDICT_DIR = savedVerdictDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
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

  it('fails closed (error, no marker) when the preflight binary is missing', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = path.join(tmpDir, 'does-not-exist-preflight');
    const res = await evaluateSolution('task-1', repo);
    expect(res.verdict).toBeNull();
    expect(res.markerPath).toBeNull();
    expect(res.error).toContain('preflight binary not found');
    expect(readVerdict('task-1')).toBeNull();
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
  });

  it('fails closed when preflight exits non-zero with no output', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub('stub-empty.sh', '#!/bin/sh\nexit 1\n');
    const res = await evaluateSolution('task-1', repo);
    expect(res.verdict).toBeNull();
    expect(res.markerPath).toBeNull();
    expect(res.error).toContain('preflight invocation failed');
    expect(readVerdict('task-1')).toBeNull();
  });
});
