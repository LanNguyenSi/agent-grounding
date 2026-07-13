/**
 * CLI entrypoint tests for grounding-wrapper.
 *
 * Mocks initSession, getCurrentTools, isGuardrailActive so no real grounding
 * logic runs. Tests verify argument wiring, --json toggle, and guardrail
 * active/inactive output paths.
 */

jest.mock('../lib', () => ({
  initSession: jest.fn(),
  getCurrentTools: jest.fn(),
  isGuardrailActive: jest.fn(),
  generateSessionId: jest.fn(() => 'gs-clawd-monitor-abc123'),
  resolveGuardrails: jest.fn(() => []),
  buildMandatorySequence: jest.fn(() => []),
  buildSteps: jest.fn(() => []),
  advancePhase: jest.fn(),
  handleScopeChange: jest.fn(),
  validateKeyword: jest.fn(),
  KEYWORD_MAX_LENGTH: 100,
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { buildProgram } from '../index';
import * as lib from '../lib';

const mockInitSession = lib.initSession as jest.Mock;
const mockGetCurrentTools = lib.getCurrentTools as jest.Mock;
const mockIsGuardrailActive = lib.isGuardrailActive as jest.Mock;

const FAKE_SESSION = {
  id: 'gs-clawd-monitor-abc123',
  keyword: 'clawd-monitor',
  problem: 'port not responding',
  resolved_scope: 'clawd-monitor',
  mandatory_sequence: ['domain-router', 'readme-first-resolver'],
  active_guardrails: ['no-root-cause-before-readme'] as const,
  current_phase: 'scope-resolution' as const,
  steps: [
    {
      tool: 'domain-router',
      description: 'Resolve domain scope',
      mandatory: true,
      phase: 'scope-resolution' as const,
    },
    {
      tool: 'readme-first-resolver',
      description: 'Read primary docs',
      mandatory: true,
      phase: 'doc-reading' as const,
    },
  ],
};

const FAKE_CURRENT_TOOLS = [
  { tool: 'domain-router', description: 'Resolve domain scope' },
];

function parse(args: string[]): void {
  buildProgram().parse(['node', 'grounding-wrapper', ...args]);
}

let logSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockInitSession.mockReturnValue(FAKE_SESSION);
  mockGetCurrentTools.mockReturnValue(FAKE_CURRENT_TOOLS);
  mockIsGuardrailActive.mockReturnValue(true);
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

// ── start command ─────────────────────────────────────────────────────────────

describe('start command', () => {
  it('calls initSession with keyword and problem', () => {
    parse(['start', '-k', 'clawd-monitor', '-p', 'port not responding']);
    expect(mockInitSession).toHaveBeenCalledWith({
      keyword: 'clawd-monitor',
      problem: 'port not responding',
    });
  });

  it('outputs JSON when --json flag is set', () => {
    parse(['start', '-k', 'clawd-monitor', '-p', 'issue', '--json']);
    const raw = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe('gs-clawd-monitor-abc123');
    expect(parsed.resolved_scope).toBe('clawd-monitor');
    expect(parsed.mandatory_sequence).toEqual(['domain-router', 'readme-first-resolver']);
    expect(parsed.active_guardrails).toContain('no-root-cause-before-readme');
  });

  it('human output shows session id and scope', () => {
    parse(['start', '-k', 'clawd-monitor', '-p', 'issue']);
    const allLogs = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(allLogs).toContain('gs-clawd-monitor-abc123');
    expect(allLogs).toContain('clawd-monitor');
  });

  it('human output lists mandatory sequence tools', () => {
    parse(['start', '-k', 'clawd-monitor', '-p', 'issue']);
    const allLogs = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(allLogs).toContain('domain-router');
    expect(allLogs).toContain('readme-first-resolver');
  });

  it('calls getCurrentTools and shows first tool in human output', () => {
    parse(['start', '-k', 'clawd-monitor', '-p', 'issue']);
    expect(mockGetCurrentTools).toHaveBeenCalledWith(FAKE_SESSION);
    const allLogs = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(allLogs).toContain('Resolve domain scope');
  });

  it('JSON output does not include steps array (only selected fields)', () => {
    parse(['start', '-k', 'clawd-monitor', '-p', 'issue', '--json']);
    const raw = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(raw);
    // steps are not in the JSON output per the action implementation
    expect(parsed).not.toHaveProperty('steps');
    expect(parsed).toHaveProperty('current_phase');
  });
});

// ── check-guardrail command ───────────────────────────────────────────────────

describe('check-guardrail command', () => {
  it('calls initSession with keyword and placeholder problem', () => {
    parse(['check-guardrail', '-k', 'clawd-monitor', '-g', 'no-root-cause-before-readme']);
    expect(mockInitSession).toHaveBeenCalledWith({
      keyword: 'clawd-monitor',
      problem: '-',
    });
  });

  it('calls isGuardrailActive with session and guardrail id', () => {
    parse(['check-guardrail', '-k', 'clawd-monitor', '-g', 'no-root-cause-before-readme']);
    expect(mockIsGuardrailActive).toHaveBeenCalledWith(
      FAKE_SESSION,
      'no-root-cause-before-readme',
    );
  });

  it('prints ACTIVE when guardrail is active', () => {
    mockIsGuardrailActive.mockReturnValueOnce(true);
    parse(['check-guardrail', '-k', 'clawd-monitor', '-g', 'no-root-cause-before-readme']);
    const allLogs = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(allLogs).toContain('ACTIVE');
  });

  it('prints NOT ACTIVE when guardrail is inactive', () => {
    mockIsGuardrailActive.mockReturnValueOnce(false);
    parse(['check-guardrail', '-k', 'clawd-monitor', '-g', 'no-root-cause-before-readme']);
    const allLogs = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(allLogs).toContain('NOT ACTIVE');
  });
});

// ── show-phases command ───────────────────────────────────────────────────────

describe('show-phases command', () => {
  it('calls initSession with keyword and problem', () => {
    parse(['show-phases', '-k', 'clawd-monitor', '-p', 'issue']);
    expect(mockInitSession).toHaveBeenCalledWith({
      keyword: 'clawd-monitor',
      problem: 'issue',
    });
  });

  it('outputs JSON of session.steps when --json flag set', () => {
    parse(['show-phases', '-k', 'clawd-monitor', '-p', 'issue', '--json']);
    const raw = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].tool).toBe('domain-router');
  });

  it('human output lists phase headers and tools', () => {
    parse(['show-phases', '-k', 'clawd-monitor', '-p', 'issue']);
    const allLogs = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(allLogs).toContain('scope-resolution');
    expect(allLogs).toContain('doc-reading');
    expect(allLogs).toContain('domain-router');
    expect(allLogs).toContain('readme-first-resolver');
  });

  it('each phase header appears only once in human output', () => {
    parse(['show-phases', '-k', 'clawd-monitor', '-p', 'issue']);
    const allLogs = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    // 'scope-resolution' appears once, 'doc-reading' appears once
    const scopeCount = (allLogs.match(/scope-resolution/g) ?? []).length;
    expect(scopeCount).toBe(1);
  });
});

// ── --version ────────────────────────────────────────────────────────────────
// Regression test for a version desync: the CLI used to hardcode a version
// string separate from package.json, so a release bump could silently leave
// `grounding-wrapper --version` printing a stale number. The version must be
// derived from package.json, not duplicated.

describe('--version', () => {
  it('reports the version from package.json', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '../../package.json'), 'utf8'),
    ) as { version: string };
    expect(buildProgram().version()).toBe(pkg.version);
  });
});
