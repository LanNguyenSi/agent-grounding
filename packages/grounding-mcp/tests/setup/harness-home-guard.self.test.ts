// Self-test for the package-wide HARNESS_HOME guard
// (tests/setup/harness-home-guard.ts, R2-M2 hardening).
//
// This file deliberately does NOT set or touch HARNESS_HOME itself: it
// exists specifically to prove the setupFiles-registered guard is what puts
// a tempdir there, unconditionally, before any test runs. If the guard's
// `setupFiles` entry is ever removed from vitest.config.ts, or the guard
// regresses back to only setting HARNESS_HOME when it was previously unset
// (the exact R2-M2 inertness bug: a no-op guard next to an ambient
// HARNESS_HOME), this suite fails loudly instead of the guard silently
// stopping mattering.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Hoisting-proof vitest entry resolution (the binary lives in the monorepo
// root node_modules, not this package's own).
const vitestEntry = path.join(
  path.dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs',
);

// Captured at MODULE LOAD of this test file, i.e. after the setupFiles
// guard's own module ran but before any beforeAll/beforeEach hook. A guard
// regressed to setting HARNESS_HOME inside a hook (the R2-M2 shape) leaves
// this undefined even when HARNESS_HOME is unset in the ambient
// environment, which is what makes the regression detectable in default
// CI/local runs (R3-M1).
const harnessHomeAtModuleLoad = process.env.HARNESS_HOME;
const signingKeyEnvAtModuleLoad = process.env.SOLUTION_VERDICT_SIGNING_KEY;

describe('harness-home-guard (setupFiles self-test)', () => {
  it('HARNESS_HOME was already pinned at module load of this test file (R3-M1)', () => {
    expect(harnessHomeAtModuleLoad).toBeTruthy();
    expect(path.basename(harnessHomeAtModuleLoad as string)).toMatch(
      /^grounding-mcp-harness-home-guard-/,
    );
  });

  it('HARNESS_HOME is set by the time a test file runs', () => {
    expect(process.env.HARNESS_HOME).toBeTruthy();
  });

  it('HARNESS_HOME does not resolve inside the real host home directory', () => {
    const value = process.env.HARNESS_HOME as string;
    const realHome = os.homedir();
    // Guards against both an exact match and a same-prefix sibling
    // (`path.sep` keeps e.g. "/Users/lan2" from false-passing against
    // "/Users/lan").
    const withinRealHome = value === realHome || value.startsWith(realHome + path.sep);
    expect(withinRealHome).toBe(false);
  });

  it('SOLUTION_VERDICT_SIGNING_KEY is cleared at module load (no ambient projection leaks into tests)', () => {
    expect(signingKeyEnvAtModuleLoad).toBeUndefined();
  });

  // The assertion above is vacuously green in a clean environment (the
  // variable is undefined whether or not the guard deletes it), so this
  // child-process probe makes the delete line load-bearing in default CI
  // (review round 1, task d0daa18a): a child vitest run of THIS file with
  // an ambient sentinel exported must stay green (the guard clears it
  // before module load) and must not create anything at the sentinel path.
  // GUARD_PROBE_CHILD breaks the recursion: the child skips this spawner.
  it.skipIf(process.env.GUARD_PROBE_CHILD === '1')(
    'clears an ambient SOLUTION_VERDICT_SIGNING_KEY before tests run (child-process probe)',
    () => {
      const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-projection-sentinel-'));
      const sentinel = path.join(sentinelDir, 'projected.key');
      try {
        const res = spawnSync(
          process.execPath,
          [vitestEntry, 'run', 'tests/setup/harness-home-guard.self.test.ts'],
          {
            cwd: path.resolve(__dirname, '..', '..'),
            env: {
              ...process.env,
              GUARD_PROBE_CHILD: '1',
              SOLUTION_VERDICT_SIGNING_KEY: sentinel,
            },
            encoding: 'utf8',
            timeout: 120_000,
          },
        );
        expect(res.status, `child vitest failed:
${res.stdout}
${res.stderr}`).toBe(0);
        expect(fs.existsSync(sentinel)).toBe(false);
      } finally {
        fs.rmSync(sentinelDir, { recursive: true, force: true });
      }
    },
  );

  it('HARNESS_HOME matches the guard tempdir naming pattern', () => {
    const value = process.env.HARNESS_HOME as string;
    expect(path.basename(value)).toMatch(/^grounding-mcp-harness-home-guard-/);
  });
});
