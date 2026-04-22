import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // CLI tests spawn the built binary, so they take a bit longer than the
    // unit suite. Keep a single default timeout that covers both.
    testTimeout: 20000,
  },
});
