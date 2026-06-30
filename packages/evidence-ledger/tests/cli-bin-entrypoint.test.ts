// Regression guard for the published `ledger` bin entrypoint.
//
// The CLI is gated behind `resolveArgv1() === fileURLToPath(import.meta.url)`.
// A naive `process.argv[1] === fileURLToPath(import.meta.url)` is FALSE when the
// bin is invoked through its node_modules/.bin symlink (argv[1] is the symlink
// path, import.meta.url the realpath), which silently no-ops the shipped CLI.
// This test invokes the built bin THROUGH a symlink and asserts it actually runs.
// Skipped when dist/ is absent (local runs without a prior `npm run build`); CI
// builds before testing so the guard is exercised there.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, symlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const distCli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

describe("ledger bin entrypoint via symlink", () => {
  it.skipIf(!existsSync(distCli))(
    "runs through a node_modules/.bin-style symlink (not a silent no-op)",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "ledger-bin-"));
      const link = join(dir, "ledger");
      try {
        symlinkSync(distCli, link);
        // --help short-circuits in commander (no ledger DB access), exits 0.
        const out = execFileSync(process.execPath, [link, "--help"], { encoding: "utf8" });
        expect(out.length).toBeGreaterThan(0);
        expect(out).toContain("Usage");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
