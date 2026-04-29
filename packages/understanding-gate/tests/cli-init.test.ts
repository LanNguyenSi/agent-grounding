import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit, runUninstall } from "../src/cli/init.js";
import { HOOK_COMMAND_NAME } from "../src/cli/settings.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ug-cli-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("runInit (project scope)", () => {
  it("creates .claude/settings.json from scratch", () => {
    const result = runInit({ scope: "project", cwd: tmp });
    expect(result.changed).toBe(true);
    expect(existsSync(result.path)).toBe(true);
    const doc = JSON.parse(readFileSync(result.path, "utf8"));
    expect(doc.hooks.UserPromptSubmit).toHaveLength(1);
    expect(doc.hooks.UserPromptSubmit[0].hooks[0].command).toBe(
      HOOK_COMMAND_NAME,
    );
  });

  it("is idempotent: second run leaves the file byte-identical", () => {
    runInit({ scope: "project", cwd: tmp });
    const before = readFileSync(
      join(tmp, ".claude", "settings.json"),
      "utf8",
    );
    const result = runInit({ scope: "project", cwd: tmp });
    expect(result.changed).toBe(false);
    const after = readFileSync(
      join(tmp, ".claude", "settings.json"),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("merges into a settings.json with unrelated existing hooks", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    const settingsPath = join(tmp, ".claude", "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [
              {
                matcher: "",
                hooks: [
                  {
                    type: "command",
                    command: "memory-router-user-prompt-submit",
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = runInit({ scope: "project", cwd: tmp });
    expect(result.changed).toBe(true);

    const doc = JSON.parse(readFileSync(settingsPath, "utf8"));
    const cmds = doc.hooks.UserPromptSubmit.flatMap(
      (m: { hooks: { command: string }[] }) => m.hooks.map((h) => h.command),
    );
    expect(cmds).toContain("memory-router-user-prompt-submit");
    expect(cmds).toContain(HOOK_COMMAND_NAME);
  });

  it("treats an empty file as an empty document", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "settings.json"), "", "utf8");
    const result = runInit({ scope: "project", cwd: tmp });
    expect(result.changed).toBe(true);
  });

  it("rejects malformed JSON loudly (does NOT silently overwrite)", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(
      join(tmp, ".claude", "settings.json"),
      "{ this is not json",
      "utf8",
    );
    expect(() => runInit({ scope: "project", cwd: tmp })).toThrow();
  });
});

describe("runUninstall (project scope)", () => {
  it("removes only our entry, leaves others intact", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    const settingsPath = join(tmp, ".claude", "settings.json");
    writeFileSync(
      settingsPath,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: "",
              hooks: [
                { type: "command", command: "other-hook" },
                { type: "command", command: HOOK_COMMAND_NAME },
              ],
            },
          ],
        },
      }),
      "utf8",
    );

    const result = runUninstall({ scope: "project", cwd: tmp });
    expect(result.changed).toBe(true);
    const doc = JSON.parse(readFileSync(settingsPath, "utf8"));
    const cmds = doc.hooks.UserPromptSubmit.flatMap(
      (m: { hooks: { command: string }[] }) => m.hooks.map((h) => h.command),
    );
    expect(cmds).toContain("other-hook");
    expect(cmds).not.toContain(HOOK_COMMAND_NAME);
  });

  it("returns changed:false when settings.json does not exist", () => {
    const result = runUninstall({ scope: "project", cwd: tmp });
    expect(result.changed).toBe(false);
  });

  it("returns changed:false when our entry is not present", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(
      join(tmp, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: "",
              hooks: [{ type: "command", command: "other-hook" }],
            },
          ],
        },
      }),
      "utf8",
    );
    const result = runUninstall({ scope: "project", cwd: tmp });
    expect(result.changed).toBe(false);
  });

  it("is idempotent: second uninstall is a no-op", () => {
    runInit({ scope: "project", cwd: tmp });
    runUninstall({ scope: "project", cwd: tmp });
    const result = runUninstall({ scope: "project", cwd: tmp });
    expect(result.changed).toBe(false);
  });
});

describe("round-trip init → uninstall", () => {
  it("returns settings.json to a state without our hook", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    const settingsPath = join(tmp, ".claude", "settings.json");
    const original = {
      theme: "dark",
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "x" }],
          },
        ],
      },
    };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2), "utf8");
    runInit({ scope: "project", cwd: tmp });
    runUninstall({ scope: "project", cwd: tmp });
    const after = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(after).toEqual(original);
  });
});
