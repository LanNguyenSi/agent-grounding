/**
 * Runtime Reality Checker
 *
 * Compares actual runtime state against documentation / expectations.
 * Surfaces drift between what-is-documented and what-is-actually-running.
 * Based on lan-tools/08-runtime-reality-checker.md
 */

export type StartupMode = "systemd" | "docker" | "pm2" | "manual" | "cron" | "unknown";
export type ProcessStatus = "running" | "stopped" | "unknown";

export interface ExpectedProcess {
  name: string;
  /** How it should be started in production */
  expected_startup?: StartupMode;
  /** Port it should be listening on */
  expected_port?: number;
}

export interface ActualProcessState {
  name: string;
  running: boolean;
  pid?: number;
  startup_mode?: StartupMode;
  port?: number;
}

export interface DriftItem {
  severity: "critical" | "warning" | "info";
  message: string;
}

export interface RealityCheckResult {
  domain: string;
  timestamp: string;
  processes: ProcessCheckResult[];
  drift: DriftItem[];
  ready_for_diagnosis: boolean;
  summary: string;
}

export interface ProcessCheckResult {
  name: string;
  expected_running: boolean;
  actual_running: boolean;
  drift: boolean;
  startup_mode?: StartupMode;
  expected_startup?: StartupMode;
  startup_drift: boolean;
  port?: number;
  expected_port?: number;
  port_drift: boolean;
}

/** Compare expected vs actual process states and compute drift */
export function checkProcesses(
  expected: ExpectedProcess[],
  actual: ActualProcessState[],
): ProcessCheckResult[] {
  return expected.map((exp) => {
    const found = actual.find((a) => a.name === exp.name || a.name.includes(exp.name));
    const actualRunning = found?.running ?? false;
    const startupDrift =
      !!exp.expected_startup && !!found?.startup_mode && found.startup_mode !== exp.expected_startup;
    const portDrift = !!exp.expected_port && !!found?.port && found.port !== exp.expected_port;

    return {
      name: exp.name,
      expected_running: true,
      actual_running: actualRunning,
      drift: !actualRunning,
      startup_mode: found?.startup_mode,
      expected_startup: exp.expected_startup,
      startup_drift: startupDrift,
      port: found?.port,
      expected_port: exp.expected_port,
      port_drift: portDrift,
    };
  });
}

/** Generate drift items from process check results */
export function buildDriftItems(processResults: ProcessCheckResult[]): DriftItem[] {
  const drift: DriftItem[] = [];

  for (const proc of processResults) {
    if (proc.drift) {
      drift.push({
        severity: "critical",
        message: `Process '${proc.name}' expected to be running but is NOT`,
      });
    }
    if (proc.startup_drift) {
      drift.push({
        severity: "warning",
        message: `Process '${proc.name}' started via '${proc.startup_mode}' but expected '${proc.expected_startup}'`,
      });
    }
    if (proc.port_drift) {
      drift.push({
        severity: "warning",
        message: `Process '${proc.name}' listening on port ${proc.port} but expected ${proc.expected_port}`,
      });
    }
  }

  return drift;
}

/** Full reality check — compare expected vs actual, produce report */
export function runRealityCheck(
  domain: string,
  expected: ExpectedProcess[],
  actual: ActualProcessState[],
): RealityCheckResult {
  const processResults = checkProcesses(expected, actual);
  const drift = buildDriftItems(processResults);

  const criticalDrift = drift.filter((d) => d.severity === "critical");
  const ready_for_diagnosis = criticalDrift.length === 0;

  let summary: string;
  if (drift.length === 0) {
    summary = `✅ Runtime matches documentation — ${processResults.length} process(es) verified`;
  } else if (criticalDrift.length > 0) {
    summary = `🚨 ${criticalDrift.length} critical drift(s) found — fix before diagnosing`;
  } else {
    summary = `⚠️ ${drift.length} warning(s) — documentation may be outdated`;
  }

  return {
    domain,
    timestamp: new Date().toISOString(),
    processes: processResults,
    drift,
    ready_for_diagnosis,
    summary,
  };
}

/** Check if there are any critical drifts that block diagnosis */
export function hasCriticalDrift(result: RealityCheckResult): boolean {
  return result.drift.some((d) => d.severity === "critical");
}

/** Get only critical drift items */
export function getCriticalDrift(result: RealityCheckResult): DriftItem[] {
  return result.drift.filter((d) => d.severity === "critical");
}
