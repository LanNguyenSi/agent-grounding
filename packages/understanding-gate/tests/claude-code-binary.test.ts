import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

// End-to-end check: build the package, then spawn the binary as Claude Code
// would, piping JSON on stdin. This is the "did the wiring survive ts->js
// compilation" test, complementary to handle.test which exercises the pure
// function.

const PKG_ROOT = resolve(__dirname, "..");
const BINARY = resolve(
  PKG_ROOT,
  "dist/adapters/claude-code/user-prompt-submit.js",
);

function runHook(
  stdin: string,
  env: NodeJS.ProcessEnv = {},
): { stdout: string; stderr: string; code: number | null } {
  const result = spawnSync("node", [BINARY], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status,
  };
}

describe("claude-code adapter binary (end-to-end)", () => {
  beforeAll(() => {
    if (!existsSync(BINARY)) {
      execFileSync("npm", ["run", "build"], { cwd: PKG_ROOT, stdio: "ignore" });
    }
  });

  it("emits the gate snippet for a task-like prompt", () => {
    const { stdout, code } = runHook(
      JSON.stringify({ prompt: "add a logout button to src/Header.tsx" }),
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/hookSpecificOutput/);
    expect(stdout).toMatch(/Fast Confirm Mode/);
  });

  it("emits empty stdout for a non-task prompt", () => {
    const { stdout, code } = runHook(
      JSON.stringify({ prompt: "what does jq -r do?" }),
    );
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  it("respects UNDERSTANDING_GATE_DISABLE=1", () => {
    const { stdout, code } = runHook(
      JSON.stringify({ prompt: "fix the bug in auth.ts" }),
      { UNDERSTANDING_GATE_DISABLE: "1" },
    );
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });

  it("respects UNDERSTANDING_GATE_MODE=grill_me", () => {
    const { stdout, code } = runHook(
      JSON.stringify({ prompt: "refactor the auth module" }),
      { UNDERSTANDING_GATE_MODE: "grill_me" },
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/Grill-Me Mode/);
  });

  it("does not crash on malformed JSON", () => {
    const { stdout, code } = runHook("garbage {{{");
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });
});
