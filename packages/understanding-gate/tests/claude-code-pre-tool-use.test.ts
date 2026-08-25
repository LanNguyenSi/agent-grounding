import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handlePreToolUse } from "../src/adapters/claude-code/handle-pre-tool-use.js";
import { handleUserPromptSubmit } from "../src/adapters/claude-code/handle.js";
import type { ReportEntry } from "../src/core/persistence.js";
import type { AuditEvent } from "../src/core/audit.js";

function makeDeps(entries: ReportEntry[] = []) {
  const audits: Array<{ cwd: string; event: AuditEvent }> = [];
  return {
    audits,
    deps: {
      listReports: vi.fn(() => entries),
      now: () => new Date("2026-05-02T12:00:00.000Z"),
      appendAudit: vi.fn((cwd: string, event: AuditEvent) => {
        audits.push({ cwd, event });
      }),
    },
  };
}

function entry(overrides: Partial<ReportEntry> = {}): ReportEntry {
  return {
    path: "/tmp/r.json",
    taskId: "session-x",
    mode: "fast_confirm",
    riskLevel: "medium",
    approvalStatus: "pending",
    createdAt: "2026-05-01T10:00:00.000Z",
    ...overrides,
  };
}

const PAYLOAD = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: "session-x",
    cwd: "/tmp/proj",
    tool_name: "Edit",
    hook_event_name: "PreToolUse",
    ...over,
  });

describe("handlePreToolUse: payload parsing", () => {
  // Every degraded path still ALLOWS (never crashes / blocks legitimate
  // work) but must do so LOUDLY — a stderr diagnostic AND a `degraded_allow`
  // audit entry — so the degradation is observable, not a silent
  // false-confidence allow.
  it("degrades to allow when stdin is empty", () => {
    const { deps, audits } = makeDeps();
    const r = handlePreToolUse("", {}, deps);
    expect(r.exitCode).toBe(0);
    expect(r.decision.decision).toBe("allow");
    expect(r.degraded).toBe(true);
    expect(r.stderr).not.toBe("");
    expect(audits).toHaveLength(1);
    expect(audits[0].event.kind).toBe("degraded_allow");
  });

  it("degrades to allow on non-JSON stdin", () => {
    const { deps, audits } = makeDeps();
    const r = handlePreToolUse("not json", {}, deps);
    expect(r.exitCode).toBe(0);
    expect(r.degraded).toBe(true);
    expect(r.stderr).not.toBe("");
    expect(audits).toHaveLength(1);
    expect(audits[0].event.kind).toBe("degraded_allow");
  });

  it("degrades to allow on JSON array (not an object)", () => {
    const { deps, audits } = makeDeps();
    const r = handlePreToolUse("[1,2,3]", {}, deps);
    expect(r.exitCode).toBe(0);
    expect(r.degraded).toBe(true);
    expect(r.stderr).not.toBe("");
    expect(audits).toHaveLength(1);
    expect(audits[0].event.kind).toBe("degraded_allow");
  });

  it("degrades to allow when tool_name is missing", () => {
    const { deps, audits } = makeDeps();
    const r = handlePreToolUse(JSON.stringify({ session_id: "x" }), {}, deps);
    expect(r.exitCode).toBe(0);
    expect(r.degraded).toBe(true);
    expect(r.stderr).not.toBe("");
    expect(audits).toHaveLength(1);
    expect(audits[0].event.kind).toBe("degraded_allow");
  });

  it("on a malformed payload it allows but LOUDLY (stderr + audit), not silent-allow", () => {
    // Mirrors the harness-side pack-hook test ("allows with a LOUD
    // diagnostic ... not silent-allow"): a governance gate that fails open
    // must never do so silently — that manufactures false confidence.
    const { deps, audits } = makeDeps();
    const r = handlePreToolUse("definitely-not-json", {}, deps);
    expect(r.exitCode).toBe(0);
    expect(r.decision.decision).toBe("allow");
    expect(r.degraded).toBe(true);
    expect(r.stderr.toLowerCase()).toContain("degraded");
    expect(audits).toHaveLength(1);
    const ev = audits[0].event;
    expect(ev.kind).toBe("degraded_allow");
    if (ev.kind === "degraded_allow") {
      expect(ev.tool).toBeNull();
      expect(ev.reason).toMatch(/malformed/i);
      expect(ev.adapter).toBe("claude-code");
    }
  });
});

describe("handlePreToolUse: enforcement decisions", () => {
  it("allows Read silently with no report", () => {
    const { deps } = makeDeps();
    const r = handlePreToolUse(PAYLOAD({ tool_name: "Read" }), {}, deps);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.decision.mode).toBe("readonly_tool");
  });

  it("blocks Edit with exit 2 + JSON envelope when no report", () => {
    const { deps, audits } = makeDeps();
    const r = handlePreToolUse(PAYLOAD(), {}, deps);
    expect(r.exitCode).toBe(2);
    const env = JSON.parse(r.stdout) as {
      hookSpecificOutput: {
        hookEventName: string;
        permissionDecision: string;
        permissionDecisionReason: string;
      };
    };
    expect(env.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(env.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(env.hookSpecificOutput.permissionDecisionReason).toContain("Edit");
    expect(r.stderr).toContain("Edit");
    expect(audits).toHaveLength(1);
    expect(audits[0].event.kind).toBe("block");
    expect(audits[0].cwd).toBe("/tmp/proj");
  });

  it("blocks when latest report is pending", () => {
    const { deps, audits } = makeDeps([
      entry({ approvalStatus: "pending" }),
    ]);
    const r = handlePreToolUse(PAYLOAD(), {}, deps);
    expect(r.exitCode).toBe(2);
    expect(r.decision.mode).toBe("not_approved");
    expect(audits).toHaveLength(1);
  });

  it("allows silently when latest report is approved", () => {
    const { deps, audits } = makeDeps([
      entry({
        approvalStatus: "approved",
        approvedAt: "2026-05-02T08:00:00.000Z",
      }),
    ]);
    const r = handlePreToolUse(PAYLOAD(), {}, deps);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.decision.mode).toBe("approved");
    expect(audits).toHaveLength(0);
  });

  it("respects UNDERSTANDING_GATE_TASK_ID over session_id when looking up reports", () => {
    const { deps, audits } = makeDeps([
      entry({ taskId: "explicit-task", approvalStatus: "approved", approvedAt: "z" }),
      entry({ taskId: "session-x", approvalStatus: "pending" }),
    ]);
    const r = handlePreToolUse(
      PAYLOAD(),
      { UNDERSTANDING_GATE_TASK_ID: "explicit-task" },
      deps,
    );
    expect(r.decision.mode).toBe("approved");
    expect(r.exitCode).toBe(0);
    expect(audits).toHaveLength(0);
  });

  it("audits a force_bypass and allows", () => {
    const { deps, audits } = makeDeps();
    const r = handlePreToolUse(
      PAYLOAD({ tool_name: "Bash" }),
      {
        UNDERSTANDING_GATE_FORCE: "1",
        UNDERSTANDING_GATE_FORCE_REASON: "incident-recovery now",
      },
      deps,
    );
    expect(r.decision.mode).toBe("force_bypass");
    expect(r.exitCode).toBe(0);
    expect(audits).toHaveLength(1);
    expect(audits[0].event.kind).toBe("force_bypass");
  });

  it("blocks force_invalid (FORCE without reason)", () => {
    const { deps, audits } = makeDeps();
    const r = handlePreToolUse(
      PAYLOAD({ tool_name: "Bash" }),
      { UNDERSTANDING_GATE_FORCE: "1" },
      deps,
    );
    expect(r.decision.mode).toBe("force_invalid");
    expect(r.exitCode).toBe(2);
    expect(audits).toHaveLength(1);
    expect(audits[0].event.kind).toBe("block");
  });

  it("respects UNDERSTANDING_GATE_DISABLE", () => {
    const { deps, audits } = makeDeps();
    const r = handlePreToolUse(
      PAYLOAD({ tool_name: "Edit" }),
      { UNDERSTANDING_GATE_DISABLE: "1" },
      deps,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(audits).toHaveLength(0);
  });

  it("never throws when listReports throws", () => {
    const { audits } = makeDeps();
    const deps = {
      listReports: vi.fn(() => {
        throw new Error("disk on fire");
      }),
      now: () => new Date(),
      appendAudit: vi.fn((cwd: string, event: AuditEvent) => {
        audits.push({ cwd, event });
      }),
    };
    expect(() => handlePreToolUse(PAYLOAD(), {}, deps)).not.toThrow();
    const r = handlePreToolUse(PAYLOAD(), {}, deps);
    expect(r.exitCode).toBe(2); // no entries → block
  });

  it("never throws when appendAudit throws", () => {
    const deps = {
      listReports: vi.fn((): ReportEntry[] => []),
      now: () => new Date(),
      appendAudit: vi.fn(() => {
        throw new Error("audit broken");
      }),
    };
    expect(() => handlePreToolUse(PAYLOAD(), {}, deps)).not.toThrow();
    const r = handlePreToolUse(PAYLOAD(), {}, deps);
    expect(r.exitCode).toBe(2); // decision unchanged by audit failure
  });
});

describe("handlePreToolUse: pause sentinel (shared with UserPromptSubmit, no second parser)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function sentinelFile(content: unknown): string {
    dir = mkdtempSync(join(tmpdir(), "understanding-gate-pretooluse-pause-"));
    const file = join(dir, "sentinel.json");
    writeFileSync(
      file,
      typeof content === "string" ? content : JSON.stringify(content),
    );
    return file;
  }

  // AC1: an active, unexpired sentinel yields no deny and exit 0. Would
  // otherwise deny (no report exists for the default PAYLOAD()'s Edit
  // tool_name) -- pause must override that. A paused override of a
  // would-be block must still leave exactly one audit trace (a governance
  // override is never as silent as an ordinary allow).
  it("AC1: an active (future expiresAt) sentinel suppresses the deny, exit 0, and leaves ONE paused_allow audit entry", () => {
    const { deps, audits } = makeDeps();
    const file = sentinelFile({
      pausedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      reason: "test",
      pausedBy: "test",
    });
    const r = handlePreToolUse(
      PAYLOAD(),
      { UNDERSTANDING_GATE_PAUSE_FILE: file },
      deps,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.decision.decision).toBe("allow");
    expect(r.stderr).not.toBe("");
    expect(audits).toHaveLength(1);
    expect(audits[0].event.kind).toBe("paused_allow");
    if (audits[0].event.kind === "paused_allow") {
      expect(audits[0].event.tool).toBe("Edit");
    }
  });

  // Companion to AC1: when the underlying decision would already have
  // been an allow (a read-only tool, nothing to override), the pause
  // changes nothing observable -- stay on the zero-overhead, zero-audit
  // silent path instead of manufacturing a trace for a no-op override.
  it("a read-only tool under an active pause writes no audit entry and stays silent", () => {
    const { deps, audits } = makeDeps();
    const file = sentinelFile({
      pausedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      reason: "test",
      pausedBy: "test",
    });
    const r = handlePreToolUse(
      PAYLOAD({ tool_name: "Read" }),
      { UNDERSTANDING_GATE_PAUSE_FILE: file },
      deps,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(r.decision.decision).toBe("allow");
    expect(audits).toHaveLength(0);
  });

  // A force-bypass decision under an active pause must keep its own
  // force_bypass audit trace, not be folded into paused_allow: the pause
  // did not change anything observable about a force-bypass, so it must
  // not swallow the override-of-legitimate-authority signal that
  // force_bypass exists to record.
  it("an active pause + valid UNDERSTANDING_GATE_FORCE does not change the audit kind: exactly one force_bypass entry, no paused_allow", () => {
    const { deps, audits } = makeDeps();
    const file = sentinelFile({
      pausedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      reason: "test",
      pausedBy: "test",
    });
    const r = handlePreToolUse(
      PAYLOAD(),
      {
        UNDERSTANDING_GATE_PAUSE_FILE: file,
        UNDERSTANDING_GATE_FORCE: "1",
        UNDERSTANDING_GATE_FORCE_REASON: "incident recovery now",
      },
      deps,
    );
    expect(r.exitCode).toBe(0);
    expect(r.decision.decision).toBe("allow");
    expect(audits).toHaveLength(1);
    expect(audits[0].event.kind).toBe("force_bypass");
    expect(audits.some((a) => a.event.kind === "paused_allow")).toBe(false);
  });

  // AC2 negative controls: fail-open direction is "NOT paused" -- each of
  // these must still deny (exitCode 2), same as with no pause file at all.
  it("AC2: an EXPIRED sentinel does not suppress the deny", () => {
    const { deps } = makeDeps();
    const file = sentinelFile({
      pausedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      reason: "test",
      pausedBy: "test",
    });
    const r = handlePreToolUse(
      PAYLOAD(),
      { UNDERSTANDING_GATE_PAUSE_FILE: file },
      deps,
    );
    expect(r.exitCode).toBe(2);
  });

  it("AC2: a missing sentinel file does not suppress the deny", () => {
    const { deps } = makeDeps();
    const r = handlePreToolUse(
      PAYLOAD(),
      { UNDERSTANDING_GATE_PAUSE_FILE: "/nonexistent/path/does-not-exist.json" },
      deps,
    );
    expect(r.exitCode).toBe(2);
  });

  it("AC2: an empty sentinel file does not suppress the deny", () => {
    const { deps } = makeDeps();
    const file = sentinelFile("");
    const r = handlePreToolUse(
      PAYLOAD(),
      { UNDERSTANDING_GATE_PAUSE_FILE: file },
      deps,
    );
    expect(r.exitCode).toBe(2);
  });

  it("AC2: unparsable JSON in the sentinel file does not suppress the deny", () => {
    const { deps } = makeDeps();
    const file = sentinelFile("not json at all {");
    const r = handlePreToolUse(
      PAYLOAD(),
      { UNDERSTANDING_GATE_PAUSE_FILE: file },
      deps,
    );
    expect(r.exitCode).toBe(2);
  });

  it("AC2: a directory at the sentinel path does not suppress the deny", () => {
    dir = mkdtempSync(join(tmpdir(), "understanding-gate-pretooluse-pause-"));
    const { deps } = makeDeps();
    const r = handlePreToolUse(
      PAYLOAD(),
      { UNDERSTANDING_GATE_PAUSE_FILE: dir },
      deps,
    );
    expect(r.exitCode).toBe(2);
  });

  // AC4: same function, no second parser -- both Claude hooks must agree
  // on the same sentinel file. Pins parity directly rather than trusting
  // that the import alone proves it. Load-bearing: covers every shape
  // isPaused branches on (see pause.ts's isPaused doc comment), not just
  // the two happy-path shapes, so a divergence introduced on only one of
  // the indefinite-pause branches (missing/null/unparsable expiresAt,
  // non-string expiresAt, missing/empty pausedAt) actually turns this red.
  it("AC4: PreToolUse and UserPromptSubmit agree on every sentinel shape isPaused branches on (shared isPaused, no second parser)", () => {
    const tmpDirs: string[] = [];
    function tmpFile(): { dir: string; file: string } {
      const d = mkdtempSync(join(tmpdir(), "understanding-gate-parity-"));
      tmpDirs.push(d);
      return { dir: d, file: join(d, "sentinel.json") };
    }
    function objectFile(content: unknown): string {
      const { file } = tmpFile();
      writeFileSync(file, JSON.stringify(content));
      return file;
    }
    function rawFile(raw: string): string {
      const { file } = tmpFile();
      writeFileSync(file, raw);
      return file;
    }
    function directoryPath(): string {
      const { dir } = tmpFile();
      return dir;
    }
    function missingPath(): string {
      const { dir } = tmpFile();
      return join(dir, "does-not-exist.json");
    }

    const activePausedAt = new Date().toISOString();
    const futureExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const pastPausedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const pastExpiresAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const cases: Array<{ label: string; file: () => string }> = [
      {
        label: "active",
        file: () => objectFile({ pausedAt: activePausedAt, expiresAt: futureExpiresAt }),
      },
      {
        label: "expired",
        file: () => objectFile({ pausedAt: pastPausedAt, expiresAt: pastExpiresAt }),
      },
      {
        label: "expiresAt missing",
        file: () => objectFile({ pausedAt: activePausedAt }),
      },
      {
        label: "expiresAt null",
        file: () => objectFile({ pausedAt: activePausedAt, expiresAt: null }),
      },
      {
        label: "expiresAt non-parsable non-empty string",
        file: () => objectFile({ pausedAt: activePausedAt, expiresAt: "not-a-date" }),
      },
      {
        label: "expiresAt a number",
        file: () => objectFile({ pausedAt: activePausedAt, expiresAt: 12345 }),
      },
      {
        label: "expiresAt a boolean",
        file: () => objectFile({ pausedAt: activePausedAt, expiresAt: true }),
      },
      {
        label: "pausedAt missing",
        file: () => objectFile({ expiresAt: futureExpiresAt }),
      },
      {
        label: "pausedAt empty string",
        file: () => objectFile({ pausedAt: "", expiresAt: futureExpiresAt }),
      },
      {
        label: "directory at the sentinel path",
        file: directoryPath,
      },
      {
        label: "missing file",
        file: missingPath,
      },
      {
        label: "empty file",
        file: () => rawFile(""),
      },
      {
        label: "unparsable JSON",
        file: () => rawFile("not json at all {"),
      },
    ];

    try {
      for (const { label, file: makeFile } of cases) {
        const file = makeFile();
        const { deps } = makeDeps();
        const preToolUseResult = handlePreToolUse(
          PAYLOAD(),
          { UNDERSTANDING_GATE_PAUSE_FILE: file },
          deps,
        );
        const promptOut = handleUserPromptSubmit(
          JSON.stringify({ prompt: "add a logout button to src/Header.tsx" }),
          { UNDERSTANDING_GATE_PAUSE_FILE: file },
        );

        const preToolUsePaused = preToolUseResult.decision.mode === "paused";
        const promptPaused = promptOut === "";
        expect(preToolUsePaused, `case "${label}"`).toBe(promptPaused);
        // Secondary signal: a paused decision always maps to exit 0, so
        // this stays in lockstep with the primary decision.mode check.
        expect(preToolUseResult.exitCode === 0, `case "${label}"`).toBe(
          preToolUsePaused,
        );
      }
    } finally {
      for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
    }
  });
});
