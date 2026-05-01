import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { writeAtomicJSON, writeAtomicText } from "../src/core/fs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
import { syncHypothesesFromReport } from "../src/core/hypothesis-sync.js";
import type { UnderstandingReport } from "../src/schema/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ug-fs-atomic-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("writeAtomicText", () => {
  it("creates the parent directory by default", () => {
    const path = join(tmpDir, "nested", "deep", "out.txt");
    writeAtomicText(path, "hello");
    expect(readFileSync(path, "utf8")).toBe("hello");
  });

  it("does not leave any tmp files behind on success", () => {
    const path = join(tmpDir, "out.txt");
    writeAtomicText(path, "x");
    const leftover = readdirSync(tmpDir).filter((n) => n.includes(".tmp-"));
    expect(leftover).toEqual([]);
  });

  it("overwrites an existing file", () => {
    const path = join(tmpDir, "out.txt");
    writeAtomicText(path, "first");
    writeAtomicText(path, "second");
    expect(readFileSync(path, "utf8")).toBe("second");
  });

  // Drives the cleanup branch of writeAtomicText: when renameSync throws
  // (here EISDIR — the final path is an existing directory), the helper
  // must unlink the staged tmp file and rethrow. Verifies the failure
  // path that the success-path tests can't reach.
  it("rethrows and removes the tmp file when renameSync fails", () => {
    const finalPath = join(tmpDir, "blocking-dir");
    mkdirSync(finalPath, { recursive: true });

    expect(() => writeAtomicText(finalPath, "payload")).toThrow();

    const leftover = readdirSync(tmpDir).filter((n) => n.includes(".tmp-"));
    expect(leftover).toEqual([]);
    // The blocking directory survives untouched.
    expect(existsSync(finalPath)).toBe(true);
  });

  // Same cleanup branch via the saveReport integration path. Catches
  // regressions where saveReport begins to swallow the rethrow or
  // accidentally leaves a partial <iso>-<slug>.json behind.
  it("saveReport rethrows on rename failure with no leftover files", async () => {
    const reportDir = join(tmpDir, "reports");
    mkdirSync(reportDir, { recursive: true });
    const slug = "renamefail";

    // Pre-create a directory exactly where saveReport will try to write
    // its file. We can't predict the iso stamp, so override now to a
    // fixed value and stage a directory at that exact final path.
    const fixedNow = new Date("2026-04-30T11:22:33.444Z");
    const isoStamp = fixedNow.toISOString().replace(/[:.]/g, "-");
    const finalPath = join(reportDir, `${isoStamp}-${slug}.json`);
    mkdirSync(finalPath, { recursive: true });

    const { saveReport } = await import("../src/core/persistence.js");
    expect(() =>
      saveReport(
        {
          taskId: slug,
          mode: "fast_confirm",
          riskLevel: "low",
          currentUnderstanding: "u",
          intendedOutcome: "o",
          derivedTodos: ["a"],
          acceptanceCriteria: ["b"],
          assumptions: ["c"],
          openQuestions: ["d"],
          outOfScope: [],
          risks: [],
          verificationPlan: ["p"],
          requiresHumanApproval: false,
          approvalStatus: "approved",
          createdAt: "2026-04-30T11:22:33.444Z",
        },
        { dir: reportDir, now: fixedNow },
      ),
    ).toThrow();

    const leftover = readdirSync(reportDir).filter((n) => n.includes(".tmp-"));
    expect(leftover).toEqual([]);
  });
});

describe("writeAtomicJSON", () => {
  it("writes pretty-printed JSON with a trailing newline", () => {
    const path = join(tmpDir, "out.json");
    writeAtomicJSON(path, { a: 1, b: [2, 3] });
    const raw = readFileSync(path, "utf8");
    expect(raw).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}\n');
  });
});

describe("concurrent writers do not produce torn files", () => {
  // In-process: drives N syncHypothesesFromReport calls back-to-back
  // against the same store path. The JS event loop serializes the sync
  // fs calls, so this exercises the rename-overwrite path rather than a
  // true race, but it still verifies the helper survives repeated
  // overwrites and leaves no debris.
  it("syncHypothesesFromReport x16 leaves the store as valid JSON", async () => {
    const reportDir = join(tmpDir, "reports");
    const N = 16;

    const reports: UnderstandingReport[] = Array.from({ length: N }, (_, i) =>
      makeReport(`ug-concurrent-${i}`),
    );

    const results = await Promise.all(
      reports.map((r) =>
        Promise.resolve().then(() =>
          syncHypothesesFromReport(r, { reportDir, sessionId: "concurrent" }),
        ),
      ),
    );

    for (const outcome of results) {
      expect(outcome.kind).toBe("ok");
    }

    const storePath = join(tmpDir, "hypotheses.json");
    expect(existsSync(storePath)).toBe(true);
    const raw = readFileSync(storePath, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    const parsed = JSON.parse(raw) as {
      session: string;
      hypotheses: unknown[];
    };
    expect(parsed.session).toBe("concurrent");
    expect(Array.isArray(parsed.hypotheses)).toBe(true);

    const leftover = readdirSync(tmpDir).filter((n) => n.includes(".tmp-"));
    expect(leftover).toEqual([]);
  });

  // Cross-process: spawns N child processes that all call writeAtomicJSON
  // on the same final path at the same time. This is the real torn-file
  // test — without atomic rename, partial writes would surface here.
  const PKG_ROOT = resolve(__dirname, "..");
  const FS_DIST = resolve(PKG_ROOT, "dist", "core", "fs.js");
  beforeAll(() => {
    if (!existsSync(FS_DIST)) {
      execFileSync("npm", ["run", "build"], { cwd: PKG_ROOT, stdio: "ignore" });
    }
  });

  it("N parallel processes writing the same path yield a valid JSON file", async () => {
    const finalPath = join(tmpDir, "shared.json");
    const fsModulePath = pathToFileURL(FS_DIST).href;
    const writerScript = resolve(__dirname, "fixtures", "concurrent-writer.mjs");
    const N = 12;

    const children = Array.from({ length: N }, (_, i) => {
      return new Promise<{ code: number | null; stderr: string }>((res) => {
        const cp = spawn(
          process.execPath,
          [writerScript, fsModulePath, finalPath, String(i)],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        let stderr = "";
        cp.stderr.on("data", (chunk) => {
          stderr += chunk.toString("utf8");
        });
        cp.on("close", (code) => res({ code, stderr }));
      });
    });

    const outcomes = await Promise.all(children);
    for (const o of outcomes) {
      expect(o.code, o.stderr).toBe(0);
    }

    expect(existsSync(finalPath)).toBe(true);
    const raw = readFileSync(finalPath, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    const parsed = JSON.parse(raw) as { payloadId: string; filler: string };
    expect(typeof parsed.payloadId).toBe("string");
    expect(parsed.filler).toBe("x".repeat(2048));

    const leftover = readdirSync(tmpDir).filter((n) => n.includes(".tmp-"));
    expect(leftover).toEqual([]);
  }, 15000);
});

function makeReport(taskId: string): UnderstandingReport {
  return {
    taskId,
    mode: "fast_confirm",
    riskLevel: "low",
    currentUnderstanding: `understanding for ${taskId}`,
    intendedOutcome: "round-trip",
    derivedTodos: ["todo"],
    acceptanceCriteria: ["ac"],
    assumptions: [`assumption for ${taskId}`],
    openQuestions: [`question for ${taskId}`],
    outOfScope: [],
    risks: [],
    verificationPlan: ["plan"],
    requiresHumanApproval: false,
    approvalStatus: "approved",
    createdAt: "2026-04-30T10:00:00.000Z",
  };
}
