import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json'],
      thresholds: {
        // Per-file threshold for server.ts — the glue layer guarded by the
        // MCP-transport roundtrip tests. Set ~6 points below the measured
        // baseline (2026-06-30 run: stmts 84.87, branches 60, funcs 91.66,
        // lines 86.20) so handler-glue regressions surface in coverage CI
        // without being brittle to minor refactors in the CLI entrypoint.
        // Uncovered lines (540, 554, 560-563) are CLI startup code already
        // exercised by cli-version.test.ts at the process level.
        'src/server.ts': {
          statements: 78,
          branches: 54,
          functions: 85,
          lines: 80,
        },
        // The remaining glue files that sit alongside server.ts (residual
        // hardening follow-up to #130, which only gated server.ts). Set ~5-10
        // points below each file's measured baseline (2026-08-18 run) so a
        // sibling glue file can silently regress without being brittle to
        // minor refactors. Branch thresholds on the small files
        // (derive-context.ts, ledger-bridge.ts) are quantized in coarse
        // steps because they only have a handful of branch sites.
        'src/derive-context.ts': {
          // measured: stmts 100, branches 100, funcs 100, lines 100
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'src/hypothesis-store.ts': {
          // measured: stmts 97.4, branches 96.07, funcs 93.33, lines 97.1
          statements: 90,
          branches: 88,
          functions: 85,
          lines: 90,
        },
        'src/ledger-bridge.ts': {
          // measured: stmts 100, branches 50, funcs 100, lines 100
          statements: 90,
          branches: 40,
          functions: 90,
          lines: 90,
        },
        'src/ow-run-completeness.ts': {
          // measured: stmts 93.22, branches 88.49, funcs 92.85, lines 95.13
          statements: 87,
          branches: 82,
          functions: 86,
          lines: 89,
        },
        'src/session-store.ts': {
          // measured: stmts 90, branches 81.81, funcs 85.71, lines 89.47
          statements: 84,
          branches: 75,
          functions: 78,
          lines: 83,
        },
        'src/solution-verdict.ts': {
          // measured: stmts 93.58, branches 77.87, funcs 100, lines 94.52
          statements: 87,
          branches: 71,
          functions: 92,
          lines: 88,
        },
      },
    },
  },
});
