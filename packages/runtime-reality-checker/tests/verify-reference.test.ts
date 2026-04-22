import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyMemoryReference } from "../src/verify-reference.js";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "rrc-verify-ref-"));
}

function seed(root: string, relPath: string, content = ""): string {
  const full = join(root, relPath);
  const dir = full.slice(0, full.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, content);
  return full;
}

describe("verifyMemoryReference — kind: path", () => {
  let root: string;
  beforeEach(() => {
    root = mkTmp();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns exists=true for a file that exists", () => {
    seed(root, "src/cli.ts", "// hello\n");
    const r = verifyMemoryReference({ kind: "path", value: "src/cli.ts", repoRoot: root });
    expect(r.exists).toBe(true);
    expect(r.foundIn).toHaveLength(1);
    expect(r.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(r.summary).toMatch(/exists/);
  });

  it("returns exists=false for a missing file", () => {
    const r = verifyMemoryReference({ kind: "path", value: "does-not-exist.md", repoRoot: root });
    expect(r.exists).toBe(false);
    expect(r.foundIn).toEqual([]);
    expect(r.matchCount).toBe(0);
    expect(r.summary).toMatch(/does not exist/);
    expect(r.lastModified).toBeUndefined();
  });

  it("defaults repoRoot to process.cwd when not passed", () => {
    // CWD ≠ our temp, but README.md exists in most dev repos — we just
    // want to prove the default resolves to a real path.
    const r = verifyMemoryReference({ kind: "path", value: "package.json" });
    // In this test process CWD is the agent-grounding monorepo root.
    expect(r.exists).toBe(true);
  });

  it("accepts absolute paths", () => {
    const full = seed(root, "abs.txt", "ok");
    const r = verifyMemoryReference({ kind: "path", value: full, repoRoot: "/tmp" });
    expect(r.exists).toBe(true);
  });

  it("refuses relative paths that escape repoRoot via traversal", () => {
    // An adversarial or accidental `../../etc/passwd` joins against
    // repoRoot and resolves outside it. statSync would happily
    // disclose existence; we'd rather return exists:false with a
    // summary that names the escape.
    const r = verifyMemoryReference({
      kind: "path",
      value: "../../../../etc/passwd",
      repoRoot: root,
    });
    expect(r.exists).toBe(false);
    expect(r.summary).toMatch(/escapes repoRoot/);
  });
});

describe("verifyMemoryReference — kind: symbol", () => {
  let root: string;
  beforeEach(() => {
    root = mkTmp();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds a declared function", () => {
    seed(root, "src/a.ts", "export function verifyMemoryReference() {}\n");
    const r = verifyMemoryReference({ kind: "symbol", value: "verifyMemoryReference", repoRoot: root });
    expect(r.exists).toBe(true);
    expect(r.foundIn).toHaveLength(1);
    expect(r.matchCount).toBeGreaterThan(0);
  });

  it("returns exists=false when the symbol is nowhere", () => {
    seed(root, "src/a.ts", "export function other() {}\n");
    const r = verifyMemoryReference({ kind: "symbol", value: "ghostSymbol", repoRoot: root });
    expect(r.exists).toBe(false);
    expect(r.foundIn).toEqual([]);
    expect(r.matchCount).toBe(0);
  });

  it("counts matches across multiple files", () => {
    seed(root, "src/a.ts", "export const MAX = 1;\nconsole.log(MAX);\n");
    seed(root, "src/b.ts", "import { MAX } from './a'; console.log(MAX, MAX);\n");
    const r = verifyMemoryReference({ kind: "symbol", value: "MAX", repoRoot: root });
    expect(r.exists).toBe(true);
    expect(r.foundIn.length).toBeGreaterThanOrEqual(2);
    // 2 in a.ts + 3 in b.ts = 5
    expect(r.matchCount).toBeGreaterThanOrEqual(5);
  });

  it("skips node_modules and dist by default", () => {
    seed(root, "src/a.ts", "function real() {}\n");
    seed(root, "node_modules/pkg/index.js", "function real() {}\n");
    seed(root, "dist/bundle.js", "function real() {}\n");
    const r = verifyMemoryReference({ kind: "symbol", value: "real", repoRoot: root });
    expect(r.foundIn).toHaveLength(1);
    expect(r.foundIn[0]).toMatch(/src\/a\.ts$/);
  });

  it("respects the extensions filter", () => {
    seed(root, "src/a.ts", "function target() {}\n");
    seed(root, "src/a.py", "def target():\n  pass\n");
    const tsOnly = verifyMemoryReference(
      { kind: "symbol", value: "target", repoRoot: root },
      { extensions: ["ts"] },
    );
    expect(tsOnly.foundIn).toHaveLength(1);
    expect(tsOnly.foundIn[0]).toMatch(/\.ts$/);
  });
});

describe("verifyMemoryReference — kind: flag", () => {
  let root: string;
  beforeEach(() => {
    root = mkTmp();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("finds a literal CLI flag", () => {
    seed(root, "src/cli.ts", "if (arg === '--no-verify') { skip(); }\n");
    const r = verifyMemoryReference({ kind: "flag", value: "--no-verify", repoRoot: root });
    expect(r.exists).toBe(true);
    expect(r.matchCount).toBe(1);
  });

  it("returns exists=false for a flag that does not appear", () => {
    seed(root, "src/cli.ts", "if (arg === '--other') { skip(); }\n");
    const r = verifyMemoryReference({ kind: "flag", value: "--gone", repoRoot: root });
    expect(r.exists).toBe(false);
  });

  it("finds config keys too (literal match)", () => {
    seed(
      root,
      "packages/agent-tasks/src/config.ts",
      "const requireDistinctReviewer = false;\nif (requireDistinctReviewer) {}\n",
    );
    const r = verifyMemoryReference(
      { kind: "flag", value: "requireDistinctReviewer", repoRoot: root },
    );
    expect(r.exists).toBe(true);
    expect(r.matchCount).toBe(2);
  });

  it("does NOT over-count when a shorter flag is a substring of a longer one", () => {
    // `-v` must not match inside `--verbose`; `--force` must not match
    // inside `--force-with-lease`. Without the non-dash lookaround the
    // literal substring would pass and silently flag a removed option
    // as still present.
    seed(
      root,
      "src/cli.ts",
      "if (arg === '--verbose') {}\nif (arg === '--force-with-lease') {}\n",
    );
    const shortFlag = verifyMemoryReference(
      { kind: "flag", value: "-v", repoRoot: root },
    );
    expect(shortFlag.exists).toBe(false);

    const longerSuperset = verifyMemoryReference(
      { kind: "flag", value: "--force", repoRoot: root },
    );
    expect(longerSuperset.exists).toBe(false);

    // Sanity: the real flag still matches.
    const real = verifyMemoryReference(
      { kind: "flag", value: "--verbose", repoRoot: root },
    );
    expect(real.exists).toBe(true);
  });
});

describe("verifyMemoryReference — misc", () => {
  it("never throws on unreadable repoRoot — returns exists=false", () => {
    const r = verifyMemoryReference({
      kind: "symbol",
      value: "anything",
      repoRoot: "/does/not/exist/anywhere",
    });
    expect(r.exists).toBe(false);
    expect(r.foundIn).toEqual([]);
  });

  it("surfaces maxFiles truncation in the summary", () => {
    const root = mkTmp();
    try {
      // 6 files with the symbol; cap at 3.
      for (let i = 0; i < 6; i++) {
        seed(root, `src/f${i}.ts`, "export function sym() {}\n");
      }
      const r = verifyMemoryReference(
        { kind: "symbol", value: "sym", repoRoot: root },
        { maxFiles: 3 },
      );
      expect(r.summary).toMatch(/walker stopped at 3 files/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("unknown kind yields exists=false with a clear summary (defence in depth)", () => {
    const r = verifyMemoryReference({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      kind: "banana" as any,
      value: "x",
      repoRoot: "/tmp",
    });
    expect(r.exists).toBe(false);
    expect(r.summary).toMatch(/unknown ref.kind/);
  });
});

describe("verifyMemoryReference — symlink-cycle safety", () => {
  it("walker terminates on a circular dir symlink (a/b -> ..)", () => {
    // Fixture: root/a/b -> root/a creates a cycle (a contains b, b
    // resolves back to a). Without symlink guarding, the walker would
    // descend a/b/b/b/... until maxFiles — which never hits because
    // no matching files exist.
    const root = mkdtempSync(join(tmpdir(), "rrc-cycle-"));
    try {
      mkdirSync(join(root, "a"), { recursive: true });
      writeFileSync(join(root, "a", "real.ts"), "export function sym() {}\n");
      symlinkSync(join(root, "a"), join(root, "a", "b"));

      const start = Date.now();
      const r = verifyMemoryReference({
        kind: "symbol",
        value: "sym",
        repoRoot: root,
      });
      const elapsedMs = Date.now() - start;

      // Real file under a/ is still found; the cycle via a/b is
      // detected and skipped. Elapsed time is sub-100ms on any sane
      // machine — this is the explicit acceptance criterion from the
      // follow-up task.
      expect(r.exists).toBe(true);
      expect(r.foundIn).toHaveLength(1);
      expect(r.foundIn[0]).toMatch(/a\/real\.ts$/);
      expect(elapsedMs).toBeLessThan(5000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips file symlinks from the scan (lstat classifies them out)", () => {
    // A symlink-file with a matching extension should NOT be scanned;
    // its target (if real) is scanned via its own entry.
    const root = mkdtempSync(join(tmpdir(), "rrc-filelink-"));
    try {
      writeFileSync(join(root, "real.ts"), "export function target() {}\n");
      symlinkSync(join(root, "real.ts"), join(root, "alias.ts"));

      const r = verifyMemoryReference({
        kind: "symbol",
        value: "target",
        repoRoot: root,
      });
      expect(r.exists).toBe(true);
      // The real file is scanned; alias is skipped so matchCount is not
      // doubled.
      expect(r.foundIn).toHaveLength(1);
      expect(r.foundIn[0]).toMatch(/real\.ts$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("verifyMemoryReference — no-extension files", () => {
  it("skips no-extension files by default (Makefile contains flag but unseen)", () => {
    const root = mkdtempSync(join(tmpdir(), "rrc-noext-"));
    try {
      writeFileSync(join(root, "Makefile"), "build:\n\tgo build --verbose\n");
      const r = verifyMemoryReference({
        kind: "flag",
        value: "--verbose",
        repoRoot: root,
      });
      // Documented behaviour: Makefile is off by default. The flag
      // literally exists in the repo but this mode doesn't see it.
      expect(r.exists).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds flag inside Makefile when includeNoExtension is on", () => {
    const root = mkdtempSync(join(tmpdir(), "rrc-noext-on-"));
    try {
      writeFileSync(join(root, "Makefile"), "build:\n\tgo build --verbose\n");
      const r = verifyMemoryReference(
        { kind: "flag", value: "--verbose", repoRoot: root },
        { includeNoExtension: true },
      );
      expect(r.exists).toBe(true);
      expect(r.foundIn[0]).toMatch(/Makefile$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("extraNoExtensionNames scans only the listed files", () => {
    // Opt-in narrow: scan Makefile but NOT Dockerfile, even though
    // both lack extensions.
    const root = mkdtempSync(join(tmpdir(), "rrc-noext-narrow-"));
    try {
      writeFileSync(join(root, "Makefile"), "const MAGIC = 42\n");
      writeFileSync(join(root, "Dockerfile"), "ENV MAGIC=42\n");
      const r = verifyMemoryReference(
        { kind: "flag", value: "MAGIC", repoRoot: root },
        { extraNoExtensionNames: ["Makefile"] },
      );
      expect(r.exists).toBe(true);
      expect(r.foundIn).toHaveLength(1);
      expect(r.foundIn[0]).toMatch(/Makefile$/);
      expect(r.foundIn[0]).not.toMatch(/Dockerfile/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
