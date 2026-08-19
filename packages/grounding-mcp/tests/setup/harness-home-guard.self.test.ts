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
import os from 'node:os';
import path from 'node:path';

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

  it('HARNESS_HOME matches the guard tempdir naming pattern', () => {
    const value = process.env.HARNESS_HOME as string;
    expect(path.basename(value)).toMatch(/^grounding-mcp-harness-home-guard-/);
  });
});
