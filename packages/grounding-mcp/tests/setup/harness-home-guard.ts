// Package-wide regression guard (F1, review round 1 fix; task 9b6c4beb /
// grounding-mcp CHANGELOG 0.8.0 verdict marker signing): a vitest
// `setupFiles` entry that pins HARNESS_HOME to a
// per-test-file tempdir whenever a test file starts with it UNSET, so a
// test file that forgets its own HARNESS_HOME isolation can never fall
// through `resolveHarnessHome()` (verdict-signing.ts) to the host's real
// ~/.harness (or ~/.claude fallback) and read/write the real signing key.
// This closed exactly the leak the reviewer found in
// grounding-gate-mcp-roundtrip.test.ts (SOLUTION_VERDICT_DIR was isolated,
// HARNESS_HOME was not, so `writeVerdict`'s unconditional signing touched
// the real home).
//
// Deliberately a DEFAULT, not an override: this only sets HARNESS_HOME when
// it is empty at `beforeAll` time (once per test file) and restores exactly
// that pre-file state at `afterAll`. Tests that manage HARNESS_HOME
// themselves inside their own `beforeEach`/`afterEach` (solution-verdict.test.ts,
// grounding-gate-mcp-roundtrip.test.ts, verdict-signing.test.ts) are
// unaffected: this guard never runs again after its own `beforeAll`, so it
// cannot fight a test's own `process.env.HARNESS_HOME = ...` or
// `delete process.env.HARNESS_HOME` during the file's run — including
// verdict-signing.test.ts's "userHome tiers" tests, which intentionally
// delete HARNESS_HOME mid-file to exercise `resolveHarnessHome`'s tiers
// below the env override via its injectable `userHome` parameter (D-005).
// Those tests keep working unchanged: their own outer beforeEach/afterEach
// save/restore whatever HARNESS_HOME value this guard left in place (a
// tempdir instead of undefined), not the real host home either way.

import { afterAll, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let guardTmpDir: string | undefined;
let hadOwnHarnessHome = false;

beforeAll(() => {
  const current = process.env.HARNESS_HOME;
  hadOwnHarnessHome = typeof current === 'string' && current.length > 0;
  if (!hadOwnHarnessHome) {
    guardTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-mcp-harness-home-guard-'));
    process.env.HARNESS_HOME = guardTmpDir;
  }
});

afterAll(() => {
  if (!hadOwnHarnessHome) {
    delete process.env.HARNESS_HOME;
    if (guardTmpDir) fs.rmSync(guardTmpDir, { recursive: true, force: true });
  }
  guardTmpDir = undefined;
});
