import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAuditLine,
  defaultAuditLogPath,
  formatAuditLine,
} from "../src/core/audit.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ug-audit-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("formatAuditLine", () => {
  it("emits a single-line JSON object terminated by a newline", () => {
    const line = formatAuditLine(
      {
        kind: "block",
        tool: "Edit",
        reason: "no report",
        sessionId: "s1",
        taskId: "t1",
        adapter: "claude-code",
      },
      new Date("2026-05-02T12:00:00.000Z"),
    );
    expect(line.endsWith("\n")).toBe(true);
    expect(line.split("\n").length).toBe(2); // body + trailing empty
    const parsed = JSON.parse(line.trim()) as Record<string, unknown>;
    expect(parsed.at).toBe("2026-05-02T12:00:00.000Z");
    expect(parsed.kind).toBe("block");
    expect(parsed.tool).toBe("Edit");
    expect(parsed.adapter).toBe("claude-code");
  });

  it("survives reasons containing quotes / newlines without breaking JSONL", () => {
    const line = formatAuditLine({
      kind: "block",
      tool: "Edit",
      reason: 'has "quotes"\nand newlines',
      sessionId: null,
      taskId: null,
      adapter: "claude-code",
    });
    // Must remain a single JSONL line: only the trailing newline.
    expect(line.match(/\n/g)?.length).toBe(1);
    const parsed = JSON.parse(line.trim()) as { reason: string };
    expect(parsed.reason).toContain("\n");
  });
});

describe("appendAuditLine", () => {
  it("creates the parent directory and appends one JSONL row per call", () => {
    const path = defaultAuditLogPath(tmp);
    appendAuditLine(path, {
      kind: "approve",
      approvedBy: "cli",
      sessionId: null,
      taskId: "task-a",
      reportPath: "/x/a.json",
    });
    appendAuditLine(path, {
      kind: "block",
      tool: "Bash",
      reason: "blocked",
      sessionId: "s1",
      taskId: "task-a",
      adapter: "opencode",
    });
    const body = readFileSync(path, "utf8");
    const lines = body.trim().split("\n");
    expect(lines).toHaveLength(2);
    const a = JSON.parse(lines[0]) as { kind: string };
    const b = JSON.parse(lines[1]) as { kind: string };
    expect(a.kind).toBe("approve");
    expect(b.kind).toBe("block");
  });
});

describe("defaultAuditLogPath", () => {
  it("returns <cwd>/.understanding-gate/audit.log", () => {
    expect(defaultAuditLogPath("/var/x")).toBe("/var/x/.understanding-gate/audit.log");
  });
});
