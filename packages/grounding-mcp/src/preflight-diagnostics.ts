/**
 * Advisory diagnostics for the one preflight process started by
 * `evaluateSolution`. They make the returned evidence inspectable without
 * changing the compact verdict that is signed and consumed by the gate.
 */

export interface PreflightExecution {
  exitCode: number | null;
  signal: string | null;
  error?: string;
}

export interface PreflightDiagnostics {
  availability: 'available' | 'unavailable';
  complete: boolean;
  /** The original JSON value, including properties newer than this consumer. */
  payload?: unknown;
  execution: PreflightExecution;
  issues: string[];
}

const CHECK_STATUSES = new Set(['pass', 'fail', 'warn', 'skip', 'acknowledged']);
const CHECK_KINDS = new Set([
  'git-state',
  'lint',
  'typecheck',
  'test',
  'audit',
  'ci-simulation',
  'commit-convention',
  'secret-detection',
  'tdd',
  'custom',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function validateCheck(check: unknown, index: number, issues: string[]): void {
  const prefix = `checks[${index}]`;
  if (!isRecord(check)) {
    issues.push(`${prefix} must be an object`);
    return;
  }
  if (typeof check.name !== 'string' || check.name.trim() === '') issues.push(`${prefix}.name must be a non-empty string`);
  if (typeof check.kind !== 'string' || !CHECK_KINDS.has(check.kind)) issues.push(`${prefix}.kind is invalid`);
  if (typeof check.status !== 'string' || !CHECK_STATUSES.has(check.status)) issues.push(`${prefix}.status is invalid`);
  if (!isFiniteNumber(check.durationMs) || check.durationMs < 0) issues.push(`${prefix}.durationMs must be a non-negative number`);
  if (!isFiniteNumber(check.confidenceContribution)) issues.push(`${prefix}.confidenceContribution must be a number`);
  if (check.message !== undefined && typeof check.message !== 'string') issues.push(`${prefix}.message must be a string when present`);
  if (check.details !== undefined && !isStringArray(check.details)) issues.push(`${prefix}.details must be a string array when present`);
  if (check.status === 'acknowledged' &&
      (typeof check.message !== 'string' || !/acknowledged:\s*\S/i.test(check.message))) {
    issues.push(`${prefix}.acknowledged status is missing its reason in message`);
  }
}

/**
 * Validate only the documented shape. Unknown payload properties deliberately
 * remain untouched in `payload` for callers that understand newer fields.
 */
export function inspectPreflightPayload(payload: unknown, execution: PreflightExecution): PreflightDiagnostics {
  const issues: string[] = [];
  if (execution.exitCode === null) issues.push('preflight exit code is unavailable');
  if (execution.signal !== null) issues.push(`preflight ended with signal ${execution.signal}`);
  if (execution.error !== undefined) issues.push('preflight invocation reported an execution error');

  if (!isRecord(payload)) {
    issues.push('preflight JSON payload must be an object');
  } else {
    if (typeof payload.ready !== 'boolean') issues.push("preflight JSON is missing a boolean 'ready' field");
    if (!isFiniteNumber(payload.confidence) || payload.confidence < 0 || payload.confidence > 1) {
      issues.push('preflight confidence must be a number between 0 and 1');
    }
    if (!Array.isArray(payload.checks)) {
      issues.push('preflight checks must be an array');
    } else {
      payload.checks.forEach((check, index) => validateCheck(check, index, issues));
    }
    if (!isStringArray(payload.blockers)) issues.push('preflight blockers must be a string array');
    if (!isStringArray(payload.warnings)) issues.push('preflight warnings must be a string array');
    if (!isStringArray(payload.limitations)) issues.push('preflight limitations must be a string array');
    if (!isFiniteNumber(payload.durationMs) || payload.durationMs < 0) issues.push('preflight durationMs must be a non-negative number');
    if (!isCanonicalUtcTimestamp(payload.timestamp)) {
      issues.push('preflight timestamp must be a canonical UTC ISO date string');
    }
    if (typeof payload.ready === 'boolean' && execution.exitCode !== null && execution.signal === null) {
      const expectedExitCode = payload.ready ? 0 : 1;
      if (execution.exitCode !== expectedExitCode) {
        issues.push(`preflight ready=${payload.ready} requires exit code ${expectedExitCode}, got ${execution.exitCode}`);
      }
    }
  }

  return {
    availability: 'available',
    complete: issues.length === 0,
    payload,
    execution,
    issues,
  };
}

export function unavailablePreflightDiagnostics(execution: PreflightExecution, issue: string): PreflightDiagnostics {
  return {
    availability: 'unavailable',
    complete: false,
    execution,
    issues: [issue, ...(execution.error === undefined ? [] : ['preflight invocation reported an execution error'])],
  };
}
