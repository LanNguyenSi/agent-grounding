import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit, runUninstall } from "../src/cli/init.js";
import {
  PRE_TOOL_USE_HOOK_COMMAND_NAME,
  type SettingsDocument,
} from "../src/cli/settings.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ug-init-ptu-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function read(path: string): SettingsDocument {
  return JSON.parse(readFileSync(path, "utf8")) as SettingsDocument;
}

describe("runInit (PreToolUse hook)", () => {
  it("registers the PreToolUse entry alongside UPS + Stop on a fresh install", () => {
    const result = runInit({ scope: "project", cwd: tmp });
    expect(result.changed).toBe(true);
    const doc = read(result.path);
    const ptu = doc.hooks?.PreToolUse ?? [];
    const cmds = ptu.flatMap((m) => m.hooks.map((h) => h.command));
    expect(cmds).toContain(PRE_TOOL_USE_HOOK_COMMAND_NAME);
  });

  it("uses the standard {matcher,hooks:[{type,command}]} shape", () => {
    const result = runInit({ scope: "project", cwd: tmp });
    const doc = read(result.path);
    const ptu = doc.hooks?.PreToolUse;
    expect(Array.isArray(ptu)).toBe(true);
    expect(ptu?.[0]?.matcher).toBe("");
    expect(ptu?.[0]?.hooks?.[0]).toMatchObject({
      type: "command",
      command: PRE_TOOL_USE_HOOK_COMMAND_NAME,
    });
  });

  it("merges into a settings.json that already has a foreign PreToolUse hook", () => {
    // Original-customer scenario: settings.json exists from before the
    // gate was installed and already carries a foreign PreToolUse entry.
    // The first runInit must add OUR entry without touching theirs.
    const path = join(tmp, ".claude", "settings.json");
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    const seed: SettingsDocument = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "/usr/local/bin/some-other-tool" },
            ],
          },
        ],
      },
    };
    writeFileSync(path, JSON.stringify(seed, null, 2));

    const result = runInit({ scope: "project", cwd: tmp });
    expect(result.changed).toBe(true);
    const after = read(path);
    const cmds = (after.hooks?.PreToolUse ?? []).flatMap((m) =>
      m.hooks.map((h) => h.command),
    );
    expect(cmds).toContain("/usr/local/bin/some-other-tool");
    expect(cmds).toContain(PRE_TOOL_USE_HOOK_COMMAND_NAME);
  });

  it("is idempotent (second init reports no change)", () => {
    runInit({ scope: "project", cwd: tmp });
    const second = runInit({ scope: "project", cwd: tmp });
    expect(second.changed).toBe(false);
  });
});

describe("runUninstall (PreToolUse hook)", () => {
  it("removes the PreToolUse entry on uninstall", () => {
    const init = runInit({ scope: "project", cwd: tmp });
    expect(read(init.path).hooks?.PreToolUse).toBeDefined();
    const result = runUninstall({ scope: "project", cwd: tmp });
    expect(result.changed).toBe(true);
    const doc = read(result.path);
    expect(doc.hooks?.PreToolUse).toBeUndefined();
  });

  it("preserves foreign PreToolUse entries on uninstall", () => {
    const init = runInit({ scope: "project", cwd: tmp });
    const path = init.path;
    const after = read(path);
    after.hooks!.PreToolUse = [
      ...(after.hooks?.PreToolUse ?? []),
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: "/usr/local/bin/some-other-tool" }],
      },
    ];
    writeFileSync(path, JSON.stringify(after, null, 2));

    runUninstall({ scope: "project", cwd: tmp });
    const final = read(path);
    const cmds = (final.hooks?.PreToolUse ?? []).flatMap((m) =>
      m.hooks.map((h) => h.command),
    );
    expect(cmds).toContain("/usr/local/bin/some-other-tool");
    expect(cmds).not.toContain(PRE_TOOL_USE_HOOK_COMMAND_NAME);
  });

  it("does not touch a settings.json that never had our PreToolUse entry", () => {
    const path = join(tmp, ".claude", "settings.json");
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    const seed: SettingsDocument = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "/usr/local/bin/some-other-tool" }],
          },
        ],
      },
    };
    writeFileSync(path, JSON.stringify(seed, null, 2));
    const result = runUninstall({ scope: "project", cwd: tmp });
    expect(result.changed).toBe(false);
    const final = read(path);
    const cmds = (final.hooks?.PreToolUse ?? []).flatMap((m) =>
      m.hooks.map((h) => h.command),
    );
    expect(cmds).toEqual(["/usr/local/bin/some-other-tool"]);
  });

  it("does nothing when settings.json does not exist", () => {
    const result = runUninstall({ scope: "project", cwd: tmp });
    expect(result.changed).toBe(false);
    expect(existsSync(result.path)).toBe(false);
  });
});
