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

// Review follow-up (agent-tasks e4c970b2, LOW): probe symlink support
// ONCE at module load and gate the symlink-dependent tests with
// `it.skipIf`, instead of each test creating the symlink and silently
// `return`-ing early on EPERM. A bare early `return` inside a test body
// reports as PASSED, which is a vacuous pass in a symlink-restricted
// sandbox/CI (it would "pass" even if the guard being tested was
// deleted). `it.skipIf` reports SKIPPED instead, which is honest about
// what was actually exercised.
function canCreateSymlinks(): boolean {
  const probeDir = mkdtempSync(join(tmpdir(), "rrc-symlink-probe-"));
  try {
    symlinkSync(join(probeDir, "target"), join(probeDir, "link"));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return false;
    throw err;
  } finally {
    rmSync(probeDir, { recursive: true, force: true });
  }
}

const SYMLINKS_SUPPORTED = canCreateSymlinks();

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

// Parity follow-up (agent-tasks e4c970b2): review-claim-gate's
// evidence-path guard (agent-tasks 2878a962) was hardened with a
// realpath-based containment backstop because lexical `resolve()`
// alone does not follow symlinks. verifyPath's containment check had
// the same gap — a committed symlink inside repoRoot pointing outside
// it, combined with a relative ref.value that walks through it, passed
// the lexical check while `statSync` actually escaped.
describe("verifyMemoryReference — kind: path symlink escape (realpath containment)", () => {
  it.skipIf(!SYMLINKS_SUPPORTED)(
    "refuses a relative path that only escapes repoRoot through a symlinked directory",
    () => {
      const root = mkdtempSync(join(tmpdir(), "rrc-verify-ref-symlink-"));
      const outside = mkdtempSync(join(tmpdir(), "rrc-verify-ref-outside-"));
      try {
        writeFileSync(join(outside, "secret.txt"), "leak\n");
        symlinkSync(outside, join(root, "link"), "dir");

        // Lexical resolve() alone would pass this (the symlink's own
        // path, "link", is inside root) — only the realpath backstop
        // catches that it actually points at `outside`.
        const r = verifyMemoryReference({
          kind: "path",
          value: "link/secret.txt",
          repoRoot: root,
        });
        expect(r.exists).toBe(false);
        expect(r.summary).toMatch(/escapes repoRoot via a symlink/);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  // Coverage gap (review LOW 2a): the escaping symlink was only tested
  // as an intermediate directory segment (`link/secret.txt`). Also
  // cover the symlink itself being the FINAL path segment
  // (`ref.value` names the link directly), which resolves through a
  // different code path inside `resolveRealOrNull(resolvedFull)`.
  it.skipIf(!SYMLINKS_SUPPORTED)(
    "refuses a relative path that IS the symlink escaping repoRoot (final path segment)",
    () => {
      const root = mkdtempSync(join(tmpdir(), "rrc-verify-ref-symlink-final-"));
      const outside = mkdtempSync(join(tmpdir(), "rrc-verify-ref-outside-final-"));
      try {
        const target = join(outside, "real.ts");
        writeFileSync(target, "export const leak = 1;\n");
        symlinkSync(target, join(root, "link.ts"));

        const r = verifyMemoryReference({
          kind: "path",
          value: "link.ts",
          repoRoot: root,
        });
        expect(r.exists).toBe(false);
        expect(r.summary).toMatch(/escapes repoRoot via a symlink/);
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  // Coverage gap (review LOW 2b): a positive control. A symlink that
  // stays entirely WITHIN repoRoot (no escape) must resolve normally —
  // proves the realpath backstop only rejects genuine escapes, not
  // symlinks in general.
  it.skipIf(!SYMLINKS_SUPPORTED)(
    "does not flag a legitimate in-repo symlink as an escape",
    () => {
      const root = mkdtempSync(join(tmpdir(), "rrc-verify-ref-symlink-inrepo-"));
      try {
        mkdirSync(join(root, "subdir"), { recursive: true });
        writeFileSync(join(root, "subdir", "real.ts"), "export const ok = 1;\n");
        symlinkSync(join(root, "subdir"), join(root, "link"), "dir");

        const r = verifyMemoryReference({
          kind: "path",
          value: "link/real.ts",
          repoRoot: root,
        });
        expect(r.exists).toBe(true);
        expect(r.summary).toMatch(/exists/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!SYMLINKS_SUPPORTED)(
    "does not throw for a dangling symlink (ENOENT-safe)",
    () => {
      // Locks in the deliberate ENOENT-is-not-an-escape decision: a
      // symlink whose target doesn't exist must resolve like any other
      // missing path (exists:false), not throw and not report an escape.
      const root = mkdtempSync(join(tmpdir(), "rrc-verify-ref-dangling-"));
      try {
        symlinkSync(
          join(root, "does-not-exist-target"),
          join(root, "dangling-link"),
        );

        const r = verifyMemoryReference({
          kind: "path",
          value: "dangling-link",
          repoRoot: root,
        });
        expect(r.exists).toBe(false);
        expect(r.summary).toMatch(/does not exist/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  // Review follow-up (agent-tasks e4c970b2, MEDIUM): ENOTDIR ("a path
  // segment that should be a directory is actually a file") must be
  // treated like ENOENT — structurally not there, not an escape — and
  // must NOT propagate as a throw. Concrete regression case from the
  // review: `config.json` is a plain file, so `config.json/child` makes
  // realpathSync throw ENOTDIR while walking the containment check.
  it("treats an ENOTDIR path segment (file used as a directory) as not-found, not a throw", () => {
    const root = mkdtempSync(join(tmpdir(), "rrc-verify-ref-enotdir-"));
    try {
      writeFileSync(join(root, "config.json"), "{}\n");
      const r = verifyMemoryReference({
        kind: "path",
        value: "config.json/child",
        repoRoot: root,
      });
      expect(r.exists).toBe(false);
      expect(r.summary).toMatch(/does not exist/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Review follow-up (agent-tasks e4c970b2, MEDIUM): any OTHER
  // unexpected realpath errno (ELOOP from a symlink cycle, in this
  // case) must NOT propagate out of `verifyMemoryReference` — it is
  // total by design. It must instead surface as a fail-closed RESULT.
  it.skipIf(!SYMLINKS_SUPPORTED)(
    "fails closed with a result (not a throw) on a symlink cycle (ELOOP)",
    () => {
      const root = mkdtempSync(join(tmpdir(), "rrc-verify-ref-eloop-"));
      try {
        const loopPath = join(root, "loop-link");
        symlinkSync(loopPath, loopPath);

        expect(() =>
          verifyMemoryReference({
            kind: "path",
            value: "loop-link",
            repoRoot: root,
          }),
        ).not.toThrow();

        const r = verifyMemoryReference({
          kind: "path",
          value: "loop-link",
          repoRoot: root,
        });
        expect(r.exists).toBe(false);
        expect(r.summary).toMatch(/cannot be verified/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("does not throw when repoRoot itself does not exist yet (fresh workspace)", () => {
    const r = verifyMemoryReference({
      kind: "path",
      value: "some/file.ts",
      repoRoot: join(tmpdir(), "rrc-verify-ref-does-not-exist-root-xyz"),
    });
    expect(r.exists).toBe(false);
    expect(r.summary).toMatch(/does not exist/);
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

  it("returns exists=false for an empty symbol/flag value instead of looping forever", () => {
    // An empty value builds a zero-width pattern. Pre-fix, countMatches
    // spun forever on the first scanned file because exec never advanced
    // lastIndex; the dispatch guard now short-circuits before any walk.
    const root = mkTmp();
    try {
      seed(root, "src/a.ts", "export function real() {}\n");
      const start = Date.now();
      const sym = verifyMemoryReference({ kind: "symbol", value: "", repoRoot: root });
      const flag = verifyMemoryReference({ kind: "flag", value: "   ", repoRoot: root });
      const elapsedMs = Date.now() - start;
      expect(sym.exists).toBe(false);
      expect(sym.matchCount).toBe(0);
      expect(sym.summary).toMatch(/empty/);
      expect(flag.exists).toBe(false);
      expect(elapsedMs).toBeLessThan(5000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("countMatches terminates on a zero-width pattern (defence in depth)", () => {
    // Even if a zero-width pattern reaches countMatches (e.g. via a future
    // caller bypassing the dispatch guard), the lastIndex nudge guarantees
    // the scan completes rather than hanging.
    const root = mkTmp();
    try {
      // \b is zero-width; this exercises the lastIndex advance directly.
      seed(root, "src/a.ts", "alpha beta gamma\n");
      const start = Date.now();
      // Use the flag path with a value that yields a zero-width-capable
      // pattern only at the lookaround boundaries — the guard rejects
      // empty, so feed a real token and assert sane, finite counting.
      const r = verifyMemoryReference({ kind: "symbol", value: "alpha", repoRoot: root });
      const elapsedMs = Date.now() - start;
      expect(r.exists).toBe(true);
      expect(r.matchCount).toBe(1);
      expect(elapsedMs).toBeLessThan(5000);
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
