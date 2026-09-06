// Attempt lifecycle for `solution_evaluate`: a bounded wait with a running
// handle, a per-sanitized-id append-only attempt log, cross-process mutual
// exclusion delegated to `proper-lockfile`, and the read-only lookups behind
// `solution_evaluate_status` / `solution_evaluate_result`.
//
// Kept out of `solution-verdict.ts` on purpose: the signed verdict marker,
// `writeVerdict`, `evaluateGate` and `solution_gate` are untouched by this
// module. Nothing here is gate authority. The marker remains the only thing
// `solution_gate` reads; this log is an audit trail across every attempt ever
// made for one id, the way advisory preflight diagnostics are advisory.
//
// The four load-bearing rules, each of which has a mutation probe behind it:
//
//   1. Liveness is the lock, and only the lock. Every liveness question
//      ("is this still running?") is answered by a retry-free acquisition of
//      that id's lock: acquired means no holder, `ELOCKED` means a holder is
//      alive. No PID is ever probed, and the PID in a `start` record is a
//      diagnostic aid for a human reading the log, nothing else.
//   2. A genuinely new attempt is licensed only by a successful acquisition.
//      A prior attempt's reported status (`completed`, `failed`, `unknown`,
//      `expired`) never licenses one by itself, and `forceNewAttempt` is
//      refused while the lock is live.
//   3. Reader-side precedence over last-record-wins: if ANY
//      `reconciled-unknown` record exists for an attemptId, that attempt is
//      `unknown` regardless of any `terminal` record physically appended
//      later for it. The write-side re-read below is an optimization only,
//      but not because the writer has let go of the lock: on the ordinary
//      path it still holds it there, and releases only afterwards. It is an
//      optimization because it closes the window solely for a writer INSIDE
//      the lock, while the writers that can actually produce a late terminal
//      record are outside it (a compromised holder, whose lock is already
//      gone or already someone else's, and any other process appending for an
//      attemptId a reconciler has meanwhile settled). The reader rule is the
//      guarantee.
//   4. Compaction never acquires the id lock on its own account. It runs only
//      as a tail step inside an acquisition made for another reason, and is
//      skipped whenever that acquisition came back `ELOCKED`.
//
// Everything about lock staleness, reclamation and compromise detection
// belongs to `proper-lockfile` (4.1.2, `lib/lockfile.js`: `acquireLock`,
// `isLockStale`, `updateLock`, `setLockAsCompromised`, `unlock`). This module
// implements none of it and never unlinks a lock directory. The wrapper shape
// (pre-created anchor file plus `realpath: false`) mirrors this org's existing
// wrapper, `harness/src/io/lock.ts` (`withFileLock`, `ensureLockTarget`).

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import lockfile from 'proper-lockfile';

import {
  evaluateSolution,
  getHeadSha,
  readVerdict,
  sanitizeVerdictId,
  verdictDir,
  verdictPath,
  type EvaluateResult,
  type Verdict,
} from './solution-verdict.js';
import { unavailablePreflightDiagnostics, type PreflightDiagnostics } from './preflight-diagnostics.js';

/**
 * How long ONE `solution_evaluate` request blocks before it falls back to a
 * running handle. 45 s is a deliberate default, not a derived one: the
 * governing deadline is the CALLING client's own per-call wall-clock limit,
 * which is a local client-config matter, so this value must stay safely under
 * whichever deadline actually governs and must not assume the MCP SDK's 60 s
 * `DEFAULT_REQUEST_TIMEOUT_MSEC` is that deadline. 45 s keeps 15 s of headroom
 * under that SDK default while leaving room for a slower client wall; an
 * operator whose client cuts calls earlier lowers it through `createServer`.
 */
export const DEFAULT_ATTEMPT_WAIT_BOUND_MS = 45_000;

/** Poll hint advertised alongside every non-terminal response. */
export const DEFAULT_ATTEMPT_POLL_AFTER_MS = 5_000;

/**
 * How long a terminal attempt keeps its full records before compaction
 * replaces them with a tombstone. Fixed invariant (design section 5):
 * retention must exceed the advertised `pollAfterMs` by a stated margin, so a
 * caller polling at the advertised cadence can never have its target pruned
 * out from under it between two polls. The margin here is
 * `RETENTION_POLL_MARGIN`, and it is enforced in code, not just documented.
 */
export const DEFAULT_ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1_000;

/** Minimum retention, expressed as a multiple of the advertised `pollAfterMs`. */
export const RETENTION_POLL_MARGIN = 100;

/**
 * `stale` passed to every acquisition. The value only matters when a holder
 * dies without releasing: it trades reclamation latency against tolerating a
 * stalled event loop (the library's heartbeat is an `unref`'d `setTimeout`, so
 * a busy process can delay a refresh). 30 s sits comfortably above both floors
 * 4.1.2 applies (`README.md` documents a 5000 ms minimum, `lib/lockfile.js`
 * floors it at 2000 ms), so that documented-versus-code discrepancy does not
 * bite here. `update` is left at the library default (`stale / 2`).
 */
export const DEFAULT_ATTEMPT_LOCK_STALE_MS = 30_000;

/** Every log record is one line, one write, at most this many UTF-8 bytes. */
export const MAX_RECORD_BYTES = 2_048;

/**
 * Upper bound, in characters, on the `id` ALL THREE tools accept:
 * `solution_evaluate` as well as both read-only lookups. Neither
 * `sanitizeVerdictId` nor any tool's schema states one on its own, so it is
 * derived here from what an id has to fit INTO: every id becomes a file NAME
 * under `verdictDir()`, sized in bytes as well as characters because
 * `sanitizeVerdictId` collapses every non-`[A-Za-z0-9._-]` character to a
 * single-byte `_` first, so the sanitized key's byte length never exceeds its
 * character length.
 *
 * The derivation, candidate by candidate, against the 255-byte `NAME_MAX`
 * these filesystems enforce:
 *   - the attempt log and the verdict marker: `<key>.attempts.jsonl` (15
 *     bytes past the key) and `<key>.json` (5 bytes) — neither is close.
 *   - the lock anchor's OWN name: `<key>.attempt-lock` (13 bytes); the
 *     directory `proper-lockfile` creates BESIDE it to hold the lock,
 *     `<key>.attempt-lock.lock` (18 bytes past the key), is longer but still
 *     not the binding case.
 *   - the compaction temp file, `compactUnderLock`'s
 *     `<key>.attempts.jsonl.compact-<pid>-<ms>`: the key plus `.attempts.jsonl`
 *     (15 bytes) plus `.compact-` (9 bytes) plus `process.pid` (10 digits,
 *     generous headroom over the 7 digits Linux's own `pid_max` ceiling
 *     produces) plus `-` (1 byte) plus `Date.now()` (13 digits, true until the
 *     year 2286) = 48 bytes past the key. THIS is the longest name, and the
 *     one 200 is measured against.
 *
 * 200 leaves `255 - 48 - 200 = 7` bytes of headroom under `NAME_MAX` on the
 * binding (compaction) case, with more to spare on every shorter one.
 *
 * The bound is enforced on ALL THREE tools up front: `.max(MAX_LOOKUP_ID_LENGTH)`
 * on every tool's `id` schema in `server.ts`, and again at this module's own
 * entry point (`SolutionAttemptRegistry.evaluate()` rejects an over-long id
 * with the ordinary `{status:"failed", error}` payload before any filesystem
 * call), so a library caller that bypasses the MCP schema gets the identical
 * refusal. Ids are never paths either way: `sanitizeVerdictId` still reduces
 * every id to one safe segment before it is ever used to build a path.
 */
export const MAX_LOOKUP_ID_LENGTH = 200;

const TRUNCATION_MARKER = '... [truncated]';
const MAX_SUMMARY_CHARS = 240;

export type AttemptStatus = 'running' | 'completed' | 'failed' | 'unknown' | 'expired';
export type OutcomeClass = 'ready' | 'not-ready' | 'error' | 'compromised';
/** A tombstone also has to be able to carry an unestablished fate. */
export type TombstoneOutcomeClass = OutcomeClass | 'unknown';

export interface StartRecord {
  kind: 'start';
  attemptId: string;
  id: string;
  head: string | null;
  startedAt: string;
  /** Diagnostic aid for a human reading the log; NEVER a liveness authority. */
  pid: number;
  status: 'running';
}

export interface TerminalRecord {
  kind: 'terminal';
  attemptId: string;
  id: string;
  status: 'completed' | 'failed';
  terminalAt: string;
  outcomeClass: OutcomeClass;
  summary: string;
  error?: string;
  errorTruncated?: boolean;
}

export interface ReconciledUnknownRecord {
  kind: 'reconciled-unknown';
  attemptId: string;
  id: string;
  reconciledAt: string;
}

export interface TombstoneRecord {
  kind: 'tombstone';
  attemptId: string;
  id: string;
  outcomeClass: TombstoneOutcomeClass;
  prunedAt: string;
}

export type AttemptRecord = StartRecord | TerminalRecord | ReconciledUnknownRecord | TombstoneRecord;

export interface ResolvedAttempt {
  attemptId: string;
  id: string;
  status: AttemptStatus;
  outcomeClass?: TombstoneOutcomeClass;
  summary?: string;
  error?: string;
  head?: string | null;
  startedAt?: string;
  lastUpdatedAt?: string;
}

// ── Paths ────────────────────────────────────────────────────────────────

const LOG_SUFFIX = '.attempts.jsonl';
const LOCK_ANCHOR_SUFFIX = '.attempt-lock';

/** Attempt log for a sanitized id, alongside that id's marker and lock. */
export function attemptLogPathForKey(key: string): string {
  return path.join(verdictDir(), `${key}${LOG_SUFFIX}`);
}

export function attemptLogPath(id: string): string {
  return attemptLogPathForKey(sanitizeVerdictId(id));
}

/**
 * The per-id lock ANCHOR file. `proper-lockfile` manages `<anchor>.lock` as a
 * directory beside it; the anchor's own contents are never read and no
 * behavior is ever conditional on its existence. Neither the verdict marker
 * (`invalidateVerdict` unlinks it) nor the attempt log (compaction renames
 * over it) may be the lock target.
 */
export function attemptLockAnchorPathForKey(key: string): string {
  return path.join(verdictDir(), `${key}${LOCK_ANCHOR_SUFFIX}`);
}

export function attemptLockAnchorPath(id: string): string {
  return attemptLockAnchorPathForKey(sanitizeVerdictId(id));
}

// ── Log I/O ──────────────────────────────────────────────────────────────

function ensureVerdictDir(): void {
  fs.mkdirSync(verdictDir(), { recursive: true });
}

/**
 * Create the lock anchor if it is absent, with mode 0600. `realpath: false`
 * means the library does not need it to exist, but creating it keeps the
 * harness's `ensureLockTarget` shape and makes the lock target visible on
 * disk next to the id's other files.
 */
export function ensureLockAnchor(key: string): string {
  ensureVerdictDir();
  const anchor = attemptLockAnchorPathForKey(key);
  if (!fs.existsSync(anchor)) {
    fs.writeFileSync(anchor, '', { mode: 0o600 });
  }
  return anchor;
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Serialize one record to one line that fits `MAX_RECORD_BYTES` including its
 * newline. The variable-length fields are truncated in a fixed order, the
 * persisted `error` string first, and a truncated value is MARKED as such so a
 * reader can tell a short error from a shortened one.
 */
export function encodeRecord(record: AttemptRecord): string {
  const fits = (candidate: AttemptRecord): string | null => {
    const line = `${JSON.stringify(candidate)}\n`;
    return utf8Length(line) <= MAX_RECORD_BYTES ? line : null;
  };

  const direct = fits(record);
  if (direct !== null) return direct;

  let working: AttemptRecord = { ...record };
  if (working.kind === 'terminal' && typeof working.error === 'string') {
    let budget = working.error.length;
    while (budget > 0) {
      budget = Math.max(0, Math.floor(budget / 2));
      const candidate: TerminalRecord = {
        ...working,
        error: `${working.error.slice(0, budget)}${TRUNCATION_MARKER}`,
        errorTruncated: true,
      };
      const line = fits(candidate);
      if (line !== null) return line;
    }
    working = { ...working, error: TRUNCATION_MARKER, errorTruncated: true };
    const line = fits(working);
    if (line !== null) return line;
  }
  if (working.kind === 'terminal') {
    working = { ...working, summary: `${working.summary.slice(0, 40)}${TRUNCATION_MARKER}` };
    const line = fits(working);
    if (line !== null) return line;
    working = { ...working, error: undefined, errorTruncated: true, summary: TRUNCATION_MARKER };
    const line2 = fits(working);
    if (line2 !== null) return line2;
  }
  // A record that still cannot be made to fit is a bug, not a reason to emit a
  // longer line: drop every free-form field and keep the identity.
  const minimal = { ...working } as Record<string, unknown>;
  delete minimal.error;
  delete minimal.summary;
  return `${JSON.stringify(minimal)}\n`;
}

/**
 * Append one record with ONE `O_APPEND` write. A single write per record is
 * what keeps a concurrent append from interleaving inside a line.
 */
export function appendAttemptRecord(key: string, record: AttemptRecord): void {
  ensureVerdictDir();
  const line = encodeRecord(record);
  const fd = fs.openSync(attemptLogPathForKey(key), 'a', 0o600);
  try {
    fs.writeSync(fd, line);
  } finally {
    fs.closeSync(fd);
  }
}

function isRecord(value: unknown): value is AttemptRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const rec = value as Partial<AttemptRecord>;
  if (typeof rec.attemptId !== 'string' || rec.attemptId.length === 0) return false;
  if (typeof rec.id !== 'string') return false;
  return (
    rec.kind === 'start' ||
    rec.kind === 'terminal' ||
    rec.kind === 'reconciled-unknown' ||
    rec.kind === 'tombstone'
  );
}

/**
 * Read every record for a sanitized id. A line that cannot be parsed (or does
 * not look like a record) is SKIPPED and reading continues; the file is never
 * rewritten, truncated, or aborted over. An attempt whose only outcome record
 * was the damaged line therefore still reads `running` and is resolved by the
 * ordinary liveness path, which fails safe in the same direction as the rest.
 */
export function readAttemptRecords(key: string): AttemptRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(attemptLogPathForKey(key), 'utf8');
  } catch {
    return [];
  }
  const records: AttemptRecord[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(parsed)) records.push(parsed);
  }
  return records;
}

/**
 * Group records by attemptId and resolve each attempt's status.
 *
 * Last-record-wins, WITH the reader-side exception that is the load-bearing
 * half of "retry never upgrades unknown to success": any `reconciled-unknown`
 * record anywhere among an attemptId's records resolves that attempt to
 * `unknown` regardless of a physically later `terminal` record for the same
 * attemptId. A tombstone (compaction, which only ever runs after an attempt
 * settled) carries the pruned attempt's OWN outcome class and decides between
 * `expired` and `unknown` from it, so pruning can never launder an
 * unestablished fate into an established one.
 */
export function resolveAttempts(records: AttemptRecord[]): Map<string, ResolvedAttempt> {
  const grouped = new Map<string, AttemptRecord[]>();
  for (const record of records) {
    const bucket = grouped.get(record.attemptId);
    if (bucket === undefined) grouped.set(record.attemptId, [record]);
    else bucket.push(record);
  }

  const resolved = new Map<string, ResolvedAttempt>();
  for (const [attemptId, own] of grouped) {
    const start = own.find((r): r is StartRecord => r.kind === 'start');
    const tombstone = own.filter((r): r is TombstoneRecord => r.kind === 'tombstone').at(-1);
    const reconciled = own.find((r): r is ReconciledUnknownRecord => r.kind === 'reconciled-unknown');
    const terminal = own.filter((r): r is TerminalRecord => r.kind === 'terminal').at(-1);

    const base: ResolvedAttempt = {
      attemptId,
      id: start?.id ?? own[0]?.id ?? '',
      status: 'unknown',
      head: start?.head,
      startedAt: start?.startedAt,
    };

    if (tombstone !== undefined) {
      resolved.set(attemptId, {
        ...base,
        status: tombstone.outcomeClass === 'unknown' ? 'unknown' : 'expired',
        outcomeClass: tombstone.outcomeClass,
        lastUpdatedAt: tombstone.prunedAt,
      });
      continue;
    }
    if (reconciled !== undefined) {
      resolved.set(attemptId, { ...base, status: 'unknown', lastUpdatedAt: reconciled.reconciledAt });
      continue;
    }
    if (terminal !== undefined) {
      resolved.set(attemptId, {
        ...base,
        status: terminal.status,
        outcomeClass: terminal.outcomeClass,
        summary: terminal.summary,
        ...(terminal.error === undefined ? {} : { error: terminal.error }),
        lastUpdatedAt: terminal.terminalAt,
      });
      continue;
    }
    if (start !== undefined) {
      resolved.set(attemptId, { ...base, status: 'running', lastUpdatedAt: start.startedAt });
      continue;
    }
    resolved.set(attemptId, base);
  }
  return resolved;
}

/**
 * The latest attempt for an id: the attempt whose `start` record carries the
 * latest `startedAt` among the attemptIds still present. A compacted attempt
 * has no `start` record any more and is therefore never "latest".
 */
export function latestAttemptId(records: AttemptRecord[]): string | null {
  let best: StartRecord | null = null;
  for (const record of records) {
    if (record.kind !== 'start') continue;
    if (best === null || record.startedAt > best.startedAt) best = record;
  }
  return best === null ? null : best.attemptId;
}

// ── Lock ─────────────────────────────────────────────────────────────────

export type ReleaseLock = () => Promise<void>;

export interface AcquireOptions {
  staleMs: number;
  onCompromised?: (err: Error) => void;
}

/**
 * Retry-free acquisition of one id's lock. Returns the library's own release
 * function on success and `null` on `ELOCKED` (a holder is alive). Any other
 * error is surfaced to the caller: an unreadable or unwritable `verdictDir()`
 * is not something this module papers over, and it is the same directory the
 * marker write already depends on.
 *
 * `retries: 0` on EVERY acquisition is what makes `ELOCKED` mean "join, do not
 * spawn" instead of "wait": a joining call that waited could acquire after the
 * holder finished and turn a join into a duplicate run.
 */
export async function acquireAttemptLock(
  key: string,
  options: AcquireOptions,
): Promise<ReleaseLock | null> {
  const anchor = ensureLockAnchor(key);
  try {
    return await lockfile.lock(anchor, {
      retries: 0,
      realpath: false,
      stale: options.staleMs,
      onCompromised: (err: Error) => {
        options.onCompromised?.(err);
      },
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOCKED') return null;
    throw err;
  }
}

/**
 * Report a swallowed, non-actionable failure on stderr (stdout is the MCP
 * transport). These are the paths where an error must NOT change an attempt's
 * outcome: a retention convenience that failed, or a lock release that the
 * library already considers done. They are reported rather than silently
 * dropped, so a broken `verdictDir()` is visible instead of invisible.
 */
function warnSwallowed(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console
  console.error(`grounding-mcp: ${context}: ${message}`);
}

// ── Reconciliation and compaction (both run INSIDE an acquisition) ───────

/**
 * Append the one-time `reconciled-unknown` record for every row of this id
 * that still reads `running`. MUST be called only while this process holds
 * that id's lock: the lock is what makes "the holder is gone" provable and
 * what guarantees at most one such record per attemptId (two liveness checks
 * cannot both be inside the lock; the second finds the record already there).
 */
export function reconcileUnderLock(key: string, nowIso: string): string[] {
  const resolved = resolveAttempts(readAttemptRecords(key));
  const appended: string[] = [];
  for (const attempt of resolved.values()) {
    if (attempt.status !== 'running') continue;
    appendAttemptRecord(key, {
      kind: 'reconciled-unknown',
      attemptId: attempt.attemptId,
      id: attempt.id,
      reconciledAt: nowIso,
    });
    appended.push(attempt.attemptId);
  }
  return appended;
}

function settledAt(records: AttemptRecord[]): number | null {
  let stamp: string | null = null;
  for (const record of records) {
    if (record.kind === 'terminal') stamp = record.terminalAt;
    else if (record.kind === 'reconciled-unknown') stamp = record.reconciledAt;
  }
  if (stamp === null) return null;
  const parsed = Date.parse(stamp);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Replace every record of an attempt that settled longer ago than
 * `retentionMs` with one tombstone carrying that attempt's OWN outcome class,
 * via a temp file plus an atomic rename in the same directory (never an
 * in-place rewrite). Runs ONLY as a tail step of an acquisition made for
 * another reason; it never acquires the lock itself, because a lock held by a
 * compaction-only holder would make a joiner join an attempt that does not
 * exist.
 */
export function compactUnderLock(key: string, now: number, retentionMs: number): boolean {
  const records = readAttemptRecords(key);
  if (records.length === 0) return false;

  const grouped = new Map<string, AttemptRecord[]>();
  for (const record of records) {
    const bucket = grouped.get(record.attemptId);
    if (bucket === undefined) grouped.set(record.attemptId, [record]);
    else bucket.push(record);
  }

  const resolved = resolveAttempts(records);
  const prune = new Set<string>();
  for (const [attemptId, own] of grouped) {
    if (own.some((r) => r.kind === 'tombstone')) continue;
    const settled = settledAt(own);
    if (settled === null) continue;
    if (now - settled <= retentionMs) continue;
    prune.add(attemptId);
  }
  if (prune.size === 0) return false;

  const kept: AttemptRecord[] = records.filter((r) => !prune.has(r.attemptId));
  const nowIso = new Date(now).toISOString();
  for (const attemptId of prune) {
    const attempt = resolved.get(attemptId);
    if (attempt === undefined) continue;
    // The tombstone carries the attempt's own outcome class, including
    // `unknown`: a compacted terminal attempt resolves to `expired`, a
    // compacted unknown attempt keeps resolving to `unknown`.
    const outcomeClass: TombstoneOutcomeClass =
      attempt.status === 'unknown' ? 'unknown' : (attempt.outcomeClass ?? 'error');
    kept.push({
      kind: 'tombstone',
      attemptId,
      id: attempt.id,
      outcomeClass,
      prunedAt: nowIso,
    });
  }

  const target = attemptLogPathForKey(key);
  const temp = `${target}.compact-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, kept.map((r) => encodeRecord(r)).join(''), { mode: 0o600 });
  fs.renameSync(temp, target);
  return true;
}

export interface ReconcileSummary {
  scannedKeys: string[];
  reconciled: { key: string; attemptId: string }[];
  skippedLocked: string[];
}

/**
 * Startup pass: for every per-id log carrying a still-`running` row, take that
 * id's lock with no retries and, on success, append the one-time
 * `reconciled-unknown` record for each such row INSIDE that acquisition. An id
 * whose acquisition returns `ELOCKED` is SKIPPED, not reconciled: that is the
 * liveness check, and it is why a live holder can never have its own row
 * reconciled out from under it.
 *
 * This is not the only writer of `reconciled-unknown`: the read path runs the
 * identical check for an attemptId a startup pass did not catch.
 */
export async function reconcileOrphanedAttempts(
  options: { staleMs?: number; retentionMs?: number; now?: () => number } = {},
): Promise<ReconcileSummary> {
  const staleMs = options.staleMs ?? DEFAULT_ATTEMPT_LOCK_STALE_MS;
  const retentionMs = options.retentionMs ?? DEFAULT_ATTEMPT_RETENTION_MS;
  const now = options.now ?? Date.now;
  const summary: ReconcileSummary = { scannedKeys: [], reconciled: [], skippedLocked: [] };

  let entries: string[];
  try {
    entries = fs.readdirSync(verdictDir());
  } catch {
    return summary;
  }

  for (const entry of entries) {
    if (!entry.endsWith(LOG_SUFFIX)) continue;
    const key = entry.slice(0, -LOG_SUFFIX.length);
    if (key.length === 0) continue;
    summary.scannedKeys.push(key);
    const hasRunning = [...resolveAttempts(readAttemptRecords(key)).values()].some(
      (attempt) => attempt.status === 'running',
    );
    if (!hasRunning) continue;
    const release = await acquireAttemptLock(key, { staleMs });
    if (release === null) {
      summary.skippedLocked.push(key);
      continue;
    }
    try {
      for (const attemptId of reconcileUnderLock(key, new Date(now()).toISOString())) {
        summary.reconciled.push({ key, attemptId });
      }
      compactUnderLock(key, now(), retentionMs);
    } finally {
      await release();
    }
  }
  return summary;
}

// ── Responses ────────────────────────────────────────────────────────────

export interface AttemptStatusResponse {
  status: AttemptStatus | 'running-unconfirmed';
  id: string;
  attemptId?: string;
  head?: string | null;
  startedAt?: string;
  lastUpdatedAt?: string;
  isLatestForId?: boolean;
  pollAfterMs?: number;
  /** Present only on the `unknown` answer for an id the lookup cannot use. */
  error?: string;
}

export interface AttemptResultResponse {
  status: AttemptStatus | 'running-unconfirmed';
  id: string;
  attemptId?: string;
  isLatestForId?: boolean;
  markerPresent?: boolean;
  outcomeClass?: TombstoneOutcomeClass;
  summary?: string;
  error?: string;
  pollAfterMs?: number;
  verdict?: Verdict | null;
  markerPath?: string | null;
  diagnostics?: PreflightDiagnostics;
}

export type EvaluateAttemptResponse =
  | (EvaluateResult & { status: 'completed' | 'failed'; attemptId?: string })
  | { status: 'running'; id: string; attemptId: string; pollAfterMs: number }
  | { status: 'running-unconfirmed'; id: string; pollAfterMs: number }
  | { status: 'refused'; id: string; attemptId?: string; error: string };

// ── Registry ─────────────────────────────────────────────────────────────

interface OwnedAttempt {
  attemptId: string;
  key: string;
  id: string;
  startedAt: number;
  terminalAt?: number;
  result?: EvaluateResult;
  status: AttemptStatus;
}

type AttemptHandle =
  | { kind: 'own'; attemptId: string }
  | { kind: 'joined'; attemptId: string }
  | { kind: 'unconfirmed' }
  | { kind: 'refused'; error: string; attemptId?: string }
  | { kind: 'error'; result: EvaluateResult };

interface AttemptOutcome {
  handle: AttemptHandle;
  /** Present only for an attempt this process itself ran to a terminal state. */
  terminal?: { result: EvaluateResult; status: 'completed' | 'failed'; attemptId: string };
}

interface LiveAttempt {
  key: string;
  id: string;
  attemptId: string | null;
  outcome: Promise<AttemptOutcome>;
}

type LookupOutcome =
  | { kind: 'attempt'; attempt: ResolvedAttempt; isLatestForId: boolean }
  | { kind: 'running-unconfirmed' }
  | { kind: 'unknown'; attemptId?: string; error?: string };

export interface AttemptRegistryOptions {
  waitBoundMs?: number;
  pollAfterMs?: number;
  retentionMs?: number;
  lockStaleMs?: number;
  now?: () => number;
}

function positiveOr(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * One registry per `grounding-mcp` process (one per `createServer`). It owns
 * the same-process join fast path and the in-memory record of the attempts
 * THIS process ran; everything else lives on disk, because every other process
 * has its own registry and shares none of this memory.
 */
export class SolutionAttemptRegistry {
  readonly waitBoundMs: number;
  readonly pollAfterMs: number;
  readonly retentionMs: number;
  readonly lockStaleMs: number;
  private readonly clock: () => number;
  private readonly inFlight = new Map<string, LiveAttempt>();
  private readonly owned = new Map<string, OwnedAttempt>();

  constructor(options: AttemptRegistryOptions = {}) {
    this.waitBoundMs = positiveOr(options.waitBoundMs, DEFAULT_ATTEMPT_WAIT_BOUND_MS);
    this.pollAfterMs = positiveOr(options.pollAfterMs, DEFAULT_ATTEMPT_POLL_AFTER_MS);
    // The retention invariant is enforced here, not merely documented: a
    // caller that polls at the advertised cadence must never have its target
    // pruned between two polls.
    this.retentionMs = Math.max(
      positiveOr(options.retentionMs, DEFAULT_ATTEMPT_RETENTION_MS),
      this.pollAfterMs * RETENTION_POLL_MARGIN,
    );
    this.lockStaleMs = positiveOr(options.lockStaleMs, DEFAULT_ATTEMPT_LOCK_STALE_MS);
    this.clock = options.now ?? Date.now;
  }

  private now(): number {
    return this.clock();
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  /**
   * `solution_evaluate`. NOT `async` on purpose: the same-process join is a
   * synchronous check-and-set that must complete before the first `await`,
   * which is what makes two concurrent calls for one id join under Node's
   * single-threaded event loop instead of both starting a child process.
   */
  evaluate(
    id: string,
    repoPath: string,
    options: { forceNewAttempt?: boolean } = {},
  ): Promise<EvaluateAttemptResponse> {
    if (id.length > MAX_LOOKUP_ID_LENGTH) {
      // Enforced here as well as by every tool's schema in server.ts (see
      // MAX_LOOKUP_ID_LENGTH's docstring for the derivation), so a library
      // caller that bypasses the MCP transport gets the identical refusal
      // before any filesystem call: an id this long would overrun NAME_MAX
      // once this module appends a suffix to it (the compaction temp file is
      // the binding case).
      return Promise.resolve({
        status: 'failed' as const,
        verdict: null,
        markerPath: null,
        error: `verdict id is too long: ${id.length} characters exceeds the ${MAX_LOOKUP_ID_LENGTH}-character limit`,
        diagnostics: unavailablePreflightDiagnostics(
          { exitCode: null, signal: null },
          'preflight was not started because the verdict id is too long',
        ),
      });
    }
    let key: string;
    try {
      key = sanitizeVerdictId(id);
    } catch {
      // An unusable id never reaches the lock or the log; delegate to the
      // existing producer so the caller sees today's exact error payload.
      return evaluateSolution(id, repoPath).then((result) => ({ ...result, status: 'failed' as const }));
    }

    const live = this.inFlight.get(key);
    if (live !== undefined) {
      if (options.forceNewAttempt === true) {
        return Promise.resolve({
          status: 'refused' as const,
          id,
          ...(live.attemptId === null ? {} : { attemptId: live.attemptId }),
          error:
            'forceNewAttempt is refused while an attempt for this id is still running: poll solution_evaluate_status/solution_evaluate_result instead, or retry once the running attempt is terminal',
        });
      }
      return this.awaitBounded(live, id);
    }

    const created = this.launch(key, id, repoPath, options.forceNewAttempt === true);
    return this.awaitBounded(created, id);
  }

  private launch(key: string, id: string, repoPath: string, force: boolean): LiveAttempt {
    const live: LiveAttempt = {
      key,
      id,
      attemptId: null,
      outcome: Promise.resolve({ handle: { kind: 'unconfirmed' } } as AttemptOutcome),
    };
    this.inFlight.set(key, live);
    live.outcome = this.execute(live, repoPath, force).finally(() => {
      if (this.inFlight.get(key) === live) this.inFlight.delete(key);
    });
    return live;
  }

  /** Bounded wait: the terminal outcome if it lands in time, else a handle. */
  private async awaitBounded(live: LiveAttempt, id: string): Promise<EvaluateAttemptResponse> {
    const timedOut = Symbol('attempt-wait-bound');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), this.waitBoundMs);
      timer.unref?.();
    });
    let settled: AttemptOutcome | typeof timedOut;
    try {
      settled = await Promise.race([live.outcome, bound]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (settled === timedOut) {
      // The `preflight` child keeps running to completion in the background;
      // only THIS request stops waiting.
      if (live.attemptId !== null) {
        return { status: 'running', id, attemptId: live.attemptId, pollAfterMs: this.pollAfterMs };
      }
      return { status: 'running-unconfirmed', id, pollAfterMs: this.pollAfterMs };
    }
    return this.responseFor(settled, id);
  }

  private responseFor(outcome: AttemptOutcome, id: string): EvaluateAttemptResponse {
    if (outcome.terminal !== undefined) {
      return {
        ...outcome.terminal.result,
        status: outcome.terminal.status,
        attemptId: outcome.terminal.attemptId,
      };
    }
    const handle = outcome.handle;
    if (handle.kind === 'joined') {
      return { status: 'running', id, attemptId: handle.attemptId, pollAfterMs: this.pollAfterMs };
    }
    if (handle.kind === 'refused') {
      return {
        status: 'refused',
        id,
        ...(handle.attemptId === undefined ? {} : { attemptId: handle.attemptId }),
        error: handle.error,
      };
    }
    if (handle.kind === 'error') {
      return { ...handle.result, status: 'failed' };
    }
    if (handle.kind === 'own') {
      return { status: 'running', id, attemptId: handle.attemptId, pollAfterMs: this.pollAfterMs };
    }
    return { status: 'running-unconfirmed', id, pollAfterMs: this.pollAfterMs };
  }

  private async execute(live: LiveAttempt, repoPath: string, force: boolean): Promise<AttemptOutcome> {
    const { key, id } = live;
    let release: ReleaseLock | null;
    const compromise: { error: Error | null } = { error: null };
    try {
      release = await acquireAttemptLock(key, {
        staleMs: this.lockStaleMs,
        onCompromised: (err) => {
          compromise.error = err;
        },
      });
    } catch (err) {
      return {
        handle: {
          kind: 'error',
          result: {
            verdict: null,
            markerPath: null,
            error: `could not take the attempt lock for "${id}": ${(err as Error).message}`,
          },
        },
      };
    }

    if (release === null) {
      // ELOCKED: a holder is alive. Join it, never spawn, never wait.
      if (force) {
        return {
          handle: {
            kind: 'refused',
            error:
              'forceNewAttempt is refused while an attempt for this id is still running (its lock is held): poll solution_evaluate_status/solution_evaluate_result instead, or retry once the running attempt is terminal',
          },
        };
      }
      const records = readAttemptRecords(key);
      const latest = latestAttemptId(records);
      const resolved = latest === null ? undefined : resolveAttempts(records).get(latest);
      if (latest !== null && resolved?.status === 'running') {
        live.attemptId = latest;
        return { handle: { kind: 'joined', attemptId: latest } };
      }
      return { handle: { kind: 'unconfirmed' } };
    }

    // Acquired: this process owns the id for the whole attempt.
    let attemptId: string | null = null;
    try {
      // Same acquisition, same check the startup pass runs: any row still
      // reading `running` under a lock we just took belongs to a holder that
      // is gone.
      reconcileUnderLock(key, this.nowIso());

      attemptId = randomUUID();
      const head = await getHeadSha(repoPath);
      appendAttemptRecord(key, {
        kind: 'start',
        attemptId,
        id,
        head,
        startedAt: this.nowIso(),
        pid: process.pid,
        status: 'running',
      });
      live.attemptId = attemptId;
      this.owned.set(attemptId, {
        attemptId,
        key,
        id,
        startedAt: this.now(),
        status: 'running',
      });

      let result: EvaluateResult;
      try {
        result = await evaluateSolution(id, repoPath, {
          // Write order step 0: the compromise flag is read immediately
          // before `writeVerdict`. A holder that lost its lock writes no
          // marker for its attempt.
          preWriteGuard: () =>
            compromise.error === null
              ? null
              : `attempt ${attemptId} lost its lock before the verdict marker was written (${compromise.error.message}); no marker was written for this attempt`,
        });
      } catch (err) {
        result = {
          verdict: null,
          markerPath: null,
          error: `solution evaluation threw: ${(err as Error).message}`,
        };
      }

      const compromised = compromise.error !== null;
      const markerWritten = result.markerPath !== null;
      const status: 'completed' | 'failed' =
        result.error === undefined && result.verdict !== null ? 'completed' : 'failed';
      const outcomeClass: OutcomeClass =
        compromised && !markerWritten
          ? 'compromised'
          : status === 'failed'
            ? 'error'
            : result.verdict?.ready === true
              ? 'ready'
              : 'not-ready';
      this.appendTerminal(key, id, attemptId, status, outcomeClass, summarize(result, compromised), result.error);

      const record = this.owned.get(attemptId);
      if (record !== undefined) {
        record.status = status;
        record.terminalAt = this.now();
        record.result = result;
      }
      return {
        handle: { kind: 'own', attemptId },
        terminal: { result, status, attemptId },
      };
    } finally {
      if (compromise.error === null) {
        // Tail step of an acquisition made for another reason, never its own.
        try {
          compactUnderLock(key, this.now(), this.retentionMs);
        } catch (err) {
          // Compaction is a retention convenience; a failure here must never
          // turn a finished attempt into a failed one, but it is reported.
          warnSwallowed(`compaction for "${id}" failed`, err);
        }
        await release().catch((err: unknown) => warnSwallowed(`releasing the attempt lock for "${id}" failed`, err));
        // Same window, same trigger: the in-memory half of retention ages out
        // wherever the on-disk half does, so a long-lived server does not hold
        // every `EvaluateResult` (diagnostics included) it ever produced. It
        // needs no lock of its own, being purely process-local. Placed AFTER
        // the release rather than before it: `pruneOwned` only ever touches
        // this process's own in-memory Map and is not expected to throw, but
        // it used to run between the guarded `compactUnderLock` and the
        // release, where an unforeseen throw here would have skipped the
        // release call entirely and leaked the lock for up to the stale
        // window. After the release, the lock is already gone either way, so
        // the same failure here can cost only the retention convenience.
        this.pruneOwned();
      }
      // Compromised: the lock is already gone or is now someone else's. This
      // process never deletes a lock it does not hold, and never runs
      // compaction it has no lock for.
    }
  }

  /**
   * Write-order step 2, and on the ORDINARY path it runs while this process
   * still holds the id's lock: `execute` releases only in its `finally`, after
   * this has returned. That is exactly why the re-read below is an
   * OPTIMIZATION and not the guarantee. It closes the window only for the
   * writer that is inside the lock, and the writers that can actually produce
   * a late terminal record are the ones OUTSIDE it: a compromised holder,
   * whose lock is already gone or already someone else's by the time it gets
   * here, and any other process appending for an attemptId a reconciler has
   * meanwhile settled. Against those, this read and the append that follows it
   * are not atomic with each other. The guarantee that a late terminal write
   * can never upgrade an already-reconciled attempt is the READER rule in
   * `resolveAttempts`.
   */
  private appendTerminal(
    key: string,
    id: string,
    attemptId: string,
    status: 'completed' | 'failed',
    outcomeClass: OutcomeClass,
    summary: string,
    error?: string,
  ): void {
    const existing = resolveAttempts(readAttemptRecords(key)).get(attemptId);
    if (existing?.status === 'unknown') return;
    appendAttemptRecord(key, {
      kind: 'terminal',
      attemptId,
      id,
      status,
      terminalAt: this.nowIso(),
      outcomeClass,
      summary,
      ...(error === undefined ? {} : { error }),
    });
  }

  /**
   * @internal Test seam, NOT part of the published tool surface or of any
   * contract a consumer may rely on; it may change or disappear without a
   * major bump. It exists so the late-terminal-write test (design criterion 8:
   * a retry never upgrades an `unknown` attempt to a success) can drive the
   * REAL terminal-write path, write-side re-read included. Driving that test
   * through the module-level `appendAttemptRecord` instead would bypass the
   * one guard the test is about, and re-implementing the re-read in the test
   * would assert the test's copy rather than the production one. Kept a method
   * rather than an exported function because the re-read and the record's
   * `terminalAt` both come from this registry's own clock.
   */
  appendTerminalRecordForTest(
    id: string,
    attemptId: string,
    status: 'completed' | 'failed',
    outcomeClass: OutcomeClass,
    summary: string,
    error?: string,
  ): void {
    this.appendTerminal(sanitizeVerdictId(id), id, attemptId, status, outcomeClass, summary, error);
  }

  // ── Lookups ────────────────────────────────────────────────────────────

  /**
   * Resolve the attempt a lookup is about, running the read-path liveness
   * check (the SAME retry-free acquisition the startup pass runs) whenever the
   * row still reads `running`, and only then.
   */
  private async resolveForLookup(id: string, attemptId?: string): Promise<LookupOutcome> {
    const key = sanitizeVerdictId(id);
    let records = readAttemptRecords(key);
    let resolved = resolveAttempts(records);
    let target =
      attemptId === undefined
        ? pick(resolved, latestAttemptId(records))
        : resolved.get(attemptId);

    if (target?.status === 'running') {
      const release = await acquireAttemptLock(key, { staleMs: this.lockStaleMs });
      if (release !== null) {
        try {
          reconcileUnderLock(key, this.nowIso());
          compactUnderLock(key, this.now(), this.retentionMs);
          this.pruneOwned();
        } finally {
          await release().catch((err: unknown) =>
            warnSwallowed(`releasing the attempt lock for "${id}" failed`, err),
          );
        }
        records = readAttemptRecords(key);
        resolved = resolveAttempts(records);
        target = attemptId === undefined ? pick(resolved, latestAttemptId(records)) : resolved.get(attemptId);
      }
    }

    if (target !== undefined) {
      return { kind: 'attempt', attempt: target, isLatestForId: latestAttemptId(records) === target.attemptId };
    }
    if (attemptId !== undefined) {
      // An attemptId nothing can account for resolves to `unknown`; it is
      // never a filesystem or command lookup, and nothing is appended for it.
      return { kind: 'unknown', attemptId };
    }
    // No attempt recorded for this id at all: only the lock can distinguish
    // "a holder took it and has not written its start record yet" from
    // "nothing ever ran".
    const release = await acquireAttemptLock(key, { staleMs: this.lockStaleMs });
    if (release === null) return { kind: 'running-unconfirmed' };
    await release().catch((err: unknown) =>
      warnSwallowed(`releasing the attempt lock for "${id}" failed`, err),
    );
    return { kind: 'unknown' };
  }

  /**
   * `resolveForLookup`, with every thrown error turned into an ANSWER rather
   * than an isError envelope: `solution_evaluate` already answers an unusable
   * id with a clean `{status:"failed", error}` payload, and these two
   * read-only lookups match that posture with `{status:"unknown", id, error}`
   * instead. `unknown` is the honest status either way: no attempt could be
   * identified, and none was appended.
   *
   * The catch stays broad (kept, not narrowed to only the sanitizer's own
   * error) so an id this module cannot use for ANY reason still answers
   * cleanly rather than throwing, but it is no longer a single undiscriminated
   * branch: an id `sanitizeVerdictId` itself rejects outright (`'.'`, `'..'`,
   * a string of only separators) keeps today's exact, informative message,
   * while any OTHER thrown error — an id long enough that a filesystem call
   * under `verdictDir()` fails `ENAMETOOLONG`, or a genuine operational
   * failure there (`EACCES`, `ENOSPC`, `EMFILE`) — is reported through
   * `warnSwallowed` (so a broken verdict store is visible on stderr instead of
   * invisible behind a clean-looking payload) and answered with a fixed,
   * path-free message: the raw exception can interpolate `verdictDir()`'s own
   * filesystem path, which this module does not want to hand back to a
   * caller. Neither branch can escape `verdictDir()` either way:
   * `sanitizeVerdictId` is still the only path builder, and it still runs
   * first.
   */
  private async lookup(id: string, attemptId?: string): Promise<LookupOutcome> {
    try {
      return await this.resolveForLookup(id, attemptId);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('invalid verdict id:')) {
        return {
          kind: 'unknown',
          ...(attemptId === undefined ? {} : { attemptId }),
          error: `this id cannot be looked up: ${err.message}`,
        };
      }
      warnSwallowed(`lookup for id ${JSON.stringify(id)} failed`, err);
      return {
        kind: 'unknown',
        ...(attemptId === undefined ? {} : { attemptId }),
        error: 'this id cannot be looked up: the verdict store rejected the lookup',
      };
    }
  }

  /** `solution_evaluate_status`: read-only, always fast, never blocks. */
  async status(id: string, attemptId?: string): Promise<AttemptStatusResponse> {
    const found = await this.lookup(id, attemptId);
    if (found.kind === 'running-unconfirmed') {
      return { status: 'running-unconfirmed', id, pollAfterMs: this.pollAfterMs };
    }
    if (found.kind === 'unknown') {
      return {
        status: 'unknown',
        id,
        ...(found.attemptId === undefined ? {} : { attemptId: found.attemptId }),
        ...(found.error === undefined ? {} : { error: found.error }),
      };
    }
    const { attempt, isLatestForId } = found;
    return {
      status: attempt.status,
      id,
      attemptId: attempt.attemptId,
      head: attempt.head ?? null,
      startedAt: attempt.startedAt,
      lastUpdatedAt: attempt.lastUpdatedAt,
      isLatestForId,
      ...(attempt.status === 'running' ? { pollAfterMs: this.pollAfterMs } : {}),
    };
  }

  /**
   * `solution_evaluate_result`. The full `EvaluateResult` shape is returned
   * ONLY by the process whose own in-memory registry ran the attempt, only
   * while that attempt is still the latest for its id, AND only while that
   * process's own in-memory record of the attempt has not yet aged out
   * (`pruneOwned`, same retention window as the on-disk log): once pruned, the
   * owning process answers with the reduced shape too, same as any other
   * process, because `diagnostics` and the full `error` string were never
   * persisted anywhere else. `pruneOwned` itself is a single process-wide
   * sweep, unlike compaction, which is scoped to one id: a lookup for id A can
   * therefore prune id A's owned record as a side effect of THIS process next
   * touching id B, not only of touching A again.
   */
  async result(id: string, attemptId?: string): Promise<AttemptResultResponse> {
    const found = await this.lookup(id, attemptId);
    if (found.kind === 'running-unconfirmed') {
      return { status: 'running-unconfirmed', id, pollAfterMs: this.pollAfterMs };
    }
    if (found.kind === 'unknown') {
      return {
        status: 'unknown',
        id,
        ...(found.attemptId === undefined ? {} : { attemptId: found.attemptId }),
        ...(found.error === undefined ? {} : { error: found.error }),
      };
    }
    const { attempt, isLatestForId } = found;
    if (attempt.status === 'running') {
      return { status: 'running', id, attemptId: attempt.attemptId, isLatestForId, pollAfterMs: this.pollAfterMs };
    }

    // Fresh filesystem check at response time, never a value cached from when
    // the attempt finished. It asserts only that a marker exists for this id;
    // it makes no claim about which attempt wrote it.
    const markerPresent = fs.existsSync(verdictPath(attempt.id.length > 0 ? attempt.id : id));
    const base: AttemptResultResponse = {
      status: attempt.status,
      id,
      attemptId: attempt.attemptId,
      isLatestForId,
      markerPresent,
      ...(attempt.outcomeClass === undefined ? {} : { outcomeClass: attempt.outcomeClass }),
      ...(attempt.summary === undefined ? {} : { summary: attempt.summary }),
      ...(attempt.error === undefined ? {} : { error: attempt.error }),
    };

    if (!isLatestForId) {
      // The marker this attempt wrote has since been invalidated and replaced
      // by a newer attempt for the same id; never hand back a verdict or a
      // path that could point at a file `invalidateVerdict` already removed.
      return base;
    }

    const ownedAttempt = this.owned.get(attempt.attemptId);
    if (ownedAttempt?.result !== undefined) {
      const result = ownedAttempt.result;
      return {
        ...base,
        verdict: result.verdict,
        markerPath: result.markerPath,
        ...(result.diagnostics === undefined ? {} : { diagnostics: result.diagnostics }),
        ...(result.error === undefined ? {} : { error: result.error }),
      };
    }

    if (!markerPresent) return base;
    const marker = readVerdict(attempt.id.length > 0 ? attempt.id : id);
    if (marker === null) return base;
    return { ...base, verdict: marker, markerPath: verdictPath(attempt.id.length > 0 ? attempt.id : id) };
  }

  /** Terminal attempts age out of the in-memory registry with the same window. */
  pruneOwned(): string[] {
    const pruned: string[] = [];
    for (const [attemptId, attempt] of this.owned) {
      if (attempt.terminalAt === undefined) continue;
      if (this.now() - attempt.terminalAt <= this.retentionMs) continue;
      this.owned.delete(attemptId);
      pruned.push(attemptId);
    }
    return pruned;
  }

  /** True when this process's own registry still holds the attempt. */
  ownsAttempt(attemptId: string): boolean {
    return this.owned.has(attemptId);
  }
}

function pick(resolved: Map<string, ResolvedAttempt>, attemptId: string | null): ResolvedAttempt | undefined {
  return attemptId === null ? undefined : resolved.get(attemptId);
}

/** Counts, never the full diagnostics payload; bounded before it is written. */
function summarize(result: EvaluateResult, compromised: boolean): string {
  let summary: string;
  if (result.verdict !== null) {
    summary = `ready=${result.verdict.ready} confidence=${result.verdict.confidence} blockers=${result.verdict.blockers.length}`;
    if (compromised) summary += '; lock compromised after the marker was written';
  } else if (compromised) {
    summary = 'attempt lost its lock before the verdict marker was written; no marker was written';
  } else {
    summary = 'evaluation failed before a verdict was recorded';
  }
  return summary.length > MAX_SUMMARY_CHARS ? `${summary.slice(0, MAX_SUMMARY_CHARS)}${TRUNCATION_MARKER}` : summary;
}
