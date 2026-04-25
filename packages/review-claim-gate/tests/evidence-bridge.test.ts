import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getDb, resetDb, addEntry } from "evidence-ledger";
import { runCheck, runExport, defaultEvidenceFilePath } from "../src/cli.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

let tmp: string;
let dbPath: string;
let prevCwd: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "review-claim-gate-bridge-"));
  dbPath = join(tmp, "ledger.db");
  prevCwd = process.cwd();
  // runCheck's file auto-detect anchors on process.cwd(). Point it at
  // the tmp dir so the auto-detect path is isolated from the real
  // repo's .agent-grounding if any exists.
  process.chdir(tmp);
  resetDb();
});

afterEach(() => {
  resetDb();
  process.chdir(prevCwd);
  rmSync(tmp, { recursive: true, force: true });
});

describe("export subcommand", () => {
  it("dumps all ledger entries for a session as JSONL", () => {
    const db = getDb(dbPath);
    addEntry(db, { type: "fact", content: "CI green", session: "t-export" });
    addEntry(db, { type: "hypothesis", content: "could be X", session: "t-export" });
    addEntry(db, { type: "fact", content: "irrelevant", session: "t-other" });
    resetDb();

    const result = runExport({ taskId: "t-export", ledgerDb: dbPath });
    expect(result.count).toBe(2);
    expect(result.path).toBeNull();
    // Each line is valid JSON and belongs to the right session.
    const lines = result.body.trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.session).toBe("t-export");
    }
  });

  it("writes to --out path and auto-creates the parent directory", () => {
    const db = getDb(dbPath);
    addEntry(db, { type: "fact", content: "one", session: "t-write" });
    resetDb();

    const out = join(tmp, "deeply", "nested", "evidence", "t-write.jsonl");
    const result = runExport({ taskId: "t-write", ledgerDb: dbPath, out });
    expect(result.count).toBe(1);
    expect(result.path).toBe(out);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf8")).toMatch(/"content":"one"/);
  });

  it("can export from a grounding session into a task-named evidence file", () => {
    const db = getDb(dbPath);
    addEntry(db, { type: "fact", content: "session-bound", session: "gs-agent-grounding-123" });
    addEntry(db, { type: "fact", content: "other", session: "t-export" });
    resetDb();

    const out = join(tmp, ".agent-grounding", "evidence", "feat", "export-from-session.jsonl");
    const result = runExport({
      taskId: "feat/export-from-session",
      fromSession: "gs-agent-grounding-123",
      ledgerDb: dbPath,
      out,
    });

    expect(result.count).toBe(1);
    expect(result.path).toBe(out);
    const lines = readFileSync(out, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.session).toBe("gs-agent-grounding-123");
    expect(parsed.content).toBe("session-bound");
  });

  it("zero entries yields an empty body, zero count, no trailing newline", () => {
    resetDb();
    const out = join(tmp, "empty.jsonl");
    const result = runExport({ taskId: "t-nobody", ledgerDb: dbPath, out });
    expect(result.count).toBe(0);
    expect(result.body).toBe("");
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf8")).toBe("");
  });
});

describe("runCheck — committed evidence file takes precedence over ledger", () => {
  it("auto-detects .agent-grounding/evidence/<task-id>.jsonl at cwd", () => {
    // Reviewer committed a file with 2 entries. Ledger is empty. The
    // CLI must see the file, not fall through to the ledger.
    const evDir = join(tmp, ".agent-grounding", "evidence");
    const out = join(evDir, "t-file.jsonl");
    const db = getDb(dbPath);
    addEntry(db, { type: "fact", content: "A", session: "t-file" });
    addEntry(db, { type: "fact", content: "B", session: "t-file" });
    resetDb();
    runExport({ taskId: "t-file", ledgerDb: dbPath, out });
    // Now wipe the ledger so the only remaining evidence source is
    // the committed file.
    rmSync(dbPath, { force: true });

    const report = runCheck({ taskId: "t-file", ledgerDb: dbPath });
    expect(report.evidenceSource).toBe("file");
    expect(report.evidenceEntries).toBe(2);
    expect(report.evidenceFilePath).toMatch(/t-file\.jsonl$/);
    expect(report.result.prerequisites.evidence_logged).toBe(true);
  });

  it("--evidence-file overrides the auto-detect path", () => {
    const custom = join(tmp, "my-evidence.jsonl");
    writeFileSync(custom, '{"type":"fact","content":"x","session":"t-cust"}\n');

    const report = runCheck({
      taskId: "t-cust",
      ledgerDb: dbPath,
      evidenceFile: custom,
    });
    expect(report.evidenceSource).toBe("file");
    expect(report.evidenceEntries).toBe(1);
    expect(report.evidenceFilePath).toBe(custom);
  });

  it("throws when --evidence-file points at a missing path", () => {
    expect(() =>
      runCheck({
        taskId: "t-err",
        ledgerDb: dbPath,
        evidenceFile: join(tmp, "does-not-exist.jsonl"),
      }),
    ).toThrow(/does not exist/);
  });

  it("falls back to ledger when no evidence file is present", () => {
    const db = getDb(dbPath);
    addEntry(db, { type: "fact", content: "ledger", session: "t-fallback" });
    resetDb();

    const report = runCheck({ taskId: "t-fallback", ledgerDb: dbPath });
    expect(report.evidenceSource).toBe("ledger");
    expect(report.evidenceEntries).toBe(1);
  });

  it("--evidence-logged still wins even when an evidence file exists", () => {
    // Put 0 entries in the file (empty) and assert that the forced
    // flag still flips evidence_logged to true.
    const evDir = join(tmp, ".agent-grounding", "evidence");
    runExport({ taskId: "t-forced", ledgerDb: dbPath, out: join(evDir, "t-forced.jsonl") });

    const report = runCheck({
      taskId: "t-forced",
      ledgerDb: dbPath,
      evidenceLogged: true,
    });
    expect(report.evidenceSource).toBe("forced");
    expect(report.evidenceEntries).toBe(0);
    expect(report.result.prerequisites.evidence_logged).toBe(true);
  });

  it("tolerates malformed lines in the evidence file (counts only valid JSON)", () => {
    const file = join(tmp, "mixed.jsonl");
    writeFileSync(
      file,
      [
        '{"type":"fact","content":"ok","session":"t-mixed"}',
        "not json here",
        "",
        '{"type":"fact","content":"also ok","session":"t-mixed"}',
      ].join("\n"),
    );
    const report = runCheck({
      taskId: "t-mixed",
      ledgerDb: dbPath,
      evidenceFile: file,
    });
    expect(report.evidenceEntries).toBe(2);
  });
});

describe("defaultEvidenceFilePath", () => {
  it("produces the convention path under cwd", () => {
    expect(defaultEvidenceFilePath("t-1", "/repo")).toBe(
      "/repo/.agent-grounding/evidence/t-1.jsonl",
    );
  });

  it("preserves slashes in branch-name task-ids (nested dir)", () => {
    // head.ref like "feat/foo" becomes nested by design — consumer
    // mkdir -p's the parent when exporting.
    expect(defaultEvidenceFilePath("feat/foo", "/repo")).toBe(
      "/repo/.agent-grounding/evidence/feat/foo.jsonl",
    );
  });
});

describe("CLI export — black-box via spawnSync", () => {
  it("writes JSONL to --out and exits 0", () => {
    const db = getDb(dbPath);
    addEntry(db, { type: "fact", content: "black-box", session: "t-bb" });
    resetDb();
    const out = join(tmp, "bb.jsonl");

    const result = spawnSync(
      process.execPath,
      [CLI, "export", "--task-id", "t-bb", "--ledger-db", dbPath, "--out", out],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf8")).toMatch(/"content":"black-box"/);
  });

  it("supports --from-session in the CLI", () => {
    const db = getDb(dbPath);
    addEntry(db, { type: "fact", content: "via-cli", session: "gs-bridge" });
    resetDb();
    const out = join(tmp, "cli-from-session.jsonl");

    const result = spawnSync(
      process.execPath,
      [
        CLI,
        "export",
        "--task-id",
        "feat/export-from-session",
        "--from-session",
        "gs-bridge",
        "--ledger-db",
        dbPath,
        "--out",
        out,
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(readFileSync(out, "utf8")).toMatch(/"session":"gs-bridge"/);
    expect(readFileSync(out, "utf8")).toMatch(/"content":"via-cli"/);
  });

  it("without --out streams JSONL to stdout", () => {
    const db = getDb(dbPath);
    addEntry(db, { type: "fact", content: "stream", session: "t-stream" });
    resetDb();

    const result = spawnSync(
      process.execPath,
      [CLI, "export", "--task-id", "t-stream", "--ledger-db", dbPath],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/"content":"stream"/);
  });
});
