/**
 * CLI entrypoint tests for readme-first-resolver.
 *
 * Mocks the resolve() lib function so no real filesystem reads happen.
 * Tests verify argument wiring, --files option, and --json vs human output.
 */

jest.mock('../lib', () => ({
  resolve: jest.fn(),
  readFileIfExists: jest.fn(() => null),
  DEFAULT_MUST_READ: ['README.md', 'AGENT_ENTRYPOINT.yaml', '.env.example'],
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { buildProgram } from '../index';
import * as lib from '../lib';

const mockResolve = lib.resolve as jest.Mock;

const READY_RESULT = {
  system_summary: {
    purpose: 'Agent orchestration',
    main_components: ['orchestrator', 'relay'],
    runtime_model: ['node'],
    required_config: ['API_KEY'],
  },
  unknowns: [],
  sources_read: ['README.md'],
  sources_missing: [],
  ready_for_analysis: true,
};

const NOT_READY_RESULT = {
  system_summary: {
    purpose: 'Unknown',
    main_components: [],
    runtime_model: [],
    required_config: [],
  },
  unknowns: ['purpose is unclear'],
  sources_read: [],
  sources_missing: ['README.md'],
  ready_for_analysis: false,
};

function parse(args: string[]): void {
  buildProgram().parse(['node', 'readme-first', ...args]);
}

let logSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockResolve.mockReturnValue(READY_RESULT);
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

// ── resolve command ───────────────────────────────────────────────────────────

describe('resolve command', () => {
  it('calls resolve() with repo_path from --path', () => {
    parse(['resolve', '-p', '/repo/path']);
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({ repo_path: '/repo/path' }),
    );
  });

  it('passes must_read from --files', () => {
    parse(['resolve', '-p', '/repo', '--files', 'README.md', 'CHANGELOG.md']);
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({ must_read: ['README.md', 'CHANGELOG.md'] }),
    );
  });

  it('must_read is undefined when --files not provided', () => {
    parse(['resolve', '-p', '/repo']);
    expect(mockResolve).toHaveBeenCalledWith(
      expect.objectContaining({ must_read: undefined }),
    );
  });

  it('outputs JSON when --json flag is set', () => {
    parse(['resolve', '-p', '/repo', '--json']);
    const raw = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.ready_for_analysis).toBe(true);
    expect(parsed.system_summary.purpose).toBe('Agent orchestration');
  });

  it('outputs human text showing Ready status', () => {
    parse(['resolve', '-p', '/repo']);
    const allLogs = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(allLogs).toContain('Ready');
    expect(allLogs).toContain('Agent orchestration');
  });

  it('human output shows Not ready and unknowns when not ready', () => {
    mockResolve.mockReturnValueOnce(NOT_READY_RESULT);
    parse(['resolve', '-p', '/repo']);
    const allLogs = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(allLogs).toContain('Not ready');
    expect(allLogs).toContain('purpose is unclear');
  });

  it('shows missing sources in human output', () => {
    mockResolve.mockReturnValueOnce(NOT_READY_RESULT);
    parse(['resolve', '-p', '/repo']);
    const allLogs = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(allLogs).toContain('README.md');
  });
});

// ── --version ────────────────────────────────────────────────────────────────
// Regression test for a version desync: the CLI used to hardcode a version
// string separate from package.json, so a release bump could silently leave
// `readme-first --version` printing a stale number. The version must be
// derived from package.json, not duplicated.

describe('--version', () => {
  it('reports the version from package.json', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '../../package.json'), 'utf8'),
    ) as { version: string };
    expect(buildProgram().version()).toBe(pkg.version);
  });
});
