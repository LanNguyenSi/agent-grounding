import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Regression guard: `understanding-gate --version` must return the
// version in package.json, not a stale literal. Pre-PR (agent-tasks/73092e5e)
// the CLI hardcoded "0.2.3" via .version("0.2.3") and drifted past 0.3.0
// when the release bumped only package.json.

const PKG_ROOT = resolve(__dirname, "..");
const BINARY = resolve(PKG_ROOT, "dist/cli.js");
const PKG_JSON = JSON.parse(
  readFileSync(resolve(PKG_ROOT, "package.json"), "utf8"),
) as { version: string };

describe("understanding-gate CLI --version", () => {
  beforeAll(() => {
    if (!existsSync(BINARY)) {
      execFileSync("npm", ["run", "build"], { cwd: PKG_ROOT, stdio: "ignore" });
    }
  });

  it("reports the version from package.json (no stale literal)", () => {
    const result = spawnSync("node", [BINARY, "--version"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(PKG_JSON.version);
  });
});
