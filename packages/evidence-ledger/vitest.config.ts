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
        // plain `test`, never gated on coverage).
        statements: 84,
        branches: 78,
        functions: 78,
        lines: 85,
      },
    },
  },
});
