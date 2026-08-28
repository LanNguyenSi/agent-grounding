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
//
// Documented residual (OW knob): the OW arm reads `.ai/solution-acceptance.json`
// from the agent-writable working tree, so a shell-capable agent can self-serve
// `{"orchestratorWorkflow":"off"}` to disable the OW PROCESS arm. This is bounded
// and NOT closed: it disables only the process-completeness arm, never the
// preflight technical floor (lint / typecheck / test / audit / secrets), which
// still gates regardless of the knob. Parallel to the marker-forge residual
// above; closing it would need the knob to move to a non-agent-writable source.
//
// OW change binding (staleness fix): a complete run only satisfies the OW arm
// when it also CLAIMS the current change. New-kit runs bind via a `run-base`
// sha marker in `00-goal.md` (ancestor-of-HEAD + not-behind-fork-point);
// legacy runs without the marker fall back tolerantly to a day-granular date
// heuristic (run dir date vs oldest change commit author date). Fail
// direction, downgrade, and false-positive story are documented on
// `owBindingBlockers`.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { readOwRunCompleteness, type OwRunCompleteness } from './ow-run-completeness.js';
import { resolveGeneratedDir, signVerdict } from './verdict-signing.js';

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
  /**
   * Signature algorithm tag; set by `writeVerdict`, which always signs
   * (see `verdict-signing.ts`, D-002, task 9b6c4beb / grounding-mcp
   * CHANGELOG 0.8.0: no fail-open "unsigned when no key" path — that would
   * reproduce the exact producer-doesn't-sign universal-deny failure this
   * feature closes). Optional on the type only
   * because a hand-constructed `Verdict` (e.g. in `evaluateSolution`,
   * before it reaches `writeVerdict`) has not been signed yet.
   */
  alg?: string;
  /** HMAC-SHA256 hex signature over the harness verdict-marker contract; set alongside `alg`. */
  signature?: string;
}

export interface GateResult {
  allowed: boolean;
  reason: string;
  verdict: Verdict | null;
  currentHead: string | null;
}

/**
 * Result of `evaluateSolution`. `verdict` is the PRE-SIGNING object (the 7
 * pinned fields only — no `alg`/`signature`): `signVerdict` returns a
 * signed COPY inside `writeVerdict`, and the object referenced here is
 * never mutated, so the response stays pre-signing. The marker actually
 * written to `markerPath` (when non-null) is that signed copy and
 * additionally carries `alg`/`signature`; read the marker file at
 * `markerPath` directly (JSON.parse) if the signed on-disk shape is what's
 * needed — `readVerdict` deliberately reconstructs only the 7 pinned
 * fields and drops `alg`/`signature`. See "Verdict marker signing" in
 * README.md.
 */
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

/**
 * Write (or overwrite) the verdict marker. Always signs the marker first
 * (mirrors the harness consumer's `verifyVerdictSignature`, see
 * `verdict-signing.ts`): the on-disk marker carries `alg` + `signature` in
 * addition to the 7 pinned fields. No unsigned fallback (D-002) — signing
 * always requires (and, on first use, creates) the shared harness signing
 * key, so this can fail if the key file cannot be read or written. Returns
 * the marker's path.
 *
 * Signing failure and a stale marker (F6, D-006, task 9b6c4beb /
 * grounding-mcp CHANGELOG 0.8.0): `signVerdict` is called BEFORE any write
 * to `target`. If it throws, this function throws too and `target` is never
 * touched — a marker already on disk from an earlier, successful
 * `writeVerdict` call for the same id is left exactly as it was (it is not
 * deleted, truncated, or otherwise invalidated). That pre-existing marker
 * may now be stale relative to the caller's intent (e.g. a solver expecting
 * a fresh not-ready verdict after a broken change still sees the last green
 * one at the same HEAD). This is a deliberate, documented, NOT a new
 * behavior change: the same class of residual predates 0.8.0 (any
 * exception before the write already had this shape), signing only raises
 * how often the write path can throw. Deleting the stale marker before
 * rethrowing was considered and rejected: that would add a new destructive
 * write on an error path in a security-relevant function, for a narrow,
 * loud (an exception, not a silent success) failure mode, which is a worse
 * trade than the residual it would close.
 */
export function writeVerdict(verdict: Verdict): string {
  const target = verdictPath(verdict.id);
  const signed = signVerdict(resolveGeneratedDir(), verdict);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(signed, null, 2)}\n`, 'utf8');
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

/** Orchestrator-workflow (OW) arm knob. */
export type OwKnob = 'auto' | 'on' | 'off';

/**
 * Resolve the OW arm knob from `<repoPath>/.ai/solution-acceptance.json`
 * (`{ "orchestratorWorkflow": "auto" | "on" | "off" }`).
 *
 * Fail-SAFE: a missing file, an unreadable / unparseable file, or a
 * missing / invalid field all resolve to `'auto'` (NOT `'off'`). A malformed
 * config must never silently disable the gate; `'auto'` still enforces when
 * `.ai/runs/` is present.
 */
export function resolveOwKnob(repoPath: string): OwKnob {
  try {
    const raw = fs.readFileSync(path.join(repoPath, '.ai', 'solution-acceptance.json'), 'utf8');
    const parsed = JSON.parse(raw) as { orchestratorWorkflow?: unknown };
    const v = parsed.orchestratorWorkflow;
    if (v === 'auto' || v === 'on' || v === 'off') return v;
    return 'auto';
  } catch {
    return 'auto';
  }
}

/**
 * Decide the OW process-completeness blockers for a repo, given the resolved
 * knob and the OW reader's result. Returns blocker strings already prefixed
 * with `orchestrator-workflow: ` so a consumer's deny reason names the arm
 * (and matches `/orchestrator-workflow/`).
 *
 *   - `off`  : OW never gates (`[]`).
 *   - `auto` : enforced → gate on `!complete` + change binding; not enforced
 *              → skip (`[]`).
 *   - `on`   : enforced → gate on `!complete` + change binding; not enforced
 *              → one explicit "enforcement is on but no run was found" blocker.
 *
 * "Enforced" itself now has two channels (see `ow-run-completeness.ts`'s
 * `runSource`): the worktree-local `.ai/run` pointer file, tried first, and
 * the `<repoPath>/.ai/runs/` newest-run scan used only when no pointer file
 * exists. The `on`-knob "no run" message below names both, since either can
 * be the reason nothing was found.
 *
 * Change binding (staleness fail-open fix): completeness alone lets one old
 * accepted run keep the gate green for every later change. When enforced, the
 * active run must also CLAIM the current change — see `owBindingBlockers`.
 *
 * For a non-OW repo (no `.ai/runs/`, enforced=false) under the default `auto`
 * knob this returns `[]`, keeping the produced verdict byte-identical to the
 * pre-OW output.
 */
export async function owBlockersFor(repoPath: string): Promise<string[]> {
  const knob = resolveOwKnob(repoPath);
  if (knob === 'off') return [];

  const ow = readOwRunCompleteness(repoPath);
  let raw: string[];
  if (ow.enforced) {
    raw = ow.complete ? [] : [...ow.reasons];
    raw.push(...(await owBindingBlockers(repoPath, ow)));
  } else if (knob === 'on') {
    raw = ['enforcement is on but no OW run was found (no .ai/run pointer and no .ai/runs/ run directory)'];
  } else {
    raw = [];
  }
  return raw.map((r) => `orchestrator-workflow: ${r}`);
}

// `run-base` marker values must be plain (possibly abbreviated) commit shas.
// Strict validation BEFORE any git call: the value comes from an
// agent-writable file, so this doubles as an argv-injection guard (a value
// starting with `-` can never reach git).
const RUN_BASE_SHA = /^[0-9a-f]{7,40}$/i;

/**
 * Verify that the active OW run is bound to the CURRENT change. Two paths:
 *
 * Marker path (new kit): `00-goal.md` carries
 * `<!-- solution-acceptance: run-base = <sha> -->`, the repo HEAD recorded at
 * run creation — or, since the pointer/keyed-marker feature, a per-repo keyed
 * variant `<!-- solution-acceptance: run-base[<repo-basename>] = <sha> -->`
 * (`ow.runBase` already reflects whichever marker `readOwRunCompleteness`
 * selected for this repo's key(s); this function only validates the value it
 * receives, it does not re-derive keys). Likewise, the run this marker comes
 * from may have been resolved either via the `<worktree-root>/.ai/run`
 * pointer or via the `.ai/runs/` scan — both are "the active run" here. The
 * run claims the current change iff the recorded base
 *   1. resolves to a commit in this repository,
 *   2. is an ancestor of (or equal to) the current HEAD, and
 *   3. is NOT strictly behind the fork point of the current change (the
 *      merge-base of HEAD with the remote default branch) — an old merged
 *      base IS an ancestor of every later HEAD, so ancestry alone cannot
 *      catch staleness; the fork point marks where this unit of work began.
 * When no remote default ref resolves (local-only repo), check 3 is skipped:
 * in linear local history a stale base is topologically indistinguishable
 * from a legitimate run-start base, and blocking would false-positive every
 * direct-to-default workflow. Documented residual.
 *
 * Heuristic path (legacy runs WITHOUT any applicable `run-base` marker, or
 * with one that still carries the `TODO` placeholder — `ow.runBaseKind` is
 * `'absent'` or `'todo'` — tolerant downgrade): block only when the run
 * dir's `YYYY-MM-DD` prefix is strictly older than the author date of the
 * oldest commit since the fork point (fallback: HEAD's author date). Day
 * granularity: a same-day stale run passes (documented residual; the
 * reported scenario is "days later"), and a multi-day run never
 * false-blocks because its FIRST change commit is not older than the run's
 * creation date. False-positive story: cherry-picked commits keep older
 * author dates than the run dir → they read as run-newer-than-commits and
 * pass (no false block). NOT this path: `ow.runBaseKind === 'unmatched-keyed'`
 * (keyed markers present, none matches this worktree, no unkeyed marker
 * either) skips straight past this heuristic — see the early return below.
 *
 * Pre-merge by design (BOTH paths): evaluating at an already-pushed
 * default-branch tip (fork == HEAD) false-blocks — the marker path because a
 * legitimately-recorded base is then strictly behind the fork point, the
 * legacy path because it falls back to HEAD's author date. That direction is
 * deliberate (fail-closed beats reopening the staleness hole for post-push
 * evaluation) and pinned by a test; the remedy in the blocker text — start a
 * new run — matches the ship-flow, which evaluates before pushing.
 */
async function owBindingBlockers(repoPath: string, ow: OwRunCompleteness): Promise<string[]> {
  if (ow.runName === null) return [];

  // The reader already pushed its own explicit blocker reason onto `reasons`
  // for this case (keyed run-base markers present, none matches this
  // worktree, no unkeyed marker either — see ow-run-completeness.ts). Running
  // the legacy heuristic here on top of that would append a second,
  // misleading "has no run-base marker" blocker for what is really the same
  // underlying failure.
  if (ow.runBaseKind === 'unmatched-keyed') return [];

  if (ow.runBase !== null) {
    if (!RUN_BASE_SHA.test(ow.runBase)) {
      return [
        `run '${ow.runName}' has a malformed run-base marker (${JSON.stringify(ow.runBase)} is not a commit sha); fix the marker or start a new OW run for this change`,
      ];
    }
    // Normalize case first: the regex accepts uppercase hex, git object names
    // are lowercase.
    const base = await revParseCommit(repoPath, ow.runBase.toLowerCase());
    if (base === null) {
      return [
        `run '${ow.runName}' run-base ${ow.runBase} does not resolve to a commit in this repository (run created in a different repo/worktree? consider a keyed marker run-base[<repo-basename>] if this run is shared across repos); start a new OW run for this change`,
      ];
    }
    const head = await getHeadSha(repoPath);
    if (head === null) {
      return [`cannot resolve the current git HEAD to verify run '${ow.runName}' run-base binding`];
    }
    if (!(await isAncestor(repoPath, base, head))) {
      return [
        `run '${ow.runName}' run-base ${base.slice(0, 7)} is not an ancestor of HEAD ${head.slice(0, 7)} (run belongs to a different branch history); start a new OW run for this change`,
      ];
    }
    // Deliberate asymmetry: the HEAD-ancestry check above fails CLOSED on a
    // git error (block), while this fork-point staleness probe fails OPEN
    // (skip) — consistent with skipping the check entirely when no remote
    // default ref resolves. Both commits are already validated at this point,
    // so an error here means the fork-point signal itself is unavailable.
    const fork = await forkPointSha(repoPath, head);
    if (fork !== null && fork !== base && (await isAncestor(repoPath, base, fork))) {
      return [
        `run '${ow.runName}' predates the current change (run-base ${base.slice(0, 7)} is behind the fork point ${fork.slice(0, 7)}); start a new OW run for this change`,
      ];
    }
    return [];
  }

  // Legacy run without a run-base marker: day-granular date heuristic.
  const runDate = ow.runName.slice(0, 10);
  const changeDate = await oldestChangeAuthorDate(repoPath);
  if (changeDate !== null && runDate < changeDate) {
    return [
      `newest run '${ow.runName}' has no run-base marker and predates the current change's commits (${changeDate}); no OW run claims this change — start a new OW run`,
    ];
  }
  return [];
}

/** Resolve `value` to a full commit sha in `repoPath`, or null. */
async function revParseCommit(repoPath: string, value: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--verify', '--quiet', `${value}^{commit}`],
      { cwd: repoPath },
    );
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** True iff `ancestor` is an ancestor of (or equal to) `descendant`. */
async function isAncestor(repoPath: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
      cwd: repoPath,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The remote default-branch ref (`refs/remotes/origin/<default>`), resolved
 * from `origin/HEAD` first, then the conventional master/main candidates.
 * Null when none resolves (no remote / never fetched).
 */
async function remoteDefaultRef(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
      { cwd: repoPath },
    );
    const ref = stdout.trim();
    if (ref.length > 0) return ref;
  } catch {
    // fall through to the conventional candidates
  }
  for (const candidate of ['refs/remotes/origin/master', 'refs/remotes/origin/main']) {
    try {
      await execFileAsync('git', ['rev-parse', '--verify', '--quiet', candidate], {
        cwd: repoPath,
      });
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * The fork point of the current change: merge-base of HEAD with the remote
 * default branch. Null when no remote default ref resolves or the merge-base
 * fails (unrelated histories).
 */
async function forkPointSha(repoPath: string, head: string): Promise<string | null> {
  const ref = await remoteDefaultRef(repoPath);
  if (ref === null) return null;
  try {
    const { stdout } = await execFileAsync('git', ['merge-base', head, ref], { cwd: repoPath });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * `YYYY-MM-DD` author date (commit-local timezone, matching how run dirs are
 * named on the authoring machine) of the OLDEST commit since the fork point,
 * i.e. the first commit of the current change. Falls back to HEAD's author
 * date when the fork point is unresolvable or the range is empty. Null only
 * when even HEAD's date cannot be read.
 */
async function oldestChangeAuthorDate(repoPath: string): Promise<string | null> {
  const head = await getHeadSha(repoPath);
  if (head === null) return null;
  const fork = await forkPointSha(repoPath, head);
  if (fork !== null && fork !== head) {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['log', '--format=%ad', '--date=format:%Y-%m-%d', `${fork}..${head}`],
        { cwd: repoPath, maxBuffer: 16 * 1024 * 1024 },
      );
      const lines = stdout.trim().split('\n').filter(Boolean);
      // Take the true minimum: with merge commits or author/commit-date skew
      // (rebases, cherry-picks) git log's listing order does not guarantee the
      // last line is the oldest AUTHOR date. `YYYY-MM-DD` sorts lexicographically.
      if (lines.length > 0) return lines.reduce((min, d) => (d < min ? d : min));
    } catch {
      // fall through to the HEAD fallback
    }
  }
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['log', '-1', '--format=%ad', '--date=format:%Y-%m-%d', head],
      { cwd: repoPath },
    );
    const date = stdout.trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  } catch {
    return null;
  }
}

/**
 * Producer: run `preflight run <repoPath> --json` and record a HEAD-pinned
 * verdict for `id` derived from its result. The verb running this is the
 * producer; the agent supplies no results and cannot weaken the check set
 * (it comes from the repo's committed `.preflight.json`). preflight exits
 * non-zero when not ready but still prints its JSON, so a non-zero exit with
 * parseable stdout is a normal not-ready verdict, not a failure.
 *
 * The verdict also reflects OW process-completeness: after preflight is parsed,
 * `owBlockersFor(repoPath)` is folded into `ready` and `blockers` ONLY — the
 * OW arm adds no field of its own, so OW state flows entirely through the
 * existing `ready` and `blockers`. (Signing, which DOES add `alg`/`signature`,
 * happens later, only inside `writeVerdict` below; the `verdict` object this
 * function returns is still the pre-signing 7-key shape — see
 * `EvaluateResult` above.) `ready` is true iff preflight is ready AND there
 * are no OW blockers; `blockers` is the preflight blockers followed by the
 * (prefixed) OW blockers.
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

  // Fold the OW process-completeness arm into ready + blockers ONLY: the OW
  // arm adds no field of its own, so OW state flows through the existing
  // `ready` and `blockers`. (Signing, which DOES add `alg`/`signature`, only
  // happens later inside `writeVerdict` below — the `verdict` object built
  // here is still the pre-signing 7-key shape; see `EvaluateResult`.) For a
  // non-OW repo under the default (auto) knob, owBlockers is [] and the
  // output stays byte-identical.
  const owBlockers = await owBlockersFor(repoPath);
  const ready = pf.ready && owBlockers.length === 0;
  const blockers = [...pf.blockers, ...owBlockers];

  const verdict: Verdict = {
    id,
    head,
    ready,
    confidence: pf.confidence,
    blockers,
    timestamp: opts.timestamp ?? new Date().toISOString(),
    source: 'preflight',
  };
  const markerPath = writeVerdict(verdict);
  return { verdict, markerPath };
}
