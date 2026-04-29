import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import {
  runOpencodeInit,
  runOpencodeUninstall,
} from "../src/cli/opencode.js";
import {
  RULES_FILENAME,
  COMMAND_FILENAME,
} from "../src/adapters/opencode/index.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ug-oc-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("runOpencodeInit (project scope)", () => {
  it("creates .opencode/rules/ + .opencode/command/ with the expected files", () => {
    const result = runOpencodeInit({ scope: "project", cwd: tmp });
    expect(result.rulesChanged).toBe(true);
    expect(result.commandChanged).toBe(true);

    const rulesPath = join(tmp, ".opencode", "rules", RULES_FILENAME);
    const commandPath = join(tmp, ".opencode", "command", COMMAND_FILENAME);
    expect(existsSync(rulesPath)).toBe(true);
    expect(existsSync(commandPath)).toBe(true);

    expect(readFileSync(rulesPath, "utf8")).toMatch(/Fast Confirm Mode/);
    expect(readFileSync(commandPath, "utf8")).toMatch(/Grill-Me Mode/);
  });

  it("is idempotent: second run reports no changes", () => {
    runOpencodeInit({ scope: "project", cwd: tmp });
    const result = runOpencodeInit({ scope: "project", cwd: tmp });
    expect(result.rulesChanged).toBe(false);
    expect(result.commandChanged).toBe(false);
  });

  it("rewrites a file whose content drifted", () => {
    runOpencodeInit({ scope: "project", cwd: tmp });
    const rulesPath = join(tmp, ".opencode", "rules", RULES_FILENAME);
    writeFileSync(rulesPath, "stale content", "utf8");
    const result = runOpencodeInit({ scope: "project", cwd: tmp });
    expect(result.rulesChanged).toBe(true);
    expect(readFileSync(rulesPath, "utf8")).toMatch(/Fast Confirm Mode/);
  });

  it("does not create unrelated files in the .opencode tree", () => {
    runOpencodeInit({ scope: "project", cwd: tmp });
    const rulesDir = join(tmp, ".opencode", "rules");
    const commandDir = join(tmp, ".opencode", "command");
    const rulesEntries = require("node:fs").readdirSync(rulesDir);
    const commandEntries = require("node:fs").readdirSync(commandDir);
    expect(rulesEntries).toEqual([RULES_FILENAME]);
    expect(commandEntries).toEqual([COMMAND_FILENAME]);
  });
});

describe("runOpencodeUninstall (project scope)", () => {
  it("removes only our two files", () => {
    runOpencodeInit({ scope: "project", cwd: tmp });
    // sibling rule + sibling command (third-party content): must survive
    const siblingRule = join(tmp, ".opencode", "rules", "house-style.md");
    const siblingCmd = join(tmp, ".opencode", "command", "explain.md");
    writeFileSync(siblingRule, "house style", "utf8");
    writeFileSync(siblingCmd, "explain command", "utf8");

    const result = runOpencodeUninstall({ scope: "project", cwd: tmp });
    expect(result.rulesRemoved).toBe(true);
    expect(result.commandRemoved).toBe(true);
    expect(existsSync(siblingRule)).toBe(true);
    expect(existsSync(siblingCmd)).toBe(true);
    expect(
      existsSync(join(tmp, ".opencode", "rules", RULES_FILENAME)),
    ).toBe(false);
    expect(
      existsSync(join(tmp, ".opencode", "command", COMMAND_FILENAME)),
    ).toBe(false);
  });

  it("returns false flags when nothing exists", () => {
    const result = runOpencodeUninstall({ scope: "project", cwd: tmp });
    expect(result.rulesRemoved).toBe(false);
    expect(result.commandRemoved).toBe(false);
  });

  it("removes a stray rules file even if command never existed", () => {
    mkdirSync(join(tmp, ".opencode", "rules"), { recursive: true });
    writeFileSync(
      join(tmp, ".opencode", "rules", RULES_FILENAME),
      "anything",
      "utf8",
    );
    const result = runOpencodeUninstall({ scope: "project", cwd: tmp });
    expect(result.rulesRemoved).toBe(true);
    expect(result.commandRemoved).toBe(false);
  });
});

describe("round-trip init → uninstall", () => {
  it("leaves no understanding-gate files behind", () => {
    runOpencodeInit({ scope: "project", cwd: tmp });
    runOpencodeUninstall({ scope: "project", cwd: tmp });
    expect(
      existsSync(join(tmp, ".opencode", "rules", RULES_FILENAME)),
    ).toBe(false);
    expect(
      existsSync(join(tmp, ".opencode", "command", COMMAND_FILENAME)),
    ).toBe(false);
  });
});
