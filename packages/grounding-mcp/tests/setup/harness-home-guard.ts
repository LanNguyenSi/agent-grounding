// Package-wide regression guard (F1, review round 1; hardened in round 2,
// R2-M2, task 9b6c4beb / grounding-mcp CHANGELOG 0.8.0): a vitest
// `setupFiles` entry that pins HARNESS_HOME to a per-test-file tempdir
// UNCONDITIONALLY, at module top-level (not inside `beforeAll`), so a test
// file that forgets its own HARNESS_HOME isolation can never fall through
// `resolveHarnessHome()` (verdict-signing.ts) to the host's real ~/.harness
// (or ~/.claude fallback) and read/write the real signing key. This closed
// exactly the leak the round-1 reviewer found in
// grounding-gate-mcp-roundtrip.test.ts (SOLUTION_VERDICT_DIR was isolated,
// HARNESS_HOME was not, so `writeVerdict`'s unconditional signing touched
// the real home).
//
// R2-M2 (round 2 finding): the original version only set HARNESS_HOME
// inside `beforeAll` and only when it was UNSET at that point
// (`if (!hadOwnHarnessHome)`). That was inert in exactly the case it exists
// to cover: an AMBIENT HARNESS_HOME already set in the shell environment
// (e.g. by an operator's `.zshrc`, a CI job, or a forgetful earlier test run
// in the same process) made the guard a no-op, and `beforeAll` itself runs
// too late to protect any module-top-level code in the test file that reads
// `resolveHarnessHome()` at import time. Both gaps are closed here: this
// file sets `process.env.HARNESS_HOME` UNCONDITIONALLY at module top level
// (so it wins over whatever the ambient environment already set, and runs
// before any of the test file's own top-level code), and restores the
// pre-file value in `afterAll` regardless of what that value was (including
// "already set to something else").
//
// The guard can still be opted out of, but only via a DEDICATED opt-in
// variable (`HARNESS_HOME_GUARD_DISABLE=1`), never implicitly via "was
// HARNESS_HOME already set" — an ambient/ambient-looking value is exactly
// the case this guard must override, not defer to.
//
// Deliberately a per-file DEFAULT, not a fight: this only sets HARNESS_HOME
// once, at this setup file's own module-evaluation time (vitest re-evaluates
// `setupFiles` once per test file), and restores exactly the pre-file state
// at `afterAll`. Tests that manage HARNESS_HOME themselves inside their own
// `beforeEach`/`afterEach` (solution-verdict.test.ts,
// grounding-gate-mcp-roundtrip.test.ts, verdict-signing.test.ts,
// interop/verdict-signing-interop.test.ts) are unaffected: those hooks run
// AFTER this module's top-level code (hooks always run after the module
// bodies that register them), so they simply save/restore the tempdir this
// guard already put in place instead of `undefined` — including
// verdict-signing.test.ts's "userHome tiers" tests, which intentionally
// delete HARNESS_HOME mid-file to exercise `resolveHarnessHome`'s tiers
// below the env override via its injectable `userHome` parameter (D-005).
// Those tests keep working unchanged: their own outer beforeEach/afterEach
// save/restore whatever HARNESS_HOME value this guard left in place (a
// tempdir instead of undefined), not the real host home either way.

import { afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DISABLE_ENV = 'HARNESS_HOME_GUARD_DISABLE';

const guardDisabled = process.env[DISABLE_ENV] === '1';

// Captured BEFORE the override below, whatever it was (ambient/real, another
// tempdir, or unset) — this is what `afterAll` restores.
const savedHarnessHome = process.env.HARNESS_HOME;

let guardTmpDir: string | undefined;

if (!guardDisabled) {
  guardTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-mcp-harness-home-guard-'));
  process.env.HARNESS_HOME = guardTmpDir;
}

afterAll(() => {
  if (guardDisabled) return;
  if (savedHarnessHome === undefined) delete process.env.HARNESS_HOME;
  else process.env.HARNESS_HOME = savedHarnessHome;
  if (guardTmpDir) fs.rmSync(guardTmpDir, { recursive: true, force: true });
  guardTmpDir = undefined;
});
