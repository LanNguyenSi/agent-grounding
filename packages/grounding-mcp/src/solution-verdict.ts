// Solution-acceptance gate (v1, deterministic floor).
//
// Makes "done" earned rather than claimed: a verdict is derived from a real
// `preflight` run (the agent-preflight check battery: lint / typecheck / test
// / audit / secret exit codes), pinned to the git HEAD it was produced at, and
// written to a marker the solving agent's normal write path does not produce.
// The gate then passes only when a ready verdict exists at the *current* HEAD.
//
// Anti-hacking contract:
//   1. Derived, not claimed: `ready` comes from preflight's real run; the
//      caller supplies no result.
//   2. Producer != solver: `evaluateSolution` RUNS preflight; the check set
//      is taken from the repo's committed `.preflight.json`, not from arguments,
//      so an agent cannot weaken the gate at call time.
//   3. HEAD-pinned: a verdict counts only at the HEAD it was produced
//      at; any rework shifts HEAD and invalidates a green verdict.
//   4. No stale green: a not-ready run overwrites a prior green marker.
//
// The verdict marker lives OUTSIDE the agent-writable evidence-ledger on
// purpose: a ledger row is forgeable via `ledger_add` (the lesson behind
// understanding-gate moving its signal to a marker file). Documented residual:
// a shell-capable agent could still hand-write the marker file; closing that
// (signing, or a harness-owned dir checked by a PreToolUse hook) is the harness
// wiring follow-up.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface Verdict {
  /** Caller-supplied identifier the gate is scoped to (e.g. a task id). */
  id: string;
  /** 40-hex git HEAD sha the verdict was produced at. */
  head: string;
  /** Derived from a real preflight run: true iff there were no blockers. */
  ready: boolean;
  /** Preflight confidence score (0.0 - 1.0). */
  confidence: number;
  /** Blocker messages from the run (empty when ready). */
  blockers: string[];
  /** ISO timestamp the verdict was recorded. */
  timestamp: string;
  /** Which evidence producer derived the verdict (e.g. "preflight"). */
  source: string;
}

export interface GateResult {
  allowed: boolean;
  reason: string;
  verdict: Verdict | null;
  currentHead: string | null;
}

export interface EvaluateResult {
  verdict: Verdict | null;
  markerPath: string | null;
  error?: string;
}

/**
 * Directory verdict markers live in. Resolution order:
 *   1. SOLUTION_VERDICT_DIR (explicit override; used by tests)
 *   2. $XDG_STATE_HOME/agent-grounding/solution-verdicts
 *   3. ~/.local/state/agent-grounding/solution-verdicts
 *
 * Deliberately outside the repo working tree and outside the evidence-ledger,
 * so a verdict is not something the agent edits as part of its solution diff.
 */
export function verdictDir(): string {
  const override = process.env.SOLUTION_VERDICT_DIR;
  if (override && override.trim().length > 0) return override;
  const xdgState = process.env.XDG_STATE_HOME;
  const base =
    xdgState && xdgState.trim().length > 0 ? xdgState : path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'agent-grounding', 'solution-verdicts');
}

/**
 * Reduce a verdict id to a single safe path segment. Non-portable characters
 * collapse to `_`, and `path.basename` strips any residual separator so the id
 * can never escape `verdictDir()` (path-traversal guard). Empty / dot-only ids
 * are rejected.
 */
export function sanitizeVerdictId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, '_');
  const base = path.basename(cleaned);
  if (base === '' || base === '.' || base === '..') {
    throw new Error(`invalid verdict id: ${JSON.stringify(id)}`);
  }
  return base;
}

export function verdictPath(id: string): string {
  return path.join(verdictDir(), `${sanitizeVerdictId(id)}.json`);
}

/**
 * Current committed git HEAD sha (40-hex), or null when it can't be determined
 * (not a git repo, no commits, git missing). The gate treats a null HEAD as
 * "cannot confirm at-HEAD" and denies.
 */
export async function getHeadSha(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoPath });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Write (or overwrite) the verdict marker. Returns its path. */
export function writeVerdict(verdict: Verdict): string {
  const target = verdictPath(verdict.id);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(verdict, null, 2)}\n`, 'utf8');
  return target;
}

/** Read the verdict marker for an id, or null when absent / unparseable. */
export function readVerdict(id: string): Verdict | null {
  let raw: string;
  try {
    raw = fs.readFileSync(verdictPath(id), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Verdict>;
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.head !== 'string' ||
      typeof parsed.ready !== 'boolean'
    ) {
      return null;
    }
    return {
      id: parsed.id,
      head: parsed.head,
      ready: parsed.ready,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      blockers: Array.isArray(parsed.blockers) ? parsed.blockers : [],
      timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : '',
      source: typeof parsed.source === 'string' ? parsed.source : '',
    };
  } catch {
    return null;
  }
}

/**
 * Evaluate the gate for an id at the current HEAD. Passes only when a ready
 * verdict exists AND was produced at exactly `currentHead`.
 */
export function evaluateGate(id: string, currentHead: string | null): GateResult {
  const verdict = readVerdict(id);
  if (!verdict) {
    return {
      allowed: false,
      reason: `no verdict recorded for "${id}" (run solution_evaluate first)`,
      verdict: null,
      currentHead,
    };
  }
  if (!verdict.ready) {
    const why = verdict.blockers.length > 0 ? `: ${verdict.blockers.join('; ')}` : '';
    return {
      allowed: false,
      reason: `verdict for "${id}" is not ready${why} (fix and re-run solution_evaluate)`,
      verdict,
      currentHead,
    };
  }
  if (currentHead === null) {
    return {
      allowed: false,
      reason: `cannot resolve current git HEAD to confirm the verdict for "${id}" is at HEAD`,
      verdict,
      currentHead,
    };
  }
  if (verdict.head !== currentHead) {
    return {
      allowed: false,
      reason: `stale verdict for "${id}": recorded at ${verdict.head.slice(0, 7)}, current HEAD ${currentHead.slice(0, 7)} (re-run solution_evaluate)`,
      verdict,
      currentHead,
    };
  }
  return {
    allowed: true,
    reason: `verdict for "${id}" is ready at HEAD ${currentHead.slice(0, 7)} (confidence ${Math.round(verdict.confidence * 100)}%)`,
    verdict,
    currentHead,
  };
}

interface PreflightJson {
  ready: boolean;
  confidence: number;
  blockers: string[];
}

function parsePreflightJson(stdout: string): PreflightJson {
  const parsed = JSON.parse(stdout) as Partial<PreflightJson>;
  if (typeof parsed.ready !== 'boolean') {
    throw new Error("preflight JSON is missing a boolean 'ready' field");
  }
  return {
    ready: parsed.ready,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
    blockers: Array.isArray(parsed.blockers) ? parsed.blockers : [],
  };
}

/**
 * Producer: run `preflight run <repoPath> --json` and record a HEAD-pinned
 * verdict for `id` derived from its result. The verb running this is the
 * producer; the agent supplies no results and cannot weaken the check set
 * (it comes from the repo's committed `.preflight.json`). preflight exits
 * non-zero when not ready but still prints its JSON, so a non-zero exit with
 * parseable stdout is a normal not-ready verdict, not a failure.
 *
 * Fails closed: when preflight is absent or its output is unusable, returns an
 * `error` and writes NO marker (so the gate stays closed via "no verdict").
 */
export async function evaluateSolution(
  id: string,
  repoPath: string,
  opts: { timestamp?: string } = {},
): Promise<EvaluateResult> {
  try {
    sanitizeVerdictId(id);
  } catch (err) {
    return { verdict: null, markerPath: null, error: (err as Error).message };
  }

  const head = await getHeadSha(repoPath);
  if (!head) {
    return {
      verdict: null,
      markerPath: null,
      error:
        'cannot resolve a committed git HEAD; solution-acceptance requires a git repository with at least one commit',
    };
  }

  const bin = process.env.SOLUTION_PREFLIGHT_BIN ?? 'preflight';
  let pf: PreflightJson;
  try {
    const { stdout } = await execFileAsync(bin, ['run', repoPath, '--json'], {
      maxBuffer: 16 * 1024 * 1024,
    });
    pf = parsePreflightJson(stdout);
  } catch (err) {
    const e = err as { code?: string; stdout?: string };
    if (e.code === 'ENOENT') {
      return {
        verdict: null,
        markerPath: null,
        error: `preflight binary not found (\`${bin}\`); install @lannguyensi/agent-preflight or set SOLUTION_PREFLIGHT_BIN`,
      };
    }
    // preflight exits 1 when not ready but prints JSON to stdout first.
    if (typeof e.stdout === 'string' && e.stdout.trim().length > 0) {
      try {
        pf = parsePreflightJson(e.stdout);
      } catch {
        return {
          verdict: null,
          markerPath: null,
          error: 'preflight ran but its output was not parseable JSON',
        };
      }
    } else {
      return {
        verdict: null,
        markerPath: null,
        error: `preflight invocation failed: ${(err as Error).message}`,
      };
    }
  }

  const verdict: Verdict = {
    id,
    head,
    ready: pf.ready,
    confidence: pf.confidence,
    blockers: pf.blockers,
    timestamp: opts.timestamp ?? new Date().toISOString(),
    source: 'preflight',
  };
  const markerPath = writeVerdict(verdict);
  return { verdict, markerPath };
}
