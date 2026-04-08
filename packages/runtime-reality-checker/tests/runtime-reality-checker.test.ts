import { describe, expect, it } from "vitest";
import {
  checkProcesses,
  buildDriftItems,
  runRealityCheck,
  hasCriticalDrift,
  getCriticalDrift,
} from "../src/lib.js";

describe("checkProcesses", () => {
  it("reports no drift when all processes running as expected", () => {
    const results = checkProcesses(
      [{ name: "clawd-monitor", expected_startup: "systemd", expected_port: 3000 }],
      [{ name: "clawd-monitor", running: true, startup_mode: "systemd", port: 3000 }],
    );
    expect(results[0]!.drift).toBe(false);
    expect(results[0]!.startup_drift).toBe(false);
    expect(results[0]!.port_drift).toBe(false);
    expect(results[0]!.actual_running).toBe(true);
  });

  it("reports drift when process is not running", () => {
    const results = checkProcesses(
      [{ name: "clawd-monitor" }],
      [{ name: "clawd-monitor", running: false }],
    );
    expect(results[0]!.drift).toBe(true);
    expect(results[0]!.actual_running).toBe(false);
  });

  it("reports drift when process not found in actual state", () => {
    const results = checkProcesses([{ name: "missing-service" }], []);
    expect(results[0]!.drift).toBe(true);
    expect(results[0]!.actual_running).toBe(false);
  });

  it("reports startup mode drift", () => {
    const results = checkProcesses(
      [{ name: "myapp", expected_startup: "systemd" }],
      [{ name: "myapp", running: true, startup_mode: "manual" }],
    );
    expect(results[0]!.startup_drift).toBe(true);
    expect(results[0]!.drift).toBe(false); // still running, just wrong startup mode
  });

  it("no startup drift when expected_startup not specified", () => {
    const results = checkProcesses(
      [{ name: "myapp" }], // no expected_startup
      [{ name: "myapp", running: true, startup_mode: "manual" }],
    );
    expect(results[0]!.startup_drift).toBe(false);
  });

  it("reports port drift", () => {
    const results = checkProcesses(
      [{ name: "api", expected_port: 3000 }],
      [{ name: "api", running: true, port: 4000 }],
    );
    expect(results[0]!.port_drift).toBe(true);
  });

  it("no port drift when ports match", () => {
    const results = checkProcesses(
      [{ name: "api", expected_port: 3000 }],
      [{ name: "api", running: true, port: 3000 }],
    );
    expect(results[0]!.port_drift).toBe(false);
  });

  it("matches process by partial name", () => {
    const results = checkProcesses(
      [{ name: "clawd" }],
      [{ name: "clawd-monitor-agent", running: true }],
    );
    expect(results[0]!.actual_running).toBe(true);
  });

  it("handles multiple processes", () => {
    const results = checkProcesses(
      [{ name: "api" }, { name: "worker" }, { name: "scheduler" }],
      [
        { name: "api", running: true },
        { name: "worker", running: false },
        // scheduler missing
      ],
    );
    expect(results[0]!.drift).toBe(false);
    expect(results[1]!.drift).toBe(true);
    expect(results[2]!.drift).toBe(true);
  });
});

describe("buildDriftItems", () => {
  it("creates critical drift for stopped process", () => {
    const processResults = checkProcesses(
      [{ name: "clawd" }],
      [{ name: "clawd", running: false }],
    );
    const drift = buildDriftItems(processResults);
    expect(drift).toHaveLength(1);
    expect(drift[0]!.severity).toBe("critical");
    expect(drift[0]!.message).toContain("clawd");
  });

  it("creates warning drift for startup mode mismatch", () => {
    const processResults = checkProcesses(
      [{ name: "app", expected_startup: "systemd" }],
      [{ name: "app", running: true, startup_mode: "manual" }],
    );
    const drift = buildDriftItems(processResults);
    expect(drift[0]!.severity).toBe("warning");
    expect(drift[0]!.message).toContain("manual");
    expect(drift[0]!.message).toContain("systemd");
  });

  it("creates warning drift for port mismatch", () => {
    const processResults = checkProcesses(
      [{ name: "api", expected_port: 3000 }],
      [{ name: "api", running: true, port: 4000 }],
    );
    const drift = buildDriftItems(processResults);
    expect(drift[0]!.severity).toBe("warning");
    expect(drift[0]!.message).toContain("4000");
    expect(drift[0]!.message).toContain("3000");
  });

  it("returns empty array for no drift", () => {
    const processResults = checkProcesses(
      [{ name: "api" }],
      [{ name: "api", running: true }],
    );
    expect(buildDriftItems(processResults)).toHaveLength(0);
  });
});

describe("runRealityCheck", () => {
  it("reports ready_for_diagnosis when no critical drift", () => {
    const result = runRealityCheck(
      "my-domain",
      [{ name: "api" }],
      [{ name: "api", running: true }],
    );
    expect(result.ready_for_diagnosis).toBe(true);
    expect(result.domain).toBe("my-domain");
    expect(result.summary).toContain("✅");
  });

  it("blocks diagnosis when critical drift found", () => {
    const result = runRealityCheck(
      "my-domain",
      [{ name: "api" }],
      [{ name: "api", running: false }],
    );
    expect(result.ready_for_diagnosis).toBe(false);
    expect(result.summary).toContain("🚨");
  });

  it("shows warning summary for non-critical drift only", () => {
    const result = runRealityCheck(
      "my-domain",
      [{ name: "api", expected_startup: "systemd" }],
      [{ name: "api", running: true, startup_mode: "manual" }],
    );
    expect(result.ready_for_diagnosis).toBe(true); // process is running
    expect(result.summary).toContain("⚠️");
  });

  it("includes timestamp in result", () => {
    const result = runRealityCheck("test", [], []);
    expect(result.timestamp).toBeTruthy();
    expect(new Date(result.timestamp).getTime()).toBeGreaterThan(0);
  });
});

describe("hasCriticalDrift / getCriticalDrift", () => {
  it("returns true when critical drift exists", () => {
    const result = runRealityCheck("test", [{ name: "svc" }], []);
    expect(hasCriticalDrift(result)).toBe(true);
  });

  it("returns false when no critical drift", () => {
    const result = runRealityCheck("test", [{ name: "svc" }], [{ name: "svc", running: true }]);
    expect(hasCriticalDrift(result)).toBe(false);
  });

  it("getCriticalDrift returns only critical items", () => {
    const result = runRealityCheck(
      "test",
      [{ name: "a" }, { name: "b", expected_startup: "systemd" }],
      [
        { name: "a", running: false }, // critical
        { name: "b", running: true, startup_mode: "manual" }, // warning
      ],
    );
    const critical = getCriticalDrift(result);
    expect(critical).toHaveLength(1);
    expect(critical[0]!.severity).toBe("critical");
  });
});
