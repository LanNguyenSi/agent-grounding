import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getDb, resetDb, addEntry } from "evidence-ledger";
import { runCheck } from "../src/cli.js";

// The compiled CLI binary. Tests use this for black-box exit-code /
// JSON-output assertions; in-process `runCheck` is used for the
// evidence-ledger plumbing so we can seed the DB without forking.
const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function mkTmpDbDir(): string {
  return mkdtempSync(join(tmpdir(), "review-claim-gate-"));
}

describe("runCheck — evidence-ledger integration", () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = mkTmpDbDir();
    dbPath = join(tmp, "ledger.db");
    resetDb();
  });

  afterEach(() => {
    resetDb();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("derives evidence_logged=false when the task has zero entries", () => {
    const report = runCheck({
      taskId: "t-no-entries",
      ledgerDb: dbPath,
    });
    expect(report.evidenceEntries).toBe(0);
    expect(report.result.prerequisites.evidence_logged).toBe(false);
    expect(report.result.allowed).toBe(false);
  });

  it("derives evidence_logged=true when the task has ≥1 entry", () => {
    const db = getDb(dbPath);
    addEntry(db, {
      type: "fact",
      content: "CI green",
      session: "t-123",
    });
    resetDb(); // so runCheck opens the same file fresh
    const report = runCheck({ taskId: "t-123", ledgerDb: dbPath });
    expect(report.evidenceEntries).toBe(1);
    expect(report.result.prerequisites.evidence_logged).toBe(true);
  });

  it("returns allowed=true when every prereq is satisfied (ledger + flags)", () => {
    const db = getDb(dbPath);
    addEntry(db, {
      type: "fact",
      content: "review rubric complete",
      session: "t-ok",
    });
    resetDb();
    const report = runCheck({
      taskId: "t-ok",
      ledgerDb: dbPath,
      testsPass: true,
      reviewChecklistComplete: true,
      commentsResolved: true,
      scopeMatchesTask: true,
    });
    expect(report.evidenceEntries).toBe(1);
    expect(report.result.allowed).toBe(true);
    expect(report.result.score).toBe(100);
  });

  it("--evidence-logged flag forces true even when the ledger is empty", () => {
    const report = runCheck({
      taskId: "t-empty",
      ledgerDb: dbPath,
      evidenceLogged: true,
    });
    expect(report.evidenceEntries).toBe(0);
    expect(report.result.prerequisites.evidence_logged).toBe(true);
  });

  it("filters by session — entries for a different task do not count", () => {
    const db = getDb(dbPath);
    addEntry(db, {
      type: "fact",
      content: "unrelated",
      session: "t-other",
    });
    resetDb();
    const report = runCheck({ taskId: "t-mine", ledgerDb: dbPath });
    expect(report.evidenceEntries).toBe(0);
    expect(report.result.prerequisites.evidence_logged).toBe(false);
  });
});

describe("CLI binary — black-box", () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = mkTmpDbDir();
    dbPath = join(tmp, "ledger.db");
    resetDb();
  });

  afterEach(() => {
    resetDb();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exits 1 and emits JSON when --json is set and gate fails", () => {
    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "check",
        "--task-id",
        "t-fail",
        "--ledger-db",
        dbPath,
        "--json",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.taskId).toBe("t-fail");
    expect(parsed.result.allowed).toBe(false);
    expect(parsed.result.type).toBe("merge_approval");
    expect(parsed.result.prerequisites).toHaveProperty("evidence_logged");
  });

  it("exits 0 and emits allowed:true when every prereq passes", () => {
    const db = getDb(dbPath);
    addEntry(db, {
      type: "fact",
      content: "reviewer went through the rubric",
      session: "t-pass",
    });
    // Close our handle so the CLI subprocess can open the file freshly.
    resetDb();
    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "check",
        "--task-id",
        "t-pass",
        "--ledger-db",
        dbPath,
        "--tests-pass",
        "--review-checklist-complete",
        "--comments-resolved",
        "--scope-matches-task",
        "--json",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.result.allowed).toBe(true);
    expect(parsed.result.score).toBe(100);
    expect(parsed.evidenceEntries).toBe(1);
  });

  it("text mode prints verdict and prereq checklist", () => {
    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "check",
        "--task-id",
        "t-text",
        "--ledger-db",
        dbPath,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/verdict: BLOCKED/);
    expect(result.stdout).toMatch(/✗ tests_pass/);
    expect(result.stdout).toMatch(/✗ evidence_logged/);
  });

  it("`describe` subcommand lists every prereq with a description", () => {
    const result = spawnSync(process.execPath, [CLI, "describe"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/tests_pass/);
    expect(result.stdout).toMatch(/review_checklist_complete/);
    expect(result.stdout).toMatch(/no_unresolved_review_comments/);
    expect(result.stdout).toMatch(/scope_matches_task/);
    expect(result.stdout).toMatch(/evidence_logged/);
  });
});
