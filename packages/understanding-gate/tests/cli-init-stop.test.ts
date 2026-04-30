import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit, runUninstall } from "../src/cli/init.js";
import {
  HOOK_COMMAND_NAME,
  STOP_HOOK_COMMAND_NAME,
} from "../src/cli/settings.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ug-init-stop-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function readDoc(path: string): {
  hooks?: {
    UserPromptSubmit?: { hooks: { command: string }[] }[];
    Stop?: { hooks: { command: string }[] }[];
  };
} {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("runInit (Stop hook)", () => {
  it("registers both UserPromptSubmit and Stop entries on a fresh install", () => {
    const result = runInit({ scope: "project", cwd: tmp });
    expect(result.changed).toBe(true);
    const doc = readDoc(result.path);
    const ups = doc.hooks?.UserPromptSubmit ?? [];
    const stop = doc.hooks?.Stop ?? [];
    expect(ups.flatMap((m) => m.hooks.map((h) => h.command))).toContain(
      HOOK_COMMAND_NAME,
    );
    expect(stop.flatMap((m) => m.hooks.map((h) => h.command))).toContain(
      STOP_HOOK_COMMAND_NAME,
    );
  });

  it("Stop hook entry uses the standard {matcher,hooks:[{type,command}]} shape", () => {
    runInit({ scope: "project", cwd: tmp });
    const doc = readDoc(join(tmp, ".claude", "settings.json"));
    const stop = doc.hooks?.Stop;
    expect(stop).toBeDefined();
    expect(Array.isArray(stop)).toBe(true);
    expect(stop![0]).toMatchObject({
      matcher: "",
      hooks: [{ type: "command", command: STOP_HOOK_COMMAND_NAME }],
    });
  });

  it("is idempotent across both hooks: second init leaves the file byte-identical", () => {
    runInit({ scope: "project", cwd: tmp });
    const path = join(tmp, ".claude", "settings.json");
    const before = readFileSync(path, "utf8");
    const result = runInit({ scope: "project", cwd: tmp });
    expect(result.changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("merges into a settings.json that already has a foreign Stop hook", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    const path = join(tmp, ".claude", "settings.json");
    writeFileSync(
      path,
      JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                matcher: "",
                hooks: [{ type: "command", command: "third-party-stop" }],
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    runInit({ scope: "project", cwd: tmp });
    const doc = readDoc(path);
    const cmds = (doc.hooks?.Stop ?? []).flatMap((m) =>
      m.hooks.map((h) => h.command),
    );
    expect(cmds).toContain("third-party-stop");
    expect(cmds).toContain(STOP_HOOK_COMMAND_NAME);
  });

  it("recovers when only one of the two hooks was previously installed (added=true)", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    const path = join(tmp, ".claude", "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            {
              matcher: "",
              hooks: [{ type: "command", command: HOOK_COMMAND_NAME }],
            },
          ],
        },
      }),
      "utf8",
    );
    const result = runInit({ scope: "project", cwd: tmp });
    expect(result.changed).toBe(true);
    const doc = readDoc(path);
    expect(doc.hooks?.Stop).toBeDefined();
  });
});

describe("runUninstall (Stop hook)", () => {
  it("removes both UserPromptSubmit and Stop entries", () => {
    runInit({ scope: "project", cwd: tmp });
    const result = runUninstall({ scope: "project", cwd: tmp });
    expect(result.changed).toBe(true);
    const doc = readDoc(join(tmp, ".claude", "settings.json"));
    const ups = doc.hooks?.UserPromptSubmit ?? [];
    const stop = doc.hooks?.Stop ?? [];
    const allCmds = [
      ...ups.flatMap((m) => m.hooks.map((h) => h.command)),
      ...stop.flatMap((m) => m.hooks.map((h) => h.command)),
    ];
    expect(allCmds).not.toContain(HOOK_COMMAND_NAME);
    expect(allCmds).not.toContain(STOP_HOOK_COMMAND_NAME);
  });

  it("preserves foreign Stop entries when uninstalling", () => {
    runInit({ scope: "project", cwd: tmp });
    const path = join(tmp, ".claude", "settings.json");
    const doc = readDoc(path);
    doc.hooks!.Stop!.push({
      matcher: "",
      hooks: [{ command: "other-stop" }],
    } as { matcher: string; hooks: { command: string }[] });
    writeFileSync(path, JSON.stringify(doc, null, 2), "utf8");
    runUninstall({ scope: "project", cwd: tmp });
    const after = readDoc(path);
    const cmds = (after.hooks?.Stop ?? []).flatMap((m) =>
      m.hooks.map((h) => h.command),
    );
    expect(cmds).toEqual(["other-stop"]);
  });
});

describe("round-trip init -> uninstall (both hooks)", () => {
  it("returns settings.json to byte-identical state when nothing else exists", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    const path = join(tmp, ".claude", "settings.json");
    const original = { theme: "dark" };
    const originalText = `${JSON.stringify(original, null, 2)}\n`;
    writeFileSync(path, originalText, "utf8");
    runInit({ scope: "project", cwd: tmp });
    runUninstall({ scope: "project", cwd: tmp });
    expect(readFileSync(path, "utf8")).toBe(originalText);
  });

  it("preserves unrelated PreToolUse entries through the round-trip", () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    const path = join(tmp, ".claude", "settings.json");
    const original = {
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "x" }] },
        ],
      },
    };
    writeFileSync(path, JSON.stringify(original, null, 2), "utf8");
    runInit({ scope: "project", cwd: tmp });
    runUninstall({ scope: "project", cwd: tmp });
    const after = readDoc(path);
    expect(after).toEqual(original);
  });
});
