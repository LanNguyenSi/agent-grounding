import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json"],
      thresholds: {
        // Package-wide threshold, set ~6 points below the measured
        // baseline (2026-08-18 run: stmts 94.04, branches 86.11,
        // funcs 94.11, lines 95.45) so a regression in cli.ts/lib.ts
        // surfaces in coverage CI without being brittle to minor
        // refactors. Residual hardening follow-up to #130 (this
        // package's vitest tests previously ran only via plain `test`,
        // never gated on coverage).
        statements: 88,
        branches: 80,
        functions: 88,
        lines: 89,
      },
    },
  },
});
