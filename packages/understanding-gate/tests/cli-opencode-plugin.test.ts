import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runOpencodeInit,
  runOpencodeUninstall,
} from "../src/cli/opencode.js";
import { PLUGIN_SHIM_FILENAME } from "../src/adapters/opencode/index.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ug-oc-plugin-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("runOpencodeInit (plugin shim)", () => {
  it("writes the plugin shim under .opencode/plugins/", () => {
    const result = runOpencodeInit({ scope: "project", cwd: tmp });
    expect(result.pluginChanged).toBe(true);
    const path = join(tmp, ".opencode", "plugins", PLUGIN_SHIM_FILENAME);
    expect(existsSync(path)).toBe(true);
    const contents = readFileSync(path, "utf8");
    expect(contents).toMatch(/persistReportPlugin as default/);
    expect(contents).toMatch(/@lannguyensi\/understanding-gate/);
  });

  it("is idempotent on the plugin file too", () => {
    runOpencodeInit({ scope: "project", cwd: tmp });
    const result = runOpencodeInit({ scope: "project", cwd: tmp });
    expect(result.pluginChanged).toBe(false);
  });

  it("rewrites the shim if its content drifts", () => {
    runOpencodeInit({ scope: "project", cwd: tmp });
    const path = join(tmp, ".opencode", "plugins", PLUGIN_SHIM_FILENAME);
    writeFileSync(path, "// stale", "utf8");
    const result = runOpencodeInit({ scope: "project", cwd: tmp });
    expect(result.pluginChanged).toBe(true);
    expect(readFileSync(path, "utf8")).toMatch(/persistReportPlugin/);
  });
});

describe("runOpencodeUninstall (plugin shim)", () => {
  it("removes the plugin shim and reports pluginRemoved", () => {
    runOpencodeInit({ scope: "project", cwd: tmp });
    const result = runOpencodeUninstall({ scope: "project", cwd: tmp });
    expect(result.pluginRemoved).toBe(true);
    expect(
      existsSync(join(tmp, ".opencode", "plugins", PLUGIN_SHIM_FILENAME)),
    ).toBe(false);
  });

  it("preserves sibling plugin files in .opencode/plugins/", () => {
    runOpencodeInit({ scope: "project", cwd: tmp });
    mkdirSync(join(tmp, ".opencode", "plugins"), { recursive: true });
    const sibling = join(tmp, ".opencode", "plugins", "third-party.ts");
    writeFileSync(sibling, "// other plugin", "utf8");
    runOpencodeUninstall({ scope: "project", cwd: tmp });
    expect(existsSync(sibling)).toBe(true);
  });

  it("returns pluginRemoved:false when nothing was installed", () => {
    const result = runOpencodeUninstall({ scope: "project", cwd: tmp });
    expect(result.pluginRemoved).toBe(false);
  });
});

describe("round-trip init -> uninstall (with plugin)", () => {
  it("removes all three artifacts but leaves siblings intact", () => {
    runOpencodeInit({ scope: "project", cwd: tmp });
    const sibPlugin = join(tmp, ".opencode", "plugins", "other.ts");
    writeFileSync(sibPlugin, "// other", "utf8");
    runOpencodeUninstall({ scope: "project", cwd: tmp });
    expect(
      existsSync(join(tmp, ".opencode", "plugins", PLUGIN_SHIM_FILENAME)),
    ).toBe(false);
    expect(existsSync(sibPlugin)).toBe(true);
  });
});
