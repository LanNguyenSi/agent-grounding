// MCP-transport roundtrip tests for the grounding/gate/ledger/claim/solution/memory
// family of tools (~11 handlers in server.ts NOT covered by
// hypothesis-mcp-roundtrip.test.ts).
//
// Pattern: identical harness to hypothesis-mcp-roundtrip.test.ts —
// InMemoryTransport + real Client + real server (createServer()). Tests assert:
//   - Happy path: exact response content shape through the real transport.
//   - Failure / edge branch: zod schema rejection (isError:true) for invalid input,
//     and runtime error propagation (isError:true) for not-found sessions / gates.
//
// Handlers covered here:
//   grounding_start, grounding_advance, grounding_guardrail_check
//   ledger_add, ledger_summary, ledger_status
//   claim_evaluate, claim_evaluate_from_session
//   solution_evaluate, solution_gate
//   verify_memory_reference
//
// Also covers, in two dedicated blocks further below (not MCP-roundtrip
// tests in the same sense as the above — see each block's own intro
// comment): the `withProgressPings — unit` block (src/progress.ts's timer
// helper, exercised directly against a fake `ToolExtra` plus vitest fake
// timers, and `resolveProgressIntervalMs`, server.ts's exported
// progressIntervalMs validator) and the `solution_evaluate — progress
// notifications (MCP roundtrip)` block (the SDK's real onprogress/
// resetTimeoutOnProgress wire behavior).
//
// `solution_evaluate`/`solution_gate` write through `writeVerdict`, which
// always signs (verdict-signing.ts) and resolves + lazily creates a shared
// harness signing key under `<HARNESS_HOME>/harness.generated/`; this suite
// also isolates HARNESS_HOME to a tempdir so no test run ever reads or
// writes the host's real ~/.harness (or ~/.claude fallback) — mirrors
// solution-verdict.test.ts's isolation pattern.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ErrorCode, ProgressNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

import { createServer, resolveProgressIntervalMs } from '../src/server.js';
import {
  withProgressPings,
  DEFAULT_PROGRESS_MESSAGE,
  DEFAULT_PROGRESS_INTERVAL_MS,
  type ToolExtra,
} from '../src/progress.js';
import { resetStores } from '../src/hypothesis-store.js';
import { resetLedgerDb } from '../src/ledger-bridge.js';
import { writeVerdict } from '../src/solution-verdict.js';
import { MAX_LOOKUP_ID_LENGTH } from '../src/solution-attempt-log.js';
import { expectValidationError } from './expect-validation-error.js';

// ── Shared types ──────────────────────────────────────────────────────────────

interface ToolTextResponse {
  content: { type: string; text: string }[];
  isError?: boolean;
}

// Parse the JSON-text response shape used by every tool handler via
// jsonResponse(...). Treats non-conformant shapes as hard test failures so
// shape drift surfaces as a readable assertion, not a TypeError.
function parseToolResult(raw: unknown): unknown {
  const result = raw as ToolTextResponse;
  expect(result.content).toBeDefined();
  expect(Array.isArray(result.content)).toBe(true);
  expect(result.content[0]?.type).toBe('text');
  const text = result.content[0]?.text;
  expect(typeof text).toBe('string');
  return JSON.parse(text as string);
}

// ── Harness: MCP client ↔ server via InMemoryTransport ───────────────────────

let tmpRoot: string;
let prevSessionsDir: string | undefined;
let prevLedgerDb: string | undefined;
let prevVerdictDir: string | undefined;
let harnessHomeTmp: string;
let prevHarnessHome: string | undefined;
let client: Client;
let close: () => Promise<void>;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'grounding-mcp-gate-'));
  prevSessionsDir = process.env.GROUNDING_MCP_SESSIONS_DIR;
  prevLedgerDb = process.env.EVIDENCE_LEDGER_DB;
  prevVerdictDir = process.env.SOLUTION_VERDICT_DIR;

  process.env.GROUNDING_MCP_SESSIONS_DIR = join(tmpRoot, 'sessions');
  process.env.EVIDENCE_LEDGER_DB = join(tmpRoot, 'ledger.db');
  process.env.SOLUTION_VERDICT_DIR = join(tmpRoot, 'verdicts');

  prevHarnessHome = process.env.HARNESS_HOME;
  harnessHomeTmp = mkdtempSync(join(tmpdir(), 'grounding-mcp-gate-harness-home-'));
  process.env.HARNESS_HOME = harnessHomeTmp;

  resetLedgerDb();
  resetStores();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);

  client = new Client({ name: 'gate-roundtrip-test', version: '0.0.0' });
  await client.connect(clientTransport);

  close = async () => {
    await client.close();
    await server.close();
  };
});

afterEach(async () => {
  await close();
  resetLedgerDb();
  resetStores();
  if (prevSessionsDir === undefined) delete process.env.GROUNDING_MCP_SESSIONS_DIR;
  else process.env.GROUNDING_MCP_SESSIONS_DIR = prevSessionsDir;
  if (prevLedgerDb === undefined) delete process.env.EVIDENCE_LEDGER_DB;
  else process.env.EVIDENCE_LEDGER_DB = prevLedgerDb;
  if (prevVerdictDir === undefined) delete process.env.SOLUTION_VERDICT_DIR;
  else process.env.SOLUTION_VERDICT_DIR = prevVerdictDir;
  if (prevHarnessHome === undefined) delete process.env.HARNESS_HOME;
  else process.env.HARNESS_HOME = prevHarnessHome;
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(harnessHomeTmp, { recursive: true, force: true });
});

// ── grounding_start ───────────────────────────────────────────────────────────

describe('grounding_start — MCP roundtrip', () => {
  it('happy path: returns sessionId, currentPhase, mandatorySequence, activeGuardrails', async () => {
    const raw = await client.callTool({
      name: 'grounding_start',
      arguments: { keyword: 'deploy-panel', problem: 'frontend offline after deploy' },
    });
    const result = parseToolResult(raw) as {
      sessionId: string;
      keyword: string;
      problem: string;
      currentPhase: string;
      mandatorySequence: string[];
      activeGuardrails: string[];
      phaseStatus: Record<string, string>;
    };
    expect(typeof result.sessionId).toBe('string');
    expect(result.sessionId.length).toBeGreaterThan(0);
    expect(result.keyword).toBe('deploy-panel');
    expect(result.problem).toBe('frontend offline after deploy');
    expect(Array.isArray(result.mandatorySequence)).toBe(true);
    expect(result.mandatorySequence.length).toBeGreaterThan(0);
    expect(Array.isArray(result.activeGuardrails)).toBe(true);
    expect(typeof result.currentPhase).toBe('string');
    expect(typeof result.phaseStatus).toBe('object');
  });

  it('optional workspace field is accepted without error', async () => {
    const raw = await client.callTool({
      name: 'grounding_start',
      arguments: {
        keyword: 'agent-tasks',
        problem: 'tasks stuck in review',
        workspace: '/home/user/projects/agent-tasks',
      },
    });
    const result = parseToolResult(raw) as { sessionId: string; keyword: string };
    expect(result.keyword).toBe('agent-tasks');
    expect(typeof result.sessionId).toBe('string');
  });

  it('schema rejects a missing required keyword field', async () => {
    const raw = await client.callTool({
      name: 'grounding_start',
      // keyword is required but omitted
      arguments: { problem: 'frontend offline' } as Record<string, unknown>,
    });
    expectValidationError(raw, 'grounding_start', 'keyword');
  });

  it('schema rejects a missing required problem field', async () => {
    const raw = await client.callTool({
      name: 'grounding_start',
      arguments: { keyword: 'deploy-panel' } as Record<string, unknown>,
    });
    expectValidationError(raw, 'grounding_start', 'problem');
  });
});

// ── grounding_advance ─────────────────────────────────────────────────────────

describe('grounding_advance — MCP roundtrip', () => {
  it('happy path: advances the session to doc-reading after grounding_start', async () => {
    const startRaw = await client.callTool({
      name: 'grounding_start',
      arguments: { keyword: 'agent-grounding', problem: 'advance phase test' },
    });
    const started = parseToolResult(startRaw) as { sessionId: string; currentPhase: string };
    expect(started.currentPhase).toBe('scope-resolution');

    const advRaw = await client.callTool({
      name: 'grounding_advance',
      arguments: { sessionId: started.sessionId },
    });
    const advanced = parseToolResult(advRaw) as {
      sessionId: string;
      currentPhase: string;
      phaseStatus: Record<string, string>;
    };
    expect(advanced.sessionId).toBe(started.sessionId);
    expect(advanced.currentPhase).toBe('doc-reading');
    expect(advanced.phaseStatus['scope-resolution']).toBe('done');
  });

  it('unknown sessionId returns isError:true with "grounding session not found"', async () => {
    const raw = await client.callTool({
      name: 'grounding_advance',
      arguments: { sessionId: 'gs-never-started-advance' },
    });
    const result = raw as ToolTextResponse;
    expect(result.isError).toBe(true);
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('grounding session not found');
  });
});

// ── grounding_guardrail_check ─────────────────────────────────────────────────

describe('grounding_guardrail_check — MCP roundtrip', () => {
  it('happy path: returns {sessionId, guardrail, active} for a known guardrail', async () => {
    const startRaw = await client.callTool({
      name: 'grounding_start',
      arguments: { keyword: 'agent-tasks', problem: 'guardrail check test' },
    });
    const started = parseToolResult(startRaw) as { sessionId: string };

    const raw = await client.callTool({
      name: 'grounding_guardrail_check',
      arguments: {
        sessionId: started.sessionId,
        guardrail: 'no-root-cause-before-readme',
      },
    });
    const result = parseToolResult(raw) as {
      sessionId: string;
      guardrail: string;
      active: boolean;
    };
    expect(result.sessionId).toBe(started.sessionId);
    expect(result.guardrail).toBe('no-root-cause-before-readme');
    // Pin the VALUE, not just the type: this guardrail is in the active set
    // for a fresh agent-tasks session. Inverting the handler's `active` result
    // (security-relevant — guardrails gate premature claims) must fail here.
    expect(result.active).toBe(true);
  });

  it('schema rejects an invalid guardrail enum value', async () => {
    const raw = await client.callTool({
      name: 'grounding_guardrail_check',
      arguments: {
        sessionId: 'gs-any',
        guardrail: 'no-such-guardrail',
      },
    });
    expectValidationError(raw, 'grounding_guardrail_check', 'guardrail');
  });

  it('unknown sessionId returns isError:true — glue propagates loadSession throw', async () => {
    const raw = await client.callTool({
      name: 'grounding_guardrail_check',
      arguments: {
        sessionId: 'gs-guardrail-never-exists',
        guardrail: 'no-step-skipping',
      },
    });
    const result = raw as ToolTextResponse;
    expect(result.isError).toBe(true);
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('grounding session not found');
  });
});

// ── ledger_add ────────────────────────────────────────────────────────────────

describe('ledger_add — MCP roundtrip', () => {
  it('happy path: returns the created entry with type, content, session fields', async () => {
    const raw = await client.callTool({
      name: 'ledger_add',
      arguments: {
        sessionId: 'gs-ledger-add-1',
        type: 'fact',
        content: 'env REACT_PROXY missing in production compose',
        source: 'docker compose config',
        confidence: 'high',
      },
    });
    const entry = parseToolResult(raw) as {
      type: string;
      content: string;
      session: string;
      source?: string;
    };
    expect(entry.type).toBe('fact');
    expect(entry.content).toBe('env REACT_PROXY missing in production compose');
    expect(entry.session).toBe('gs-ledger-add-1');
    expect(entry.source).toBe('docker compose config');
  });

  it('accepts all valid type values without error', async () => {
    for (const type of ['fact', 'hypothesis', 'rejected', 'unknown', 'policy_decision'] as const) {
      const raw = await client.callTool({
        name: 'ledger_add',
        arguments: { sessionId: 'gs-ledger-types', type, content: `${type} entry` },
      });
      const entry = parseToolResult(raw) as { type: string };
      expect(entry.type).toBe(type);
    }
  });

  it('schema rejects an invalid type enum value', async () => {
    const raw = await client.callTool({
      name: 'ledger_add',
      arguments: {
        sessionId: 'gs-ledger-bad',
        type: 'observation',
        content: 'whatever',
      },
    });
    expectValidationError(raw, 'ledger_add', 'type');
  });

  it('schema rejects an invalid confidence enum value', async () => {
    const raw = await client.callTool({
      name: 'ledger_add',
      arguments: {
        sessionId: 'gs-ledger-conf-bad',
        type: 'fact',
        content: 'ok',
        confidence: 'certain',
      },
    });
    expectValidationError(raw, 'ledger_add', 'confidence');
  });
});

// ── ledger_summary ────────────────────────────────────────────────────────────

describe('ledger_summary — MCP roundtrip', () => {
  it('happy path: reflects entries added via ledger_add', async () => {
    const sessionId = 'gs-summary-1';
    await client.callTool({
      name: 'ledger_add',
      arguments: { sessionId, type: 'fact', content: 'fact one' },
    });
    await client.callTool({
      name: 'ledger_add',
      arguments: { sessionId, type: 'fact', content: 'fact two' },
    });
    await client.callTool({
      name: 'ledger_add',
      arguments: { sessionId, type: 'rejected', content: 'CDN cache was fine' },
    });

    const raw = await client.callTool({
      name: 'ledger_summary',
      arguments: { sessionId },
    });
    const result = parseToolResult(raw) as {
      sessionId: string;
      counts: { facts: number; hypotheses: number; rejected: number; unknowns: number; policyDecisions: number };
      entries: unknown;
    };
    expect(result.sessionId).toBe(sessionId);
    expect(result.counts.facts).toBe(2);
    expect(result.counts.rejected).toBe(1);
    expect(result.counts.hypotheses).toBe(0);
    expect(result.counts.unknowns).toBe(0);
    expect(result.counts.policyDecisions).toBe(0);
  });

  it('unknown / empty session returns zero counts (not an error)', async () => {
    const raw = await client.callTool({
      name: 'ledger_summary',
      arguments: { sessionId: 'gs-summary-never-seen' },
    });
    const result = parseToolResult(raw) as {
      sessionId: string;
      counts: { facts: number; hypotheses: number; rejected: number };
    };
    expect(result.sessionId).toBe('gs-summary-never-seen');
    expect(result.counts.facts).toBe(0);
    expect(result.counts.hypotheses).toBe(0);
    expect(result.counts.rejected).toBe(0);
  });

  it('contentPrefix filter returns only matching entries', async () => {
    const sessionId = 'gs-summary-filter';
    await client.callTool({
      name: 'ledger_add',
      arguments: { sessionId, type: 'fact', content: 'policy_decision: gate passed' },
    });
    await client.callTool({
      name: 'ledger_add',
      arguments: { sessionId, type: 'fact', content: 'ordinary fact' },
    });

    const raw = await client.callTool({
      name: 'ledger_summary',
      arguments: { sessionId, contentPrefix: 'policy_decision:' },
    });
    const result = parseToolResult(raw) as { counts: { facts: number } };
    expect(result.counts.facts).toBe(1);
  });
});

// ── ledger_status ─────────────────────────────────────────────────────────────

describe('ledger_status — MCP roundtrip', () => {
  it('happy path: returns status:ok, dbPath, entryCount, lastWriteAt', async () => {
    // Add an entry so entryCount > 0 and lastWriteAt is non-null.
    await client.callTool({
      name: 'ledger_add',
      arguments: { sessionId: 'gs-status', type: 'fact', content: 'some fact' },
    });

    const raw = await client.callTool({
      name: 'ledger_status',
      arguments: {},
    });
    const result = parseToolResult(raw) as {
      status: string;
      dbPath: string;
      entryCount: number;
      lastWriteAt: string | null;
    };
    expect(result.status).toBe('ok');
    expect(result.dbPath).toBe(process.env.EVIDENCE_LEDGER_DB);
    expect(result.entryCount).toBe(1);
    expect(typeof result.lastWriteAt).toBe('string');
  });

  it('returns status:ok with entryCount=0 on a fresh db', async () => {
    const raw = await client.callTool({
      name: 'ledger_status',
      arguments: {},
    });
    const result = parseToolResult(raw) as { status: string; entryCount: number };
    expect(result.status).toBe('ok');
    expect(result.entryCount).toBe(0);
  });
});

// ── claim_evaluate ────────────────────────────────────────────────────────────

describe('claim_evaluate — MCP roundtrip', () => {
  it('happy path deny: returns allowed:false with next_steps when context is empty', async () => {
    const raw = await client.callTool({
      name: 'claim_evaluate',
      arguments: {
        claim: 'the root cause is a missing environment variable',
        context: {
          has_evidence: false,
          alternatives_considered: false,
          readme_read: false,
        },
      },
    });
    const result = parseToolResult(raw) as {
      allowed: boolean;
      next_steps: unknown[];
      score: number;
    };
    expect(result.allowed).toBe(false);
    expect(Array.isArray(result.next_steps)).toBe(true);
    expect(result.next_steps.length).toBeGreaterThan(0);
    expect(typeof result.score).toBe('number');
  });

  it('happy path allow: returns allowed:true when all prerequisites are met', async () => {
    const raw = await client.callTool({
      name: 'claim_evaluate',
      arguments: {
        claim: 'the root cause is a missing environment variable',
        context: {
          readme_read: true,
          process_checked: true,
          config_checked: true,
          health_checked: true,
          has_evidence: true,
          alternatives_considered: true,
        },
      },
    });
    const result = parseToolResult(raw) as { allowed: boolean; score: number };
    expect(result.allowed).toBe(true);
    expect(result.score).toBe(100);
  });

  it('schema rejects an invalid type enum value', async () => {
    const raw = await client.callTool({
      name: 'claim_evaluate',
      arguments: {
        claim: 'the root cause is X',
        type: 'unknown_claim_type',
      },
    });
    expectValidationError(raw, 'claim_evaluate', 'type');
  });

  it('optional type override is accepted for each valid enum value', async () => {
    for (const type of [
      'root_cause',
      'architecture',
      'security',
      'network',
      'configuration',
      'process',
      'availability',
      'token',
      'generic',
    ] as const) {
      const raw = await client.callTool({
        name: 'claim_evaluate',
        arguments: {
          claim: `claim for type ${type}`,
          type,
          context: {},
        },
      });
      // All valid types produce a response with an `allowed` field (value varies
      // by prerequisites, but the shape must be present — not an MCP error).
      expect((raw as ToolTextResponse).isError).toBeUndefined();
      const result = parseToolResult(raw) as { allowed: boolean };
      expect(typeof result.allowed).toBe('boolean');
    }
  });
});

// ── claim_evaluate_from_session ───────────────────────────────────────────────

describe('claim_evaluate_from_session — MCP roundtrip', () => {
  it('happy path: derives context from session + ledger and returns derivedContext', async () => {
    // Start a session.
    const startRaw = await client.callTool({
      name: 'grounding_start',
      arguments: { keyword: 'deploy-panel', problem: 'session-based claim test' },
    });
    const started = parseToolResult(startRaw) as { sessionId: string };

    // Add a fact and a rejected entry to the ledger so derivedContext reflects them.
    await client.callTool({
      name: 'ledger_add',
      arguments: {
        sessionId: started.sessionId,
        type: 'fact',
        content: 'container health endpoint returns 503',
      },
    });
    await client.callTool({
      name: 'ledger_add',
      arguments: {
        sessionId: started.sessionId,
        type: 'rejected',
        content: 'CDN cache stale [rejected: cache hit count 0]',
      },
    });

    const raw = await client.callTool({
      name: 'claim_evaluate_from_session',
      arguments: {
        sessionId: started.sessionId,
        claim: 'the root cause is a missing env variable',
      },
    });
    const result = parseToolResult(raw) as {
      allowed: boolean;
      derivedContext: {
        readme_read: boolean;
        has_evidence: boolean;
        alternatives_considered: boolean;
      };
    };
    expect(typeof result.allowed).toBe('boolean');
    expect(typeof result.derivedContext).toBe('object');
    // has_evidence: true because a fact was added.
    expect(result.derivedContext.has_evidence).toBe(true);
    // alternatives_considered: true because a rejected entry was added.
    expect(result.derivedContext.alternatives_considered).toBe(true);
  });

  it('unknown sessionId returns isError:true — glue propagates loadSession throw', async () => {
    const raw = await client.callTool({
      name: 'claim_evaluate_from_session',
      arguments: {
        sessionId: 'gs-from-session-never-exists',
        claim: 'some claim',
      },
    });
    const result = raw as ToolTextResponse;
    expect(result.isError).toBe(true);
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('grounding session not found');
  });
});

// ── solution_evaluate ─────────────────────────────────────────────────────────
//
// Requires a real git repo with at least one commit + a stub preflight binary.
// The nested beforeEach/afterEach manage the repo lifecycle independently of
// the outer MCP-client lifecycle.

describe('solution_evaluate — MCP roundtrip', () => {
  let repo: string;
  let prevPreflightBin: string | undefined;

  function writeStub(name: string, body: string): string {
    const p = join(tmpRoot, name);
    writeFileSync(p, body, { mode: 0o755 });
    chmodSync(p, 0o755);
    return p;
  }

  beforeEach(() => {
    prevPreflightBin = process.env.SOLUTION_PREFLIGHT_BIN;
    repo = mkdtempSync(join(tmpdir(), 'solution-repo-mcp-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t.local'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
    writeFileSync(join(repo, 'readme.txt'), 'hello', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
  });

  afterEach(() => {
    if (prevPreflightBin === undefined) delete process.env.SOLUTION_PREFLIGHT_BIN;
    else process.env.SOLUTION_PREFLIGHT_BIN = prevPreflightBin;
    rmSync(repo, { recursive: true, force: true });
  });

  it('happy path: stub preflight ready → returns verdict {id, head, ready:true, blockers:[]}', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-ready.sh',
      '#!/bin/sh\necho \'{"ready":true,"confidence":0.9,"blockers":[]}\'\n',
    );
    const raw = await client.callTool({
      name: 'solution_evaluate',
      arguments: { id: 'mcp-task-1', repoPath: repo },
    });
    const result = parseToolResult(raw) as {
      verdict: { id: string; ready: boolean; blockers: string[]; source: string } | null;
      markerPath: string | null;
      diagnostics: { availability: string; complete: boolean; execution: { exitCode: number | null } };
    };
    expect(result.verdict).not.toBeNull();
    expect(result.verdict?.id).toBe('mcp-task-1');
    expect(result.verdict?.ready).toBe(true);
    expect(result.verdict?.blockers).toEqual([]);
    expect(result.verdict?.source).toBe('preflight');
    expect(result.markerPath).not.toBeNull();
    expect(result.diagnostics).toMatchObject({
      availability: 'available',
      complete: false,
      execution: { exitCode: 0 },
    });
  });

  it('not-ready preflight: verdict has ready:false and blockers from preflight output', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-notready.sh',
      '#!/bin/sh\necho \'{"ready":false,"confidence":0.4,"blockers":["test: 2 failing"]}\'\nexit 1\n',
    );
    const raw = await client.callTool({
      name: 'solution_evaluate',
      arguments: { id: 'mcp-task-notready', repoPath: repo },
    });
    const result = parseToolResult(raw) as {
      verdict: { ready: boolean; blockers: string[] } | null;
    };
    expect(result.verdict?.ready).toBe(false);
    expect(result.verdict?.blockers).toContain('test: 2 failing');
  });

  it('returns a complete exit-1 not-ready diagnostic', async () => {
    const payload = {
      ready: false, confidence: 0.4,
      checks: [{ name: 'test', kind: 'test', status: 'fail', durationMs: 2, confidenceContribution: 0 }],
      blockers: ['test: 2 failing'], warnings: [], limitations: [], durationMs: 2, timestamp: '2026-05-30T00:00:00.000Z',
    };
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-notready-complete-mcp.sh',
      `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(payload)}'\nexit 1\n`,
    );
    const raw = await client.callTool({ name: 'solution_evaluate', arguments: { id: 'mcp-notready-complete', repoPath: repo } });
    const result = parseToolResult(raw) as {
      verdict: { ready: boolean } | null;
      diagnostics: { availability: string; complete: boolean; execution: { exitCode: number | null } };
    };
    expect(result.verdict?.ready).toBe(false);
    expect(result.diagnostics).toMatchObject({ availability: 'available', complete: true, execution: { exitCode: 1 } });
  });

  it.each([
    ['malformed output', '#!/bin/sh\necho not-json\nexit 1\n', 'preflight ran but its output was not parseable JSON'],
    ['missing output', '#!/bin/sh\nexit 1\n', 'preflight invocation failed'],
  ])('returns unavailable diagnostics for %s', async (_name, body, error) => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(`stub-${_name.replace(/ /g, '-')}.sh`, body);
    const raw = await client.callTool({ name: 'solution_evaluate', arguments: { id: `mcp-${_name}`, repoPath: repo } });
    const result = parseToolResult(raw) as {
      verdict: null; error: string;
      diagnostics: { availability: string; complete: boolean; execution: { exitCode: number | null } };
    };
    expect(result.verdict).toBeNull();
    expect(result.error).toContain(error);
    expect(result.diagnostics).toMatchObject({ availability: 'unavailable', complete: false, execution: { exitCode: 1 } });
  });

  it('returns complete raw diagnostics, including acknowledged log paths and additive fields', async () => {
    const payload = {
      ready: true,
      confidence: 0.9,
      checks: [{
        name: 'test', kind: 'test', status: 'acknowledged',
        message: 'linux-only suite failed — acknowledged: CI covers it',
        details: ['full output: /tmp/preflight-test.log'], durationMs: 2, confidenceContribution: 0.1,
      }],
      blockers: [], warnings: [], limitations: ['test failure acknowledged: CI covers it'],
      durationMs: 2, timestamp: '2026-05-30T00:00:00.000Z', additive: { retained: true },
    };
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-complete-mcp.sh',
      `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(payload)}'\n`,
    );
    const raw = await client.callTool({ name: 'solution_evaluate', arguments: { id: 'mcp-complete', repoPath: repo } });
    const result = parseToolResult(raw) as { diagnostics: { availability: string; complete: boolean; payload: unknown } };
    expect(result.diagnostics).toMatchObject({ availability: 'available', complete: true, payload });
  });

  it('rejects an exit-2 ready payload through MCP and removes a previous same-id ready marker', async () => {
    const payload = {
      ready: true, confidence: 0.9,
      checks: [{ name: 'lint', kind: 'lint', status: 'pass', durationMs: 2, confidenceContribution: 0.1 }],
      blockers: [], warnings: [], limitations: [], durationMs: 2, timestamp: '2026-05-30T00:00:00.000Z',
    };
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-ready-before-exit2-mcp.sh',
      '#!/bin/sh\necho \'{"ready":true,"confidence":0.9,"blockers":[]}\'\n',
    );
    const initialRaw = await client.callTool({ name: 'solution_evaluate', arguments: { id: 'mcp-exit2', repoPath: repo } });
    expect((parseToolResult(initialRaw) as { verdict: { ready: boolean } | null }).verdict?.ready).toBe(true);
    const initialGateRaw = await client.callTool({ name: 'solution_gate', arguments: { id: 'mcp-exit2', repoPath: repo } });
    expect((parseToolResult(initialGateRaw) as { allowed: boolean }).allowed).toBe(true);
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-exit2-mcp.sh',
      `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(payload)}'\nexit 2\n`,
    );
    const raw = await client.callTool({ name: 'solution_evaluate', arguments: { id: 'mcp-exit2', repoPath: repo } });
    const result = parseToolResult(raw) as {
      verdict: null;
      markerPath: null;
      error: string;
      diagnostics: { availability: string; complete: boolean; execution: { exitCode: number | null }; issues: string[] };
    };
    expect(result.verdict).toBeNull();
    expect(result.markerPath).toBeNull();
    expect(result.error).toContain('invalid execution outcome');
    expect(result.diagnostics).toMatchObject({ availability: 'available', complete: false, execution: { exitCode: 2 } });
    expect(result.diagnostics.issues).toContain('preflight ready=true requires exit code 0, got 2');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
    const gateRaw = await client.callTool({ name: 'solution_gate', arguments: { id: 'mcp-exit2', repoPath: repo } });
    const gate = parseToolResult(gateRaw) as { allowed: boolean; currentHead: string };
    expect(gate.allowed).toBe(false);
    expect(gate.currentHead).toBe(head);
  });

  it.each([
    ['array payload', '[]'],
    ['missing blockers', '{"ready":true,"confidence":0.9}'],
    ['non-finite confidence', '{"ready":true,"confidence":1e400,"blockers":[]}'],
    ['ready with blockers', '{"ready":true,"confidence":0.9,"blockers":["contradiction"]}'],
  ])('rejects malformed verdict core through MCP: %s', async (_name, payload) => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub('stub-invalid-core-mcp.sh', `#!/bin/sh\necho '${payload}'\n`);
    const raw = await client.callTool({ name: 'solution_evaluate', arguments: { id: `mcp-core-${_name}`, repoPath: repo } });
    const result = parseToolResult(raw) as {
      verdict: null; markerPath: null; error: string;
      diagnostics: { availability: string; payload: unknown };
    };
    expect(result.verdict).toBeNull();
    expect(result.markerPath).toBeNull();
    expect(result.error).toContain('invalid verdict core');
    expect(result.diagnostics).toMatchObject({
      availability: 'available',
      payload: JSON.parse(JSON.stringify(JSON.parse(payload))),
    });
  });

  it('preserves the fresh technical payload when an OW blocker changes only the verdict', async () => {
    const payload = {
      ready: true, confidence: 0.9, blockers: [], additive: { preserved: true },
    };
    const run = join(repo, '.ai', 'runs', '2026-05-30-blocked');
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, '06-handoff.md'), '<!-- solution-acceptance: final-status = blocked -->\nblocked\n');
    writeFileSync(join(run, '05-review-findings.md'), '<!-- solution-acceptance: acceptance-recommendation = accept -->\naccept\n');
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-ow-blocked-mcp.sh',
      `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(payload)}'\n`,
    );
    const raw = await client.callTool({ name: 'solution_evaluate', arguments: { id: 'mcp-ow-blocked', repoPath: repo } });
    const result = parseToolResult(raw) as {
      verdict: { ready: boolean; blockers: string[] } | null;
      diagnostics: { payload: unknown; availability: string; complete: boolean };
    };
    expect(result.verdict?.ready).toBe(false);
    expect(result.verdict?.blockers.some((blocker) => blocker.startsWith('orchestrator-workflow:'))).toBe(true);
    expect(result.diagnostics).toMatchObject({ availability: 'available', complete: false, payload });
  });

  it('does not invoke preflight before id and HEAD validation, then invokes it once', async () => {
    const counter = join(tmpRoot, 'mcp-preflight-count');
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-counter-mcp.sh',
      `#!/bin/sh\nprintf x >> '${counter}'\necho '{"ready":true,"confidence":0.9,"blockers":[]}'\n`,
    );
    await client.callTool({ name: 'solution_evaluate', arguments: { id: '..', repoPath: repo } });
    expect(existsSync(counter)).toBe(false);
    await client.callTool({ name: 'solution_evaluate', arguments: { id: 'mcp-no-head', repoPath: tmpRoot } });
    expect(existsSync(counter)).toBe(false);
    await client.callTool({ name: 'solution_evaluate', arguments: { id: 'mcp-one-call', repoPath: repo } });
    expect(readFileSync(counter, 'utf8')).toBe('x');
  });

  it('preflight binary missing: returns structured {error, verdict:null} — not isError', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = join(tmpRoot, 'does-not-exist-preflight-mcp');
    const raw = await client.callTool({
      name: 'solution_evaluate',
      arguments: { id: 'mcp-task-missing-bin', repoPath: repo },
    });
    // evaluateSolution returns a structured error payload (does not throw),
    // so this must NOT be an MCP-level error (isError must be absent/false).
    expect((raw as ToolTextResponse).isError).toBeUndefined();
    const result = parseToolResult(raw) as {
      verdict: null;
      markerPath: null;
      error: string;
      diagnostics: { availability: string; complete: boolean; execution: { exitCode: number | null } };
    };
    expect(result.verdict).toBeNull();
    expect(result.markerPath).toBeNull();
    expect(result.error).toContain('preflight binary not found');
    expect(result.diagnostics).toMatchObject({
      availability: 'unavailable',
      complete: false,
      execution: { exitCode: null },
    });
  });

  it('schema rejects id="" (min(1) violated)', async () => {
    const raw = await client.callTool({
      name: 'solution_evaluate',
      arguments: { id: '', repoPath: repo },
    });
    expectValidationError(raw, 'solution_evaluate', 'id');
  });
});

// ── withProgressPings — unit ────────────────────────────────────────────────
//
// Direct tests against the helper solution_evaluate's handler wraps around
// (src/progress.ts), using a fake ToolExtra and vitest fake timers. This is
// where the "many heartbeat intervals, including a virtual >60s span" case
// from the task lives: driving a real preflight stub that long would be
// slow and flaky, but the helper itself has no dependency on what `work` is
// — a controlled, manually-resolved promise plus fake timers exercises the
// exact same timer/notification logic deterministically. The real
// client-server roundtrip tests further below cover the SDK's actual wire
// behavior (onprogress, resetTimeoutOnProgress) with short REAL intervals.
//
// This block (and the `resolveProgressIntervalMs` unit tests inside it)
// deliberately ignores the file-level `beforeEach`/`afterEach` above: it
// never touches `client`/`tmpRoot`/the MCP handshake those set up, since
// `makeFakeExtra` builds its own minimal `ToolExtra` and `resolveProgressIntervalMs`
// is a pure function. The outer hooks still run before/after each of these
// tests (cheap: tempdir + in-memory client/server), they are just unused
// here.

function makeFakeExtra(overrides: {
  progressToken?: string | number;
  signal?: AbortSignal;
  sendNotification?: (n: unknown) => Promise<void>;
} = {}): { extra: ToolExtra; sendNotification: ReturnType<typeof vi.fn> } {
  const sendNotification =
    (overrides.sendNotification as ReturnType<typeof vi.fn>) ?? vi.fn().mockResolvedValue(undefined);
  const extra = {
    signal: overrides.signal ?? new AbortController().signal,
    requestId: 1,
    sendNotification,
    sendRequest: vi.fn(),
    ...(overrides.progressToken !== undefined ? { _meta: { progressToken: overrides.progressToken } } : {}),
  } as unknown as ToolExtra;
  return { extra, sendNotification };
}

// A promise the test controls the resolution/rejection of, standing in for
// solution_evaluate's real (uninterruptible) preflight invocation.
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('withProgressPings — unit', () => {
  afterEach(() => {
    // Belt-and-braces: every test below either calls this itself or leaves
    // no pending fake timer, but a failed assertion mid-test could skip an
    // explicit vi.useRealTimers() call — never let fake timers leak into a
    // later test in this file.
    vi.useRealTimers();
  });

  it('sends notifications/progress with the echoed token and strictly monotonic progress across many ticks (virtual >60s span)', async () => {
    vi.useFakeTimers();
    const work = deferred<string>();
    const { extra, sendNotification } = makeFakeExtra({ progressToken: 'tok-123' });

    const resultPromise = withProgressPings(extra, () => work.promise, 1_000);

    // 65 ticks at 1s each = 65s of virtual time, comfortably past the 60s
    // mark named in the acceptance criteria.
    await vi.advanceTimersByTimeAsync(65_000);

    expect(sendNotification).toHaveBeenCalledTimes(65);
    const calls = sendNotification.mock.calls.map((c) => c[0] as {
      method: string;
      params: { progressToken: unknown; progress: number; message?: string; total?: number };
    });
    for (const call of calls) {
      expect(call.method).toBe('notifications/progress');
      expect(call.params.progressToken).toBe('tok-123');
      // Pinned payload shape: the default message, and never a `total` key
      // (this helper never claims a known end point — see the header's
      // "never a fabricated percentage" note).
      expect(call.params.message).toBe(DEFAULT_PROGRESS_MESSAGE);
      expect(call.params).not.toHaveProperty('total');
    }
    const progressValues = calls.map((c) => c.params.progress);
    expect(progressValues).toEqual([...Array(65)].map((_, i) => i + 1));

    work.resolve('final-result');
    await expect(resultPromise).resolves.toBe('final-result');

    // Timer is cleared once work settles: no leaked interval.
    expect(vi.getTimerCount()).toBe(0);

    // No further notifications after terminal completion, even if time
    // keeps moving.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sendNotification).toHaveBeenCalledTimes(65);

    vi.useRealTimers();
  });

  it('never starts a timer when the request carries no progressToken', async () => {
    vi.useFakeTimers();
    const work = deferred<string>();
    const { extra, sendNotification } = makeFakeExtra(); // no progressToken

    const resultPromise = withProgressPings(extra, () => work.promise, 10);
    // withProgressPings without a token is a plain passthrough to work(): no
    // interval is ever created, so there is nothing to advance past.
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    work.resolve('done-no-token');
    await expect(resultPromise).resolves.toBe('done-no-token');
    vi.useRealTimers();
  });

  it('stops the timer when work rejects, and propagates the same rejection', async () => {
    vi.useFakeTimers();
    const work = deferred<string>();
    const { extra, sendNotification } = makeFakeExtra({ progressToken: 'tok-reject' });

    const resultPromise = withProgressPings(extra, () => work.promise, 10);
    await vi.advanceTimersByTimeAsync(35);
    expect(sendNotification).toHaveBeenCalledTimes(3);

    const boom = new Error('preflight invocation blew up');
    work.reject(boom);
    await expect(resultPromise).rejects.toBe(boom);

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendNotification).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('a rejecting sendNotification does not change the outcome and never surfaces as an unhandled rejection', async () => {
    vi.useFakeTimers();
    const work = deferred<string>();
    const failingSend = vi.fn().mockRejectedValue(new Error('transport hiccup'));
    const { extra } = makeFakeExtra({ progressToken: 'tok-flaky', sendNotification: failingSend });

    const resultPromise = withProgressPings(extra, () => work.promise, 10);
    // Multiple ticks with a permanently-rejecting sendNotification: if the
    // rejection were not swallowed, this would surface as an unhandled
    // rejection and fail the test run.
    await vi.advanceTimersByTimeAsync(55);
    expect(failingSend).toHaveBeenCalledTimes(5);

    work.resolve('unaffected-by-notification-failures');
    await expect(resultPromise).resolves.toBe('unaffected-by-notification-failures');
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('stops pinging when extra.signal aborts, without touching the outcome of the still-pending work', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const work = deferred<string>();
    const { extra, sendNotification } = makeFakeExtra({ progressToken: 'tok-abort', signal: controller.signal });

    const resultPromise = withProgressPings(extra, () => work.promise, 10);
    await vi.advanceTimersByTimeAsync(25);
    expect(sendNotification).toHaveBeenCalledTimes(2);

    controller.abort();
    expect(vi.getTimerCount()).toBe(0);

    // Further virtual time produces no more pings — the timer is gone, not
    // just failing silently.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendNotification).toHaveBeenCalledTimes(2);

    // The underlying work is untouched by the abort: it settles on its own,
    // and withProgressPings still returns its result (no silent kill, no
    // retry, no second producer started here — solution-verdict.ts's single
    // preflight invocation is unaffected by this helper's own cancellation
    // handling).
    work.resolve('work-still-completes-after-abort');
    await expect(resultPromise).resolves.toBe('work-still-completes-after-abort');
    vi.useRealTimers();
  });

  it('passes a caller-supplied message through to every ping instead of the default', async () => {
    vi.useFakeTimers();
    const work = deferred<string>();
    const { extra, sendNotification } = makeFakeExtra({ progressToken: 'tok-msg' });

    const resultPromise = withProgressPings(extra, () => work.promise, 10, 'custom still-running message');
    await vi.advanceTimersByTimeAsync(25);
    expect(sendNotification).toHaveBeenCalledTimes(2);
    for (const call of sendNotification.mock.calls) {
      const params = (call[0] as { params: { message?: string } }).params;
      expect(params.message).toBe('custom still-running message');
    }

    work.resolve('done-custom-message');
    await expect(resultPromise).resolves.toBe('done-custom-message');
    vi.useRealTimers();
  });

  it('never starts a timer and removes no listener when extra.signal is already aborted before the call', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    const work = deferred<string>();
    const { extra, sendNotification } = makeFakeExtra({ progressToken: 'tok-pre-aborted', signal: controller.signal });
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    const addSpy = vi.spyOn(controller.signal, 'addEventListener');

    const resultPromise = withProgressPings(extra, () => work.promise, 10);
    // The mutation this guards against: registering the abort listener (and
    // starting the timer) unconditionally, without first checking whether
    // the signal is already aborted — an already-cancelled request would
    // then keep pinging until work settles.
    expect(vi.getTimerCount()).toBe(0);
    expect(addSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sendNotification).not.toHaveBeenCalled();

    work.resolve('done-pre-aborted');
    // work() itself is unaffected by the pre-aborted signal: it still runs
    // and its result is still returned.
    await expect(resultPromise).resolves.toBe('done-pre-aborted');
    // No listener was ever attached, so there is nothing to remove.
    expect(removeSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('removes the abort listener in finally when work settles normally (no listener leak)', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const work = deferred<string>();
    const { extra } = makeFakeExtra({ progressToken: 'tok-listener-leak', signal: controller.signal });
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    const resultPromise = withProgressPings(extra, () => work.promise, 10);
    await vi.advanceTimersByTimeAsync(15);

    work.resolve('done-listener-leak');
    await expect(resultPromise).resolves.toBe('done-listener-leak');
    // The mutation this guards against: dropping `clearInterval(timer)` (or
    // the listener removal) from the `finally` block — either would leave
    // this call unmade or the timer running after work settles.
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});

// ── resolveProgressIntervalMs — unit ────────────────────────────────────────
//
// Direct tests against server.ts's exported interval validator: any raw
// value that is not a positive finite number falls back to the default
// (0 and negative values would otherwise reach `setInterval` and flood the
// client with notifications; NaN/Infinity/non-number inputs are equally
// invalid). Pure function, so no fake timers or fake ToolExtra needed here.

describe('resolveProgressIntervalMs — unit', () => {
  it('passes through a valid positive finite number unchanged', () => {
    expect(resolveProgressIntervalMs(20)).toBe(20);
    expect(resolveProgressIntervalMs(10_000)).toBe(10_000);
  });

  it('falls back to the default for 0', () => {
    expect(resolveProgressIntervalMs(0)).toBe(DEFAULT_PROGRESS_INTERVAL_MS);
  });

  it('falls back to the default for a negative value', () => {
    expect(resolveProgressIntervalMs(-5)).toBe(DEFAULT_PROGRESS_INTERVAL_MS);
  });

  it('falls back to the default for non-finite or non-number input', () => {
    expect(resolveProgressIntervalMs(NaN)).toBe(DEFAULT_PROGRESS_INTERVAL_MS);
    expect(resolveProgressIntervalMs(Infinity)).toBe(DEFAULT_PROGRESS_INTERVAL_MS);
    expect(resolveProgressIntervalMs(undefined)).toBe(DEFAULT_PROGRESS_INTERVAL_MS);
    expect(resolveProgressIntervalMs('20')).toBe(DEFAULT_PROGRESS_INTERVAL_MS);
  });
});

// ── solution_evaluate — progress notifications (real MCP roundtrip) ─────────
//
// Unlike the rest of this file, these tests connect their OWN client/server
// pair (via createServer({ progressIntervalMs })) instead of the outer
// beforeEach's shared `client`, because the outer server is always built
// with createServer()'s default ~10s interval. They still rely on the outer
// beforeEach/afterEach for env isolation (GROUNDING_MCP_SESSIONS_DIR,
// EVIDENCE_LEDGER_DB, SOLUTION_VERDICT_DIR, HARNESS_HOME all point at this
// test's own tmpRoot already). Real short intervals (20ms) and a real stub
// preflight binary that sleeps a bounded, short real duration (200-300ms)
// — no fake timers here, this is testing the actual SDK wire behavior
// (onprogress, resetTimeoutOnProgress), which fake timers cannot stand in
// for.

describe('solution_evaluate — progress notifications (MCP roundtrip)', () => {
  let repo: string;
  let prevPreflightBin: string | undefined;
  let progClient: Client;
  let progClose: () => Promise<void>;

  function writeStub(name: string, body: string): string {
    const p = join(tmpRoot, name);
    writeFileSync(p, body, { mode: 0o755 });
    chmodSync(p, 0o755);
    return p;
  }

  beforeEach(async () => {
    prevPreflightBin = process.env.SOLUTION_PREFLIGHT_BIN;
    repo = mkdtempSync(join(tmpdir(), 'solution-repo-progress-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t.local'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
    writeFileSync(join(repo, 'readme.txt'), 'hello', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer({ progressIntervalMs: 20 });
    await server.connect(serverTransport);
    progClient = new Client({ name: 'progress-roundtrip-test', version: '0.0.0' });
    await progClient.connect(clientTransport);
    progClose = async () => {
      await progClient.close();
      await server.close();
    };
  });

  afterEach(async () => {
    await progClose();
    if (prevPreflightBin === undefined) delete process.env.SOLUTION_PREFLIGHT_BIN;
    else process.env.SOLUTION_PREFLIGHT_BIN = prevPreflightBin;
    rmSync(repo, { recursive: true, force: true });
  });

  it('a caller that attaches onprogress observes at least one real notifications/progress ping while solution_evaluate is running', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-progress-sleep.sh',
      '#!/bin/sh\nsleep 0.25\necho \'{"ready":true,"confidence":0.9,"blockers":[]}\'\n',
    );
    const progressUpdates: number[] = [];
    const raw = await progClient.callTool(
      { name: 'solution_evaluate', arguments: { id: 'progress-happy', repoPath: repo } },
      undefined,
      { onprogress: (p) => progressUpdates.push(p.progress) },
    );
    expect((raw as ToolTextResponse).isError).toBeFalsy();
    // The mutation this guards against: the heartbeat send never actually
    // firing (removed timer callback, or the callback never calling
    // sendNotification) — the client asked for progress, so at least one
    // ping must arrive over the real transport.
    expect(progressUpdates.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < progressUpdates.length; i++) {
      expect(progressUpdates[i]).toBeGreaterThan(progressUpdates[i - 1]);
    }
  });

  it('sends no notifications/progress at all when the caller attaches no onprogress/progressToken', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-progress-sleep-notoken.sh',
      '#!/bin/sh\nsleep 0.25\necho \'{"ready":true,"confidence":0.9,"blockers":[]}\'\n',
    );
    const rawNotifications: unknown[] = [];
    progClient.setNotificationHandler(ProgressNotificationSchema, (notification) => {
      rawNotifications.push(notification);
    });
    const raw = await progClient.callTool({
      name: 'solution_evaluate',
      arguments: { id: 'progress-notoken', repoPath: repo },
    });
    expect((raw as ToolTextResponse).isError).toBeFalsy();
    expect(rawNotifications).toEqual([]);
  });

  it('invokes preflight exactly once during a progress-enabled evaluation (no duplicate/detached producer)', async () => {
    const counter = join(tmpRoot, 'progress-preflight-count');
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-progress-counter.sh',
      `#!/bin/sh\nprintf x >> '${counter}'\nsleep 0.25\necho '{"ready":true,"confidence":0.9,"blockers":[]}'\n`,
    );
    await progClient.callTool(
      { name: 'solution_evaluate', arguments: { id: 'progress-count', repoPath: repo } },
      undefined,
      { onprogress: () => {} },
    );
    expect(readFileSync(counter, 'utf8')).toBe('x');
  });

  it('resetTimeoutOnProgress:true lets solution_evaluate outrun its own shortened per-request timeout', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-progress-long.sh',
      '#!/bin/sh\nsleep 0.3\necho \'{"ready":true,"confidence":0.9,"blockers":[]}\'\n',
    );
    const raw = await progClient.callTool(
      { name: 'solution_evaluate', arguments: { id: 'progress-reset', repoPath: repo } },
      undefined,
      { onprogress: () => {}, timeout: 80, resetTimeoutOnProgress: true },
    );
    expect((raw as ToolTextResponse).isError).toBeFalsy();
    const result = parseToolResult(raw) as { verdict: { ready: boolean } | null };
    expect(result.verdict?.ready).toBe(true);
  });

  it('without resetTimeoutOnProgress, the same shortened timeout fires an explicit McpError even though progress pings still arrive', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-progress-long-noreset.sh',
      '#!/bin/sh\nsleep 0.3\necho \'{"ready":true,"confidence":0.9,"blockers":[]}\'\n',
    );
    const progressUpdates: number[] = [];
    await expect(
      progClient.callTool(
        { name: 'solution_evaluate', arguments: { id: 'progress-noreset', repoPath: repo } },
        undefined,
        { onprogress: (p) => progressUpdates.push(p.progress), timeout: 80 },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.RequestTimeout });
    // The mutation this guards against: the heartbeat timer callback never
    // actually firing (or never calling sendNotification) even though the
    // request carries a progressToken — the client's timeout would then
    // fire "for free" regardless of whether pinging works at all. At least
    // one real ping must have arrived over the wire before the timeout, and
    // the ticks must still be strictly increasing.
    expect(progressUpdates.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < progressUpdates.length; i++) {
      expect(progressUpdates[i]).toBeGreaterThan(progressUpdates[i - 1]);
    }
  });
});

// ── solution_gate ─────────────────────────────────────────────────────────────

describe('solution_gate — MCP roundtrip', () => {
  it('deny path: no verdict recorded → allowed:false with reason containing "no verdict"', async () => {
    const raw = await client.callTool({
      name: 'solution_gate',
      arguments: { id: 'gate-task-no-verdict' },
    });
    const result = parseToolResult(raw) as {
      allowed: boolean;
      reason: string;
      verdict: null;
      currentHead: string | null;
    };
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('no verdict recorded');
    expect(result.verdict).toBeNull();
  });

  it('allow path: ready verdict at current HEAD → allowed:true', async () => {
    // Resolve the real HEAD of the agent-grounding repo so the verdict matches.
    const { execFileSync: sync } = await import('node:child_process');
    let head: string;
    try {
      head = sync('git', ['rev-parse', 'HEAD'], {
        cwd: '/home/lan/git/pandora/agent-grounding',
      })
        .toString()
        .trim();
    } catch {
      // Not a git context (e.g. CI with shallow clone or detached) — skip.
      return;
    }
    if (!/^[0-9a-f]{40}$/.test(head)) return;

    // Write a ready verdict at the resolved HEAD directly (mimics what
    // solution_evaluate produces; avoids needing a stub + repo in this test).
    writeVerdict({
      id: 'gate-task-ready',
      head,
      ready: true,
      confidence: 0.9,
      blockers: [],
      timestamp: new Date().toISOString(),
      source: 'preflight',
    });

    const raw = await client.callTool({
      name: 'solution_gate',
      arguments: {
        id: 'gate-task-ready',
        repoPath: '/home/lan/git/pandora/agent-grounding',
      },
    });
    const result = parseToolResult(raw) as { allowed: boolean; reason: string };
    expect(result.allowed).toBe(true);
    expect(result.reason).toContain('ready at HEAD');
  });

  it('schema rejects id="" (min(1) violated)', async () => {
    const raw = await client.callTool({
      name: 'solution_gate',
      arguments: { id: '' },
    });
    expectValidationError(raw, 'solution_gate', 'id');
  });

  it('stale verdict deny: verdict at old HEAD is rejected when HEAD has moved', async () => {
    const OLD_HEAD = 'a'.repeat(40);
    writeVerdict({
      id: 'gate-task-stale',
      head: OLD_HEAD,
      ready: true,
      confidence: 0.9,
      blockers: [],
      timestamp: new Date().toISOString(),
      source: 'preflight',
    });

    // We don't have control over the current HEAD in CWD, but we can pass
    // a non-git path so getHeadSha returns null. The evaluateGate logic
    // checks !ready first, then null head. Since verdict IS ready, the
    // null-HEAD branch will fire (reason: "cannot resolve current git HEAD").
    const raw = await client.callTool({
      name: 'solution_gate',
      arguments: { id: 'gate-task-stale', repoPath: tmpRoot },
    });
    const result = parseToolResult(raw) as { allowed: boolean; reason: string };
    expect(result.allowed).toBe(false);
    // Either HEAD resolution failed (null) or HEAD drifted. Either deny.
    expect(result.reason.length).toBeGreaterThan(0);
  });
});

// ── verify_memory_reference ───────────────────────────────────────────────────

describe('verify_memory_reference — MCP roundtrip', () => {
  it('happy path (kind:path, file exists): returns exists:true with foundIn entry', async () => {
    writeFileSync(join(tmpRoot, 'real-ref.md'), '# real\n', 'utf8');

    const raw = await client.callTool({
      name: 'verify_memory_reference',
      arguments: {
        kind: 'path',
        value: 'real-ref.md',
        repoRoot: tmpRoot,
      },
    });
    const result = parseToolResult(raw) as {
      exists: boolean;
      foundIn: string[];
      summary: string;
    };
    expect(result.exists).toBe(true);
    expect(result.foundIn).toHaveLength(1);
    expect(result.summary).toMatch(/exists/);
  });

  it('miss path (kind:path, file does not exist): returns exists:false, foundIn:[]', async () => {
    const raw = await client.callTool({
      name: 'verify_memory_reference',
      arguments: {
        kind: 'path',
        value: 'ghost-file.md',
        repoRoot: tmpRoot,
      },
    });
    const result = parseToolResult(raw) as { exists: boolean; foundIn: unknown[] };
    expect(result.exists).toBe(false);
    expect(result.foundIn).toEqual([]);
  });

  it('schema rejects an invalid kind enum value', async () => {
    const raw = await client.callTool({
      name: 'verify_memory_reference',
      arguments: { kind: 'directory', value: 'some/path' },
    });
    expectValidationError(raw, 'verify_memory_reference', 'kind');
  });

  it('schema rejects value="" (min(1) violated)', async () => {
    const raw = await client.callTool({
      name: 'verify_memory_reference',
      arguments: { kind: 'path', value: '' },
    });
    expectValidationError(raw, 'verify_memory_reference', 'value');
  });

  it('kind:symbol — returns a result shape (exists field present regardless of outcome)', async () => {
    const raw = await client.callTool({
      name: 'verify_memory_reference',
      arguments: {
        kind: 'symbol',
        value: 'createServer',
        repoRoot: join(tmpRoot, 'sessions'),
      },
    });
    expect((raw as ToolTextResponse).isError).toBeUndefined();
    const result = parseToolResult(raw) as { exists: boolean };
    expect(typeof result.exists).toBe('boolean');
  });
});

// ── solution_evaluate_status / solution_evaluate_result (MCP roundtrip) ─────
//
// Like the progress block above, this one connects its OWN client/server pair,
// via createServer({ attemptWaitBoundMs, attemptPollAfterMs }), because the
// outer server is built with createServer()'s production wait bound and a test
// must not sit through it. It still relies on the outer beforeEach/afterEach
// for env isolation (SOLUTION_VERDICT_DIR, which is also where the attempt log
// and the lock anchor live, plus HARNESS_HOME). The attempt-lifecycle rules
// themselves are covered in tests/solution-attempt-lifecycle.test.ts; what is
// asserted here is the wire surface: the two registrations exist, their
// schemas, and the shapes they return through a real transport.

describe('solution_evaluate_status / solution_evaluate_result (MCP roundtrip)', () => {
  let repo: string;
  let prevPreflightBin: string | undefined;
  let lifecycleClient: Client;
  let lifecycleClose: () => Promise<void>;

  function writeStub(name: string, body: string): string {
    const p = join(tmpRoot, name);
    writeFileSync(p, body, { mode: 0o755 });
    chmodSync(p, 0o755);
    return p;
  }

  beforeEach(async () => {
    prevPreflightBin = process.env.SOLUTION_PREFLIGHT_BIN;
    repo = mkdtempSync(join(tmpdir(), 'solution-repo-lifecycle-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 't@t.local'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: repo });
    writeFileSync(join(repo, 'readme.txt'), 'hello', 'utf8');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer({ attemptWaitBoundMs: 1_500, attemptPollAfterMs: 30 });
    await server.connect(serverTransport);
    lifecycleClient = new Client({ name: 'lifecycle-roundtrip-test', version: '0.0.0' });
    await lifecycleClient.connect(clientTransport);
    lifecycleClose = async () => {
      await lifecycleClient.close();
      await server.close();
    };
  });

  afterEach(async () => {
    await lifecycleClose();
    if (prevPreflightBin === undefined) delete process.env.SOLUTION_PREFLIGHT_BIN;
    else process.env.SOLUTION_PREFLIGHT_BIN = prevPreflightBin;
    rmSync(repo, { recursive: true, force: true });
  });

  it('lists both new tools alongside solution_evaluate and solution_gate', async () => {
    const listed = (await lifecycleClient.listTools()).tools.map((t) => t.name);
    expect(listed).toContain('solution_evaluate_status');
    expect(listed).toContain('solution_evaluate_result');
    expect(listed).toContain('solution_evaluate');
    expect(listed).toContain('solution_gate');
  });

  it('a completed attempt inside the bound carries status and attemptId, and both lookups resolve it by id alone', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-lifecycle-ready.sh',
      '#!/bin/sh\necho \'{"ready":true,"confidence":0.9,"blockers":[]}\'\n',
    );
    const evaluated = parseToolResult(
      await lifecycleClient.callTool({
        name: 'solution_evaluate',
        arguments: { id: 'mcp-lifecycle-ok', repoPath: repo },
      }),
    ) as { status: string; attemptId: string; verdict: { ready: boolean } | null };
    expect(evaluated.status).toBe('completed');
    expect(typeof evaluated.attemptId).toBe('string');
    expect(evaluated.verdict?.ready).toBe(true);

    const status = parseToolResult(
      await lifecycleClient.callTool({
        name: 'solution_evaluate_status',
        arguments: { id: 'mcp-lifecycle-ok' },
      }),
    ) as { status: string; attemptId: string; isLatestForId: boolean };
    expect(status.status).toBe('completed');
    expect(status.attemptId).toBe(evaluated.attemptId);
    expect(status.isLatestForId).toBe(true);

    const result = parseToolResult(
      await lifecycleClient.callTool({
        name: 'solution_evaluate_result',
        arguments: { id: 'mcp-lifecycle-ok', attemptId: evaluated.attemptId },
      }),
    ) as { status: string; markerPresent: boolean; verdict: { ready: boolean } | null };
    expect(result.status).toBe('completed');
    expect(result.markerPresent).toBe(true);
    expect(result.verdict?.ready).toBe(true);
  }, 20_000);

  it('returns a running handle once the bound elapses, and the result lands on a later lookup', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-lifecycle-slow.sh',
      '#!/bin/sh\nsleep 3\necho \'{"ready":true,"confidence":0.9,"blockers":[]}\'\n',
    );
    const running = parseToolResult(
      await lifecycleClient.callTool({
        name: 'solution_evaluate',
        arguments: { id: 'mcp-lifecycle-slow', repoPath: repo },
      }),
    ) as { status: string; attemptId: string; id: string; pollAfterMs: number };
    expect(running.status).toBe('running');
    expect(running.id).toBe('mcp-lifecycle-slow');
    expect(running.pollAfterMs).toBe(30);

    const deadline = Date.now() + 15_000;
    let result: { status: string; attemptId: string };
    for (;;) {
      result = parseToolResult(
        await lifecycleClient.callTool({
          name: 'solution_evaluate_result',
          arguments: { id: 'mcp-lifecycle-slow', attemptId: running.attemptId },
        }),
      ) as { status: string; attemptId: string };
      if (result.status !== 'running') break;
      if (Date.now() > deadline) throw new Error('attempt never reached a terminal state');
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(result.status).toBe('completed');
    expect(result.attemptId).toBe(running.attemptId);
  }, 30_000);

  it('resolves an id that was never evaluated to unknown without starting anything', async () => {
    const counter = join(tmpRoot, 'lifecycle-never-count');
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-lifecycle-never.sh',
      `#!/bin/sh\nprintf x >> '${counter}'\necho '{"ready":true,"confidence":0.9,"blockers":[]}'\n`,
    );
    const status = parseToolResult(
      await lifecycleClient.callTool({
        name: 'solution_evaluate_status',
        arguments: { id: 'mcp-lifecycle-never' },
      }),
    ) as { status: string };
    expect(status.status).toBe('unknown');
    expect(existsSync(counter)).toBe(false);
  });

  it('answers an unusable but schema-valid id with a clean unknown payload rather than an isError envelope', async () => {
    // solution_evaluate already answers an unusable id with an ordinary
    // {status:"failed", error} payload; these two lookups match that posture
    // instead of surfacing the sanitizer's throw as an MCP error envelope.
    for (const tool of ['solution_evaluate_status', 'solution_evaluate_result']) {
      const raw = (await lifecycleClient.callTool({ name: tool, arguments: { id: '..' } })) as {
        isError?: boolean;
      };
      expect(raw.isError).toBeFalsy();
      const payload = parseToolResult(raw) as { status: string; id: string; error: string };
      expect(payload.status).toBe('unknown');
      expect(payload.id).toBe('..');
      expect(payload.error).toContain('invalid verdict id');
    }
  });

  it('bounds id at MAX_LOOKUP_ID_LENGTH on all three tools (solution_evaluate included): the bound passes and round-trips, one over it is a schema rejection on every one', async () => {
    process.env.SOLUTION_PREFLIGHT_BIN = writeStub(
      'stub-lifecycle-band.sh',
      '#!/bin/sh\necho \'{"ready":true,"confidence":0.9,"blockers":[]}\'\n',
    );
    const atBound = 'i'.repeat(MAX_LOOKUP_ID_LENGTH);
    const overBound = 'i'.repeat(MAX_LOOKUP_ID_LENGTH + 1);

    // solution_evaluate: the bound passes and actually runs the attempt (this
    // is the id the two lookups below then round-trip); one over it is a
    // schema rejection, so the over-long id never reaches the registry.
    const evaluated = parseToolResult(
      await lifecycleClient.callTool({
        name: 'solution_evaluate',
        arguments: { id: atBound, repoPath: repo },
      }),
    ) as { status: string };
    expect(evaluated.status).toBe('completed');
    expectValidationError(
      await lifecycleClient.callTool({
        name: 'solution_evaluate',
        arguments: { id: overBound, repoPath: repo },
      }),
      'solution_evaluate',
      'id',
    );

    for (const tool of ['solution_evaluate_status', 'solution_evaluate_result']) {
      // The SAME atBound id, now round-tripped through the lookup that just
      // ran it above: proof the bound is one shared number across all three
      // tools, not merely three independent schema limits.
      const accepted = parseToolResult(
        await lifecycleClient.callTool({ name: tool, arguments: { id: atBound } }),
      ) as { status: string };
      expect(accepted.status).toBe('completed');

      // One character over: rejected by the schema, so the handler never runs
      // and no ENAMETOOLONG from the filesystem can reach the caller.
      expectValidationError(
        await lifecycleClient.callTool({ name: tool, arguments: { id: overBound } }),
        tool,
        'id',
      );
    }
  }, 20_000);

  it('schema rejects id="" and attemptId="" on both lookups', async () => {
    expectValidationError(
      await lifecycleClient.callTool({ name: 'solution_evaluate_status', arguments: { id: '' } }),
      'solution_evaluate_status',
      'id',
    );
    expectValidationError(
      await lifecycleClient.callTool({ name: 'solution_evaluate_result', arguments: { id: 'x', attemptId: '' } }),
      'solution_evaluate_result',
      'attemptId',
    );
  });
});
