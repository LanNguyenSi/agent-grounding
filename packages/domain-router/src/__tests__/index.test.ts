/**
 * CLI entrypoint tests for domain-router.
 *
 * Mocks the lib functions (route, impact) so no filesystem access happens.
 * Tests verify argument wiring, option defaults, and --json vs human output.
 */

jest.mock('../lib', () => ({
  route: jest.fn(),
  impact: jest.fn(),
  // re-export other named exports with no-ops so the module loads cleanly
  normalizeKeyword: jest.fn((k: string) => k),
  scoreRepo: jest.fn(() => 0),
  getPriorityFiles: jest.fn(() => []),
  discoverRepos: jest.fn(() => []),
  inferRelatedComponents: jest.fn(() => []),
  findNpmDependency: jest.fn(() => null),
  findEntrypointReference: jest.fn(() => null),
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { buildProgram } from '../index';
import * as lib from '../lib';

const mockRoute = lib.route as jest.Mock;
const mockImpact = lib.impact as jest.Mock;

const ROUTE_RESULT = {
  domain: 'clawd-monitor',
  primary_repos: ['clawd-monitor'],
  related_components: ['agent-relay'],
  priority_files: ['README.md'],
  forbidden_initial_jumps: ['src/deep/file.ts'],
  confidence: 0.9,
};

const IMPACT_RESULT = {
  dependents: [
    { repo: 'agent-relay', type: 'npm' as const, detail: 'depends on clawd-monitor' },
  ],
};

function parse(args: string[]): void {
  buildProgram().parse(['node', 'domain-router', ...args]);
}

let logSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockRoute.mockReturnValue(ROUTE_RESULT);
  mockImpact.mockReturnValue(IMPACT_RESULT);
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

// ── route command ─────────────────────────────────────────────────────────────

describe('route command', () => {
  it('calls route() with keyword and workspace', () => {
    parse(['route', '-k', 'clawd-monitor', '-w', '/workspace']);
    expect(mockRoute).toHaveBeenCalledWith({
      keyword: 'clawd-monitor',
      workspace: '/workspace',
    });
  });

  it('outputs JSON when --json flag is set', () => {
    parse(['route', '-k', 'clawd-monitor', '-w', '/workspace', '--json']);
    const raw = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.domain).toBe('clawd-monitor');
    expect(parsed.confidence).toBe(0.9);
  });

  it('outputs human text without --json', () => {
    parse(['route', '-k', 'clawd-monitor', '-w', '/workspace']);
    const allLogs = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(allLogs).toContain('clawd-monitor');
  });

  it('JSON output contains all required fields', () => {
    parse(['route', '-k', 'clawd-monitor', '-w', '/ws', '--json']);
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(parsed).toHaveProperty('primary_repos');
    expect(parsed).toHaveProperty('related_components');
    expect(parsed).toHaveProperty('priority_files');
    expect(parsed).toHaveProperty('forbidden_initial_jumps');
  });
});

// ── impact command ────────────────────────────────────────────────────────────

describe('impact command', () => {
  it('calls impact() with keyword and workspace', () => {
    parse(['impact', '-k', 'clawd-monitor', '-w', '/workspace']);
    expect(mockImpact).toHaveBeenCalledWith('clawd-monitor', '/workspace');
  });

  it('outputs JSON when --json flag is set', () => {
    parse(['impact', '-k', 'clawd-monitor', '-w', '/workspace', '--json']);
    const raw = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.dependents).toHaveLength(1);
    expect(parsed.dependents[0].repo).toBe('agent-relay');
  });

  it('outputs human text without --json', () => {
    parse(['impact', '-k', 'clawd-monitor', '-w', '/workspace']);
    const allLogs = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(allLogs).toContain('agent-relay');
  });

  it('prints no-dependents message when list is empty', () => {
    mockImpact.mockReturnValueOnce({ dependents: [] });
    parse(['impact', '-k', 'unknown', '-w', '/workspace']);
    const allLogs = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(allLogs).toContain('No dependents found');
  });
});

// ── --version ────────────────────────────────────────────────────────────────
// Regression test for a version desync: the CLI used to hardcode a version
// string separate from package.json, so a release bump could silently leave
// `domain-router --version` printing a stale number. The version must be
// derived from package.json, not duplicated.

describe('--version', () => {
  it('reports the version from package.json', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '../../package.json'), 'utf8'),
    ) as { version: string };
    expect(buildProgram().version()).toBe(pkg.version);
  });
});
