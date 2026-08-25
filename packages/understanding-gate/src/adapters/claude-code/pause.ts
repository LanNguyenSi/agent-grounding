// Shared pause-sentinel reader for the Claude Code adapters. Leaf module
// (no import of the classifier/prompt/mode module graph) so the PreToolUse
// hot path can import just this, not the whole handle.ts import chain that
// UserPromptSubmit's prompt-injection logic needs.

import { readFileSync, statSync } from "node:fs";

export interface PauseSentinelShape {
  pausedAt?: unknown;
  expiresAt?: unknown;
}

// A corrupted-but-parsable sentinel that falls into an INDEFINITE pause
// (missing or unparsable expiresAt) would otherwise suppress every prompt
// silently forever. Claude Code surfaces hook stderr in its diagnostic
// stream, so a single line here at least makes a stale or half-written
// sentinel visible instead of indistinguishable from a deliberate pause.
// Deliberately evidence-free and tool-agnostic: no paths, ids, or
// timestamps, just the fact that the read degraded this way.
export function warnIndefiniteFromCorruptExpiry(): void {
  process.stderr.write(
    "understanding-gate: pause sentinel expiresAt missing or unparsable; treating pause as indefinite\n",
  );
}

// Read-only, best-effort check of a pause sentinel file. The shape and the
// "absent/parsable" semantics below are chosen to match how a pause
// sentinel of this shape is read elsewhere -- see the "Pause sentinel"
// section of this package's own README for the documented shape and
// semantics. no file, an unreadable file, a non-regular file (see the
// statSync guard, which keeps this from blocking forever on a FIFO;
// statSync follows symlinks, so a sentinel path that is itself a symlink
// to a regular file is still honored), malformed JSON, or a
// non-object/array JSON value all degrade to "not paused". Within a
// parsable sentinel OBJECT:
//   - a missing or empty-string `pausedAt` makes the whole sentinel count
//     as absent (not paused) -- a sentinel writer never omits it, so this
//     is reserved for a corrupted file.
//   - `expiresAt` missing entirely, or explicitly `null`, means paused
//     INDEFINITELY. A missing `expiresAt` is indistinguishable from a
//     truncated or half-written file, so this branch also emits a stderr
//     diagnostic (see warnIndefiniteFromCorruptExpiry above); an explicit
//     `null` is an unambiguous, deliberate signal and stays silent.
//   - `expiresAt` as a non-empty string that fails to parse as a date
//     ALSO means paused indefinitely (a malformed but present expiry
//     doesn't get to silently unblock things) and ALSO emits that stderr
//     diagnostic, since this is the other shape a corrupted or
//     half-written sentinel can take.
//   - `expiresAt` as anything else (a number, array, object, boolean, or
//     empty string) makes the whole sentinel count as absent.
//   - `expiresAt` as a valid, parsable date means paused only while it is
//     strictly in the future; equal-to-now or past means not paused.
// Nothing here is ever written or deleted -- expiry cleanup is not this
// hook's job.
//
// Exported so both handle.ts (UserPromptSubmit) and handle-pre-tool-use.ts
// (PreToolUse) can honor the same pause sentinel without a second parser.
// Both hooks must reach an identical answer for the same sentinel file --
// see the parity test in tests/claude-code-pre-tool-use.test.ts.
export function isPaused(pauseFilePath: string | undefined): boolean {
  if (!pauseFilePath) return false;
  let raw: string;
  try {
    if (!statSync(pauseFilePath).isFile()) return false;
    raw = readFileSync(pauseFilePath, "utf8");
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const shape = parsed as PauseSentinelShape;
  if (typeof shape.pausedAt !== "string" || shape.pausedAt.length === 0) {
    return false;
  }

  const expiresAtRaw = shape.expiresAt;
  if (expiresAtRaw === undefined) {
    warnIndefiniteFromCorruptExpiry();
    return true;
  }
  let expiresAt: string | null;
  if (expiresAtRaw === null) {
    expiresAt = null;
  } else if (typeof expiresAtRaw === "string" && expiresAtRaw.length > 0) {
    expiresAt = expiresAtRaw;
  } else {
    return false;
  }
  if (expiresAt === null) return true;
  const expires = Date.parse(expiresAt);
  if (!Number.isFinite(expires)) {
    warnIndefiniteFromCorruptExpiry();
    return true;
  }
  return expires > Date.now();
}
