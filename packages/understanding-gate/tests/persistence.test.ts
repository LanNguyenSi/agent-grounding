import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { UNDERSTANDING_REPORT_SCHEMA } from "../src/schema/report-schema.js";
import {
  DEFAULT_REPORT_DIR,
  REPORT_DIR_ENV,
  listReports,
  loadReport,
  resolveReportDir,
  saveReport,
} from "../src/core/persistence.js";
import type { UnderstandingReport } from "../src/schema/types.js";

const baseReport: UnderstandingReport = {
  taskId: "ug-persist-1",
  mode: "fast_confirm",
  riskLevel: "medium",
  currentUnderstanding: "test report",
  intendedOutcome: "round-trip",
  derivedTodos: ["a"],
  acceptanceCriteria: ["b"],
  assumptions: ["c"],
  openQuestions: ["d"],
  outOfScope: ["e"],
  risks: ["f"],
  verificationPlan: ["g"],
  requiresHumanApproval: true,
  approvalStatus: "pending",
  createdAt: "2026-04-30T10:00:00.000Z",
};

let tmpDir: string;
const originalEnv = process.env[REPORT_DIR_ENV];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ug-persistence-"));
  delete process.env[REPORT_DIR_ENV];
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (originalEnv === undefined) delete process.env[REPORT_DIR_ENV];
  else process.env[REPORT_DIR_ENV] = originalEnv;
});

describe("resolveReportDir", () => {
  it("uses an explicit dir option above all else", () => {
    process.env[REPORT_DIR_ENV] = "/should/not/win";
    expect(resolveReportDir({ dir: tmpDir })).toBe(tmpDir);
  });

  it("falls back to UNDERSTANDING_GATE_REPORT_DIR env", () => {
    process.env[REPORT_DIR_ENV] = tmpDir;
    expect(resolveReportDir()).toBe(tmpDir);
  });

  it("falls back to <cwd>/.understanding-gate/reports", () => {
    expect(resolveReportDir({ cwd: tmpDir })).toBe(
      join(tmpDir, DEFAULT_REPORT_DIR),
    );
  });
});

describe("saveReport", () => {
  it("writes a JSON file with iso-stamped filename inside the report dir", () => {
    const result = saveReport(baseReport, { dir: tmpDir });
    expect(result.written).toBe(true);
    expect(existsSync(result.path)).toBe(true);
    expect(result.path.startsWith(tmpDir)).toBe(true);
    expect(result.path.endsWith("-ug-persist-1.json")).toBe(true);
    const contents = JSON.parse(readFileSync(result.path, "utf8"));
    expect(contents.taskId).toBe(baseReport.taskId);
    expect(contents.intendedOutcome).toBe("round-trip");
  });

  it("is idempotent on byte-identical content", () => {
    const a = saveReport(baseReport, { dir: tmpDir });
    expect(a.written).toBe(true);
    const beforeMtime = statSync(a.path).mtimeMs;
    // Change the system clock perception to a later "now" — without
    // idempotency the second save would create a new file.
    const b = saveReport(baseReport, {
      dir: tmpDir,
      now: new Date("2027-01-01T00:00:00Z"),
    });
    expect(b.written).toBe(false);
    expect(b.path).toBe(a.path);
    const afterMtime = statSync(a.path).mtimeMs;
    expect(afterMtime).toBe(beforeMtime);
    expect(readdirSync(tmpDir).filter((n) => n.endsWith(".json"))).toHaveLength(
      1,
    );
  });

  it("creates a new file when content differs even for the same taskId", () => {
    const a = saveReport(baseReport, { dir: tmpDir });
    const updated: UnderstandingReport = {
      ...baseReport,
      currentUnderstanding: "test report (revised)",
    };
    const b = saveReport(updated, {
      dir: tmpDir,
      now: new Date("2026-04-30T10:01:00Z"),
    });
    expect(a.written).toBe(true);
    expect(b.written).toBe(true);
    expect(b.path).not.toBe(a.path);
    expect(readdirSync(tmpDir)).toHaveLength(2);
  });

  it("honors UNDERSTANDING_GATE_REPORT_DIR when no dir option is passed", () => {
    process.env[REPORT_DIR_ENV] = tmpDir;
    const result = saveReport(baseReport);
    expect(result.path.startsWith(tmpDir)).toBe(true);
  });

  it("creates the report dir if it does not exist", () => {
    const nested = join(tmpDir, "nested", "subdir");
    expect(existsSync(nested)).toBe(false);
    const result = saveReport(baseReport, { dir: nested });
    expect(result.written).toBe(true);
    expect(existsSync(nested)).toBe(true);
  });

  it("falls back to slug=report when taskId has no usable characters", () => {
    const r: UnderstandingReport = { ...baseReport, taskId: "!!!" };
    const result = saveReport(r, { dir: tmpDir });
    expect(result.path.endsWith("-report.json")).toBe(true);
  });

  it("does not leave a .tmp- file behind on a successful write", () => {
    saveReport(baseReport, { dir: tmpDir });
    const debris = readdirSync(tmpDir).filter((n) => n.includes(".tmp-"));
    expect(debris).toEqual([]);
  });
});

describe("listReports", () => {
  it("returns an empty array when the dir does not exist", () => {
    expect(listReports({ dir: join(tmpDir, "missing") })).toEqual([]);
  });

  it("sorts entries by createdAt descending", () => {
    saveReport({ ...baseReport, createdAt: "2026-04-29T00:00:00Z" }, {
      dir: tmpDir,
      now: new Date("2026-04-29T00:00:00Z"),
    });
    saveReport(
      { ...baseReport, taskId: "ug-persist-2", createdAt: "2026-04-30T00:00:00Z" },
      { dir: tmpDir, now: new Date("2026-04-30T00:00:00Z") },
    );
    const entries = listReports({ dir: tmpDir });
    expect(entries.map((e) => e.taskId)).toEqual([
      "ug-persist-2",
      "ug-persist-1",
    ]);
  });

  it("ignores non-JSON and unparsable files", () => {
    writeFileSync(join(tmpDir, "stray.txt"), "not json", "utf8");
    writeFileSync(join(tmpDir, "broken.json"), "{not json", "utf8");
    saveReport(baseReport, { dir: tmpDir });
    const entries = listReports({ dir: tmpDir });
    expect(entries).toHaveLength(1);
    expect(entries[0].taskId).toBe("ug-persist-1");
  });

  it("returns entry shape with all expected fields", () => {
    saveReport(baseReport, { dir: tmpDir });
    const [entry] = listReports({ dir: tmpDir });
    expect(entry).toMatchObject({
      taskId: "ug-persist-1",
      mode: "fast_confirm",
      riskLevel: "medium",
      approvalStatus: "pending",
      createdAt: "2026-04-30T10:00:00.000Z",
    });
    expect(entry.path.startsWith(tmpDir)).toBe(true);
  });
});

describe("loadReport", () => {
  it("loads by taskId, returning the most recent on duplicates", () => {
    saveReport(baseReport, {
      dir: tmpDir,
      now: new Date("2026-04-29T00:00:00Z"),
    });
    const updated: UnderstandingReport = {
      ...baseReport,
      currentUnderstanding: "newer",
    };
    saveReport(updated, {
      dir: tmpDir,
      now: new Date("2026-04-30T00:00:00Z"),
    });
    const result = loadReport("ug-persist-1", { dir: tmpDir });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.currentUnderstanding).toBe("newer");
  });

  it("loads by absolute path", () => {
    const saved = saveReport(baseReport, { dir: tmpDir });
    const result = loadReport(saved.path);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.taskId).toBe("ug-persist-1");
  });

  it("loads by basename", () => {
    const saved = saveReport(baseReport, { dir: tmpDir });
    const filename = basename(saved.path);
    const result = loadReport(filename, { dir: tmpDir });
    expect(result.ok).toBe(true);
  });

  it("returns not_found for an absolute path that does not exist (no fall-through to dir lookup)", () => {
    saveReport(baseReport, { dir: tmpDir });
    const result = loadReport("/definitely/not/a/real/path.json", {
      dir: tmpDir,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("not_found");
  });

  it("returns ok:false with reason=not_found for a bogus id", () => {
    saveReport(baseReport, { dir: tmpDir });
    const result = loadReport("does-not-exist", { dir: tmpDir });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("not_found");
  });

  it("returns ok:false with reason=parse_error for a corrupted file", () => {
    const path = join(tmpDir, "2026-04-30-corrupt.json");
    writeFileSync(path, "{not json", "utf8");
    const result = loadReport(path);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe("parse_error");
  });
});

describe("saveReport: schema/canonical-order coverage", () => {
  // Now-redundant safety belt: KEY_ORDER in persistence.ts is derived
  // directly from UNDERSTANDING_REPORT_SCHEMA.properties at module load,
  // so a schema-only addition cannot drop a field. Test stays as a
  // belt-and-braces regression catch in case someone reverts that.
  it("round-trips every property declared in UNDERSTANDING_REPORT_SCHEMA", () => {
    const schemaProps = Object.keys(
      UNDERSTANDING_REPORT_SCHEMA.properties,
    ) as (keyof UnderstandingReport)[];
    const fullReport: UnderstandingReport = {
      ...baseReport,
      approvedAt: "2026-04-30T10:30:00.000Z",
      approvedBy: "lan@example.com",
    };
    const saved = saveReport(fullReport, { dir: tmpDir });
    const persisted = JSON.parse(
      readFileSync(saved.path, "utf8"),
    ) as Record<string, unknown>;
    for (const key of schemaProps) {
      const value = (fullReport as unknown as Record<string, unknown>)[key];
      if (value === undefined) continue;
      expect(persisted, `schema property "${key}" missing from canonicalJSON`)
        .toHaveProperty(key);
    }
  });

  it("on-disk key order matches schema property order", () => {
    const fullReport: UnderstandingReport = {
      ...baseReport,
      approvedAt: "2026-04-30T10:30:00.000Z",
      approvedBy: "lan@example.com",
    };
    const saved = saveReport(fullReport, { dir: tmpDir });
    const onDiskKeys = Object.keys(
      JSON.parse(readFileSync(saved.path, "utf8")),
    );
    const schemaKeys = Object.keys(
      UNDERSTANDING_REPORT_SCHEMA.properties,
    ).filter(
      (k) =>
        (fullReport as unknown as Record<string, unknown>)[k] !== undefined,
    );
    expect(onDiskKeys).toEqual(schemaKeys);
  });
});

describe("saveReport: atomicity", () => {
  it("writes via a temp file that is renamed into place", () => {
    // We can't easily fault-inject rename failures across platforms, so
    // we assert the durable invariants the design promises:
    //   1. After success there are no .tmp- files in the dir.
    //   2. The final file's contents match exactly what was intended
    //      (no half-written artifacts).
    const result = saveReport(baseReport, { dir: tmpDir });
    expect(result.written).toBe(true);
    const names = readdirSync(tmpDir);
    expect(names.filter((n) => n.includes(".tmp-"))).toEqual([]);
    const onDisk = readFileSync(result.path, "utf8");
    expect(onDisk.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(onDisk);
    expect(parsed.taskId).toBe(baseReport.taskId);
  });
});

// keep imports referenced for environments with aggressive tree-shaking on
// test files (vitest uses esbuild; this pin is harmless either way).
void utimesSync;
