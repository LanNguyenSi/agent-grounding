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
      },
    },
  },
});
