/**
 * CLI entrypoint tests for debug-playbook-engine.
 *
 * Mocks getPlaybook, initRun, getCurrentStep, getRemainingMandatory so no
 * real playbook logic runs. Tests verify argument wiring, --json toggle,
 * and "no current step" path.
 */

jest.mock('../lib', () => ({
  getPlaybook: jest.fn(),
  initRun: jest.fn(),
  getCurrentStep: jest.fn(),
  recordStep: jest.fn(),
  getRemainingMandatory: jest.fn(),
}));

import { buildProgram } from '../index';
import * as lib from '../lib';

const mockGetPlaybook = lib.getPlaybook as jest.Mock;
const mockInitRun = lib.initRun as jest.Mock;
const mockGetCurrentStep = lib.getCurrentStep as jest.Mock;
const mockGetRemainingMandatory = lib.getRemainingMandatory as jest.Mock;

const FAKE_PLAYBOOK = {
  name: 'clawd-monitor.basic-connectivity',
  domain: 'clawd-monitor',
  problem: 'port not responding',
  steps: [
    { id: 'check-process', action: 'ps aux | grep clawd', mandatory: true },
    { id: 'check-port', action: 'nc -zv localhost 8080', mandatory: true },
    { id: 'check-logs', action: 'tail -f /var/log/clawd.log', mandatory: false },
  ],
};

const FAKE_STATE = {
  playbook: FAKE_PLAYBOOK,
  current_step: 0,
  completed: false,
  facts: {},
};

const FAKE_STEP = FAKE_PLAYBOOK.steps[0];

function parse(args: string[]): void {
  buildProgram().parse(['node', 'debug-playbook', ...args]);
}

let logSpy: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPlaybook.mockReturnValue(FAKE_PLAYBOOK);
  mockInitRun.mockReturnValue(FAKE_STATE);
  mockGetCurrentStep.mockReturnValue(FAKE_STEP);
  mockGetRemainingMandatory.mockReturnValue([FAKE_STEP]);
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

// ── run command ───────────────────────────────────────────────────────────────

describe('run command', () => {
  it('calls getPlaybook with domain and problem', () => {
    parse(['run', '-d', 'clawd-monitor', '-p', 'port not responding']);
    expect(mockGetPlaybook).toHaveBeenCalledWith('clawd-monitor', 'port not responding');
  });

  it('calls initRun with the returned playbook', () => {
    parse(['run', '-d', 'clawd-monitor', '-p', 'issue']);
    expect(mockInitRun).toHaveBeenCalledWith(FAKE_PLAYBOOK);
  });

  it('outputs JSON containing playbook when --json flag set', () => {
    parse(['run', '-d', 'clawd-monitor', '-p', 'issue', '--json']);
    const raw = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(raw);
    expect(parsed.name).toBe('clawd-monitor.basic-connectivity');
    expect(parsed.steps).toHaveLength(3);
  });

  it('outputs human text with step list without --json', () => {
    parse(['run', '-d', 'clawd-monitor', '-p', 'issue']);
    const allLogs = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(allLogs).toContain('check-process');
    expect(allLogs).toContain('clawd-monitor.basic-connectivity');
  });

  it('shows "Start with" hint when getCurrentStep returns a step', () => {
    parse(['run', '-d', 'clawd-monitor', '-p', 'issue']);
    const allLogs = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(allLogs).toContain('Start with');
  });

  it('does not show "Start with" when no current step', () => {
    mockGetCurrentStep.mockReturnValueOnce(null);
    parse(['run', '-d', 'clawd-monitor', '-p', 'issue']);
    const allLogs = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(allLogs).not.toContain('Start with');
  });
});

// ── next command ──────────────────────────────────────────────────────────────

describe('next command', () => {
  it('calls getPlaybook with domain and problem', () => {
    parse(['next', '-d', 'clawd-monitor', '-p', 'port not responding']);
    expect(mockGetPlaybook).toHaveBeenCalledWith('clawd-monitor', 'port not responding');
  });

  it('calls initRun and getCurrentStep', () => {
    parse(['next', '-d', 'clawd-monitor', '-p', 'issue']);
    expect(mockInitRun).toHaveBeenCalledWith(FAKE_PLAYBOOK);
    expect(mockGetCurrentStep).toHaveBeenCalledWith(FAKE_STATE);
  });

  it('calls getRemainingMandatory', () => {
    parse(['next', '-d', 'clawd-monitor', '-p', 'issue']);
    expect(mockGetRemainingMandatory).toHaveBeenCalledWith(FAKE_STATE);
  });

  it('prints step id and action when a step is pending', () => {
    parse(['next', '-d', 'clawd-monitor', '-p', 'issue']);
    const allLogs = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(allLogs).toContain('check-process');
    expect(allLogs).toContain('ps aux | grep clawd');
  });

  it('prints remaining mandatory count', () => {
    mockGetRemainingMandatory.mockReturnValueOnce([FAKE_STEP, FAKE_STEP]);
    parse(['next', '-d', 'clawd-monitor', '-p', 'issue']);
    const allLogs = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(allLogs).toContain('2');
  });

  it('prints "All steps completed" when no current step', () => {
    mockGetCurrentStep.mockReturnValueOnce(null);
    parse(['next', '-d', 'clawd-monitor', '-p', 'issue']);
    const allLogs = logSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(allLogs).toContain('All steps completed');
  });
});
