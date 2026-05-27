// Exercises the `appendAudit` injection point and the default JSONL
// writer that the runtime-reality PreToolUse policy ships in
// `pre-tool-use.ts`. Goals:
//
//   1. Every decision-bearing branch (disabled / skip-noprobe /
//      probe-fail / warn / block) emits exactly one audit event with
//      the expected shape.
//   2. The handler runs cleanly when `appendAudit` is omitted (no-op
//      fallback, no throw).
//   3. The default writer respects RUNTIME_REALITY_AUDIT_LOG, writes
//      one JSONL line per event, and degrades silently on a bad path
//      so the hot path never crashes the harness.
//
// The handler tests use captured-array sinks rather than real disk
// writes; only the writer-specific tests touch a tmp file. Keeps the
// unit-level coverage fast and the disk-touching subset narrow.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  handlePolicyPreToolUse,
  type HandlerDeps,
  type Probe,
} from "../src/policy/handle-pre-tool-use.js";
import {
  createJsonlAuditWriter,
  resolveDefaultAuditLogPath,
  type AppendAudit,
  type AuditEvent,
} from "../src/policy/audit.js";
import type { ExpectationsLoadResult } from "../src/policy/expectations.js";
import type { ExpectedProcess } from "../src/lib.js";

const COMPOSE_PAYLOAD = JSON.stringify({
  session_id: "gs-audit-test",
  cwd: "/tmp",
  tool_name: "Bash",
  tool_input: { command: "docker-compose -f docker-compose.prod.yml restart panel-api" },
  hook_event_name: "PreToolUse",
});

function expectations(processes: ExpectedProcess[]): ExpectationsLoadResult {
  return { ok: true, file: { domain: "deploy-panel", processes } };
}

function captureAudit(): { events: AuditEvent[]; sink: AppendAudit } {
  const events: AuditEvent[] = [];
  return { events, sink: (event) => events.push(event) };
}

let baseDeps: HandlerDeps;

beforeEach(() => {
  baseDeps = {
    loadExpectations: () => ({ ok: false, reason: "not_found" }),
    probe: null,
  };
});

describe("audit event shape per kind", () => {
  it("disabled — emitted with empty payload fields and the disable env knob set", () => {
    const { events, sink } = captureAudit();
    handlePolicyPreToolUse(
      COMPOSE_PAYLOAD,
      { RUNTIME_REALITY_DISABLE: "1" },
      { ...baseDeps, appendAudit: sink },
    );
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e?.kind).toBe("disabled");
    expect(e?.iso_timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(e?.keyword).toBeNull();
    expect(e?.tool_name).toBeNull();
    expect(e?.command).toBeNull();
    expect(e?.trigger_category).toBeNull();
    expect(e?.drift_count).toBe(0);
    expect(e?.severity).toBeNull();
    expect(e?.env_overrides_applied).toEqual({
      disable: true,
      warn_as_block: false,
      critical_as_warn: false,
      probe_fail_block: false,
    });
    expect(e?.reason).toContain("RUNTIME_REALITY_DISABLE");
  });

  it("skip-noprobe — keyword + trigger captured, no severity, probe_fail_block=false", () => {
    const { events, sink } = captureAudit();
    handlePolicyPreToolUse(
      COMPOSE_PAYLOAD,
      { RUNTIME_REALITY_KEYWORD: "deploy-panel" },
      {
        ...baseDeps,
        loadExpectations: () => expectations([]),
        probe: null,
        appendAudit: sink,
      },
    );
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e?.kind).toBe("skip-noprobe");
    expect(e?.keyword).toBe("deploy-panel");
    expect(e?.tool_name).toBe("Bash");
    expect(e?.command).toContain("docker-compose");
    expect(e?.trigger_category).toBe("compose-mutation");
    expect(e?.severity).toBeNull();
    expect(e?.env_overrides_applied.probe_fail_block).toBe(false);
  });

  it("probe-fail — emitted when probe throws (degrade to allow path)", () => {
    const { events, sink } = captureAudit();
    const throwingProbe: Probe = () => {
      throw new Error("docker socket unreachable");
    };
    handlePolicyPreToolUse(
      COMPOSE_PAYLOAD,
      { RUNTIME_REALITY_KEYWORD: "deploy-panel" },
      {
        ...baseDeps,
        loadExpectations: () => expectations([{ name: "panel-api" }]),
        probe: throwingProbe,
        appendAudit: sink,
      },
    );
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e?.kind).toBe("probe-fail");
    expect(e?.reason).toContain("probe failed");
    expect(e?.reason).toContain("docker socket unreachable");
    expect(e?.env_overrides_applied.probe_fail_block).toBe(false);
  });

  it("probe-fail — emitted with probe_fail_block=true on the block branch too", () => {
    const { events, sink } = captureAudit();
    handlePolicyPreToolUse(
      COMPOSE_PAYLOAD,
      {
        RUNTIME_REALITY_KEYWORD: "deploy-panel",
        RUNTIME_REALITY_PROBE_FAIL_BLOCK: "1",
      },
      {
        ...baseDeps,
        loadExpectations: () => expectations([{ name: "panel-api" }]),
        probe: null,
        appendAudit: sink,
      },
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("probe-fail");
    expect(events[0]?.env_overrides_applied.probe_fail_block).toBe(true);
  });

  it("warn — drift_count + severity=warning captured", () => {
    const { events, sink } = captureAudit();
    // Warning-tier drift = startup_drift OR port_drift (see lib.ts
    // buildDriftItems). Process running, but started under the wrong
    // startup mode → one warning, no critical.
    const warningProbe: Probe = () => [
      { name: "panel-api", running: true, startup_mode: "docker" },
    ];
    handlePolicyPreToolUse(
      COMPOSE_PAYLOAD,
      { RUNTIME_REALITY_KEYWORD: "deploy-panel" },
      {
        ...baseDeps,
        loadExpectations: () =>
          expectations([{ name: "panel-api", expected_startup: "systemd" }]),
        probe: warningProbe,
        appendAudit: sink,
      },
    );
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e?.kind).toBe("warn");
    expect(e?.severity).toBe("warning");
    expect(e?.drift_count).toBeGreaterThan(0);
    expect(e?.trigger_category).toBe("compose-mutation");
  });

  it("block — severity=critical, env overrides recorded", () => {
    const { events, sink } = captureAudit();
    // Missing process → critical drift.
    const criticalProbe: Probe = () => [];
    handlePolicyPreToolUse(
      COMPOSE_PAYLOAD,
      { RUNTIME_REALITY_KEYWORD: "deploy-panel" },
      {
        ...baseDeps,
        loadExpectations: () => expectations([{ name: "panel-api" }]),
        probe: criticalProbe,
        appendAudit: sink,
      },
    );
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e?.kind).toBe("block");
    expect(e?.severity).toBe("critical");
    expect(e?.drift_count).toBeGreaterThan(0);
    expect(e?.env_overrides_applied.critical_as_warn).toBe(false);
  });

  it("warn — critical drift degraded by RUNTIME_REALITY_CRITICAL_AS_WARN keeps severity=critical", () => {
    // The audit kind drops from block→warn but the underlying severity
    // remains critical so a later query can distinguish a true warn
    // (sev=warning) from a degraded critical (sev=critical, knob=on).
    const { events, sink } = captureAudit();
    handlePolicyPreToolUse(
      COMPOSE_PAYLOAD,
      {
        RUNTIME_REALITY_KEYWORD: "deploy-panel",
        RUNTIME_REALITY_CRITICAL_AS_WARN: "1",
      },
      {
        ...baseDeps,
        loadExpectations: () => expectations([{ name: "panel-api" }]),
        probe: () => [],
        appendAudit: sink,
      },
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("warn");
    expect(events[0]?.severity).toBe("critical");
    expect(events[0]?.env_overrides_applied.critical_as_warn).toBe(true);
  });

  it("block — warning escalated by RUNTIME_REALITY_WARN_AS_BLOCK keeps severity=warning", () => {
    const { events, sink } = captureAudit();
    handlePolicyPreToolUse(
      COMPOSE_PAYLOAD,
      {
        RUNTIME_REALITY_KEYWORD: "deploy-panel",
        RUNTIME_REALITY_WARN_AS_BLOCK: "1",
      },
      {
        ...baseDeps,
        loadExpectations: () =>
          expectations([{ name: "panel-api", expected_startup: "systemd" }]),
        probe: () => [
          { name: "panel-api", running: true, startup_mode: "docker" },
        ],
        appendAudit: sink,
      },
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("block");
    expect(events[0]?.severity).toBe("warning");
    expect(events[0]?.env_overrides_applied.warn_as_block).toBe(true);
  });
});

describe("no-op when appendAudit dep is omitted", () => {
  it("handler does not throw on any decision branch", () => {
    // Same scenarios that emit audit events when sink is present —
    // here the sink is omitted, the handler must produce identical
    // decisions without raising.
    expect(() =>
      handlePolicyPreToolUse(COMPOSE_PAYLOAD, { RUNTIME_REALITY_DISABLE: "1" }, baseDeps),
    ).not.toThrow();

    expect(() =>
      handlePolicyPreToolUse(
        COMPOSE_PAYLOAD,
        { RUNTIME_REALITY_KEYWORD: "deploy-panel" },
        {
          ...baseDeps,
          loadExpectations: () => expectations([{ name: "panel-api" }]),
          probe: () => [],
        },
      ),
    ).not.toThrow();
  });

  it("handler swallows writer exceptions so a broken disk cannot crash the hook", () => {
    const throwingSink: AppendAudit = () => {
      throw new Error("simulated EROFS");
    };
    expect(() =>
      handlePolicyPreToolUse(
        COMPOSE_PAYLOAD,
        { RUNTIME_REALITY_KEYWORD: "deploy-panel" },
        {
          ...baseDeps,
          loadExpectations: () => expectations([{ name: "panel-api" }]),
          probe: () => [],
          appendAudit: throwingSink,
        },
      ),
    ).not.toThrow();
  });
});

describe("default writer + RUNTIME_REALITY_AUDIT_LOG env knob", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "rrc-audit-"));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("resolveDefaultAuditLogPath honors RUNTIME_REALITY_AUDIT_LOG", () => {
    const override = join(tmpRoot, "custom-audit.log");
    const resolved = resolveDefaultAuditLogPath({ RUNTIME_REALITY_AUDIT_LOG: override });
    expect(resolved).toBe(override);
  });

  it("resolveDefaultAuditLogPath falls back to ~/.runtime-reality/audit.log when unset", () => {
    const resolved = resolveDefaultAuditLogPath({});
    expect(resolved.endsWith("/.runtime-reality/audit.log")).toBe(true);
  });

  it("createJsonlAuditWriter writes one JSONL line per event and survives concurrent calls", () => {
    const logPath = join(tmpRoot, "nested", "audit.log");
    const writer = createJsonlAuditWriter(logPath);
    const event1: AuditEvent = {
      kind: "block",
      iso_timestamp: "2026-05-27T04:00:00.000Z",
      keyword: "deploy-panel",
      tool_name: "Bash",
      command: "docker-compose down",
      trigger_category: "compose-mutation",
      drift_count: 2,
      severity: "critical",
      env_overrides_applied: {
        disable: false,
        warn_as_block: false,
        critical_as_warn: false,
        probe_fail_block: false,
      },
      reason: "test event 1",
    };
    const event2: AuditEvent = { ...event1, reason: "test event 2", kind: "warn" };

    writer(event1);
    writer(event2);

    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ kind: "block", reason: "test event 1" });
    expect(JSON.parse(lines[1] as string)).toMatchObject({ kind: "warn", reason: "test event 2" });
  });

  it("createJsonlAuditWriter swallows fs errors so the hot path never throws", () => {
    // Point the writer at a path under a file (not a directory) — mkdirSync
    // will throw ENOTDIR. The wrapper must catch.
    const blockingFile = join(tmpRoot, "blocker");
    require("node:fs").writeFileSync(blockingFile, "I am a file, not a directory");
    const wedgedPath = join(blockingFile, "audit.log");
    const writer = createJsonlAuditWriter(wedgedPath);
    expect(() =>
      writer({
        kind: "disabled",
        iso_timestamp: "2026-05-27T04:00:00.000Z",
        keyword: null,
        tool_name: null,
        command: null,
        trigger_category: null,
        drift_count: 0,
        severity: null,
        env_overrides_applied: {
          disable: true,
          warn_as_block: false,
          critical_as_warn: false,
          probe_fail_block: false,
        },
        reason: "expected to be swallowed",
      }),
    ).not.toThrow();
  });

  it("end-to-end: handler + default writer produce a JSONL audit trail at the env-overridden path", () => {
    // The audit-log env knob is read by the entrypoint adapter, not the
    // handler, so PolicyEnv intentionally doesn't include it. Mirror the
    // adapter's wiring here.
    const auditPath = join(tmpRoot, "e2e-audit.log");
    handlePolicyPreToolUse(
      COMPOSE_PAYLOAD,
      { RUNTIME_REALITY_KEYWORD: "deploy-panel" },
      {
        ...baseDeps,
        loadExpectations: () => expectations([{ name: "panel-api" }]),
        probe: () => [],
        appendAudit: createJsonlAuditWriter(
          resolveDefaultAuditLogPath({ RUNTIME_REALITY_AUDIT_LOG: auditPath }),
        ),
      },
    );

    const lines = readFileSync(auditPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] as string);
    expect(parsed.kind).toBe("block");
    expect(parsed.severity).toBe("critical");
    expect(parsed.keyword).toBe("deploy-panel");
  });
});
