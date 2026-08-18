import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json"],
      thresholds: {
        // Package-wide threshold, set ~5-6 points below the measured
        // baseline (2026-08-18 run: stmts 89.75, branches 83.89,
        // funcs 83.6, lines 90.58) so a regression in cli.ts/db.ts/
        // display.ts/handoff.ts surfaces in coverage CI without being
        // brittle to minor refactors. Residual hardening follow-up to
        // #130 (this package's vitest tests previously ran only via
        // plain `test`, never gated on coverage). Kept as a catch-all
        // floor; the package-wide numbers alone are too loose to catch
        // a regression isolated to a single low-coverage file (a whole
        // describe block can be dropped from display.ts and the
        // package totals still clear this floor), so per-file floors
        // below pin down the two files carrying most of the uncovered
        // mass.
        statements: 84,
        branches: 78,
        functions: 78,
        lines: 85,
        // Per-file floor for display.ts, the thinnest-covered file in
        // this package. Set ~5 points below its measured baseline
        // (2026-08-18 run: stmts 66.66, branches 65, funcs 50, lines
        // 70) so a regression here (e.g. losing the printSummary
        // empty-state test coverage) surfaces as a per-file coverage
        // error instead of being absorbed by the package-wide floor
        // above.
        "src/display.ts": {
          statements: 61,
          branches: 60,
          functions: 45,
          lines: 65,
        },
        // Per-file floor for cli.ts, the other main carrier of
        // uncovered lines in this package. Set ~5 points below its
        // measured baseline (2026-08-18 run: stmts 88.34, branches 75,
        // funcs 75, lines 89).
        "src/cli.ts": {
          statements: 83,
          branches: 70,
          functions: 70,
          lines: 84,
        },
      },
    },
  },
});
