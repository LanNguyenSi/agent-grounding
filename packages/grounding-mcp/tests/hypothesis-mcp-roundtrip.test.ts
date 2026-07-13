// End-to-end exercise of the `hypothesis_*` MCP verbs through a real
// MCP client and an in-memory transport pair. Unlike `hypothesis.test.ts`
// (which calls the hypothesis-tracker library + in-process store directly),
// this test goes through the registered MCP tool surface and therefore
// covers the wrapper-only branches that live in `server.ts`:
//
//   - hypothesis_evidence       → `no_store_for_session`
//   - hypothesis_reject         → `hypothesis_not_found`
//   - hypothesis_check_done     → `check_index_out_of_range`
//   - hypothesis_support        → `hypothesis_not_found_or_rejected`
//
// It also exercises the zod schema bounds end-to-end (sessionId `.min(1)`,
// text `.max(4096)`) — those bounds only matter once a client speaks to
// the server through the SDK validator, so a library-level test would not
// catch a drifted schema.
//
// Pattern note: this is the first in-process MCP-client roundtrip test in
// the repo. New verbs that introduce wrapper-only error branches should
// follow the same shape — `createServer()` + InMemoryTransport pair +
// Client + isolated env vars per `beforeEach`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../src/server.js';
import { resetStores } from '../src/hypothesis-store.js';
import { resetLedgerDb } from '../src/ledger-bridge.js';

interface ToolTextResponse {
  content: { type: string; text: string }[];
  isError?: boolean;
}

// Parse the JSON-text response shape used by every tool handler in
// `jsonResponse(...)`. Treats anything else as a hard test failure so
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

let tmpRoot: string;
let prevSessionsDir: string | undefined;
let prevLedgerDb: string | undefined;
let prevHypothesesDir: string | undefined;
let client: Client;
let close: () => Promise<void>;

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'grounding-mcp-hypothesis-'));
  prevSessionsDir = process.env.GROUNDING_MCP_SESSIONS_DIR;
  prevLedgerDb = process.env.EVIDENCE_LEDGER_DB;
  prevHypothesesDir = process.env.GROUNDING_MCP_HYPOTHESES_DIR;
  process.env.GROUNDING_MCP_SESSIONS_DIR = join(tmpRoot, 'sessions');
  process.env.EVIDENCE_LEDGER_DB = join(tmpRoot, 'ledger.db');
  process.env.GROUNDING_MCP_HYPOTHESES_DIR = join(tmpRoot, 'hypotheses');
  resetLedgerDb();
  resetStores();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverTransport);

  client = new Client({ name: 'hypothesis-roundtrip-test', version: '0.0.0' });
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
  if (prevHypothesesDir === undefined) delete process.env.GROUNDING_MCP_HYPOTHESES_DIR;
  else process.env.GROUNDING_MCP_HYPOTHESES_DIR = prevHypothesesDir;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('hypothesis_* MCP roundtrip — wrapper error branches', () => {
  it('hypothesis_evidence on an unknown sessionId returns { error: "no_store_for_session" }', async () => {
    const raw = await client.callTool({
      name: 'hypothesis_evidence',
      arguments: {
        sessionId: 'gs-never-recorded',
        hypothesisId: 'h-bogus',
        evidence: 'unused',
      },
    });
    expect(parseToolResult(raw)).toEqual({
      error: 'no_store_for_session',
      sessionId: 'gs-never-recorded',
    });
  });

  it('hypothesis_reject on an unknown hypothesisId returns { error: "hypothesis_not_found" }', async () => {
    // First record a real hypothesis so the per-session store exists,
    // then attack a sibling-id that was never recorded. This separates
    // the `hypothesis_not_found` branch from `no_store_for_session`.
    const recorded = parseToolResult(
      await client.callTool({
        name: 'hypothesis_record',
        arguments: { sessionId: 'gs-reject-1', text: 'placeholder', requiredChecks: [] },
      }),
    ) as { hypothesis: { id: string } };
    expect(recorded.hypothesis.id).toMatch(/.+/);

    const raw = await client.callTool({
      name: 'hypothesis_reject',
      arguments: {
        sessionId: 'gs-reject-1',
        hypothesisId: 'h-never-recorded',
        reason: 'whatever',
      },
    });
    expect(parseToolResult(raw)).toEqual({
      error: 'hypothesis_not_found',
      sessionId: 'gs-reject-1',
      hypothesisId: 'h-never-recorded',
    });
  });

  it('hypothesis_check_done with out-of-range checkIndex returns { error: "check_index_out_of_range" }', async () => {
    const recorded = parseToolResult(
      await client.callTool({
        name: 'hypothesis_record',
        arguments: {
          sessionId: 'gs-range-1',
          text: 'one check only',
          requiredChecks: ['the only check'],
        },
      }),
    ) as { hypothesis: { id: string; required_checks: unknown[] } };
    expect(recorded.hypothesis.required_checks).toHaveLength(1);

    const raw = await client.callTool({
      name: 'hypothesis_check_done',
      arguments: {
        sessionId: 'gs-range-1',
        hypothesisId: recorded.hypothesis.id,
        checkIndex: 5,
      },
    });
    expect(parseToolResult(raw)).toEqual({
      error: 'check_index_out_of_range',
      sessionId: 'gs-range-1',
      hypothesisId: recorded.hypothesis.id,
      checkIndex: 5,
      availableChecks: 1,
    });
  });

  it('hypothesis_support after rejection returns { error: "hypothesis_not_found_rejected_or_checks_pending" }', async () => {
    const recorded = parseToolResult(
      await client.callTool({
        name: 'hypothesis_record',
        arguments: { sessionId: 'gs-support-1', text: 'route is down', requiredChecks: [] },
      }),
    ) as { hypothesis: { id: string } };

    const rejected = parseToolResult(
      await client.callTool({
        name: 'hypothesis_reject',
        arguments: {
          sessionId: 'gs-support-1',
          hypothesisId: recorded.hypothesis.id,
          reason: 'route table is fine',
        },
      }),
    ) as { hypothesis: { status: string } };
    expect(rejected.hypothesis.status).toBe('rejected');

    const raw = await client.callTool({
      name: 'hypothesis_support',
      arguments: {
        sessionId: 'gs-support-1',
        hypothesisId: recorded.hypothesis.id,
      },
    });
    expect(parseToolResult(raw)).toEqual({
      error: 'hypothesis_not_found_rejected_or_checks_pending',
      sessionId: 'gs-support-1',
      hypothesisId: recorded.hypothesis.id,
    });
  });
});

describe('hypothesis_* MCP roundtrip — schema validation', () => {
  // The MCP SDK surfaces input-validation failures as a tool-result envelope
  // with `isError: true` and a `text` content block carrying the formatted
  // zod error. The client does NOT throw — callers see a structured error
  // result. Tests assert both the envelope flag and a substring of the
  // formatted message so a schema rename surfaces here.

  // Robust to SDK/zod formatter changes: rather than matching the
  // pretty-printed JSON substring, we extract the formatter's JSON array
  // from the message and assert against the parsed path. That way an SDK
  // bump that switches indentation, swaps `JSON.stringify(..., 2)` for
  // `flatten()`, or wraps the payload differently does not flake the test
  // as long as the structured `path` is still present.
  function expectValidationError(
    raw: unknown,
    toolName: string,
    field: string,
  ): void {
    const result = raw as ToolTextResponse;
    expect(result.isError).toBe(true);
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain(`Invalid arguments for tool ${toolName}`);

    const jsonStart = text.indexOf('[');
    expect(jsonStart).toBeGreaterThan(-1);
    const errors = JSON.parse(text.slice(jsonStart)) as { path: (string | number)[] }[];
    expect(Array.isArray(errors)).toBe(true);
    expect(errors.some((e) => e.path.includes(field))).toBe(true);
  }

  it('rejects sessionId = "" with an MCP InvalidParams envelope', async () => {
    const raw = await client.callTool({
      name: 'hypothesis_record',
      arguments: { sessionId: '', text: 'whatever', requiredChecks: [] },
    });
    expectValidationError(raw, 'hypothesis_record', 'sessionId');
  });

  // Before hypothesisSessionIdSchema grew a charset regex + refine, '.' and
  // '..' passed this schema (min(1)/max(256) don't exclude them) and only
  // failed later inside the handler, when hypothesis-store.ts's
  // sanitizeHypothesisSessionId threw on the reserved path segment — an
  // uncaught throw that surfaced as an ad-hoc isError envelope, not the
  // same well-formed "Invalid arguments for tool X" envelope every other
  // malformed sessionId gets. These three pin that '.', '..', and
  // out-of-charset ids now all fail at the schema boundary instead, before
  // any handler code (and therefore any sanitize/disk call) runs.

  it('rejects sessionId = "." with an MCP InvalidParams envelope', async () => {
    const raw = await client.callTool({
      name: 'hypothesis_record',
      arguments: { sessionId: '.', text: 'whatever', requiredChecks: [] },
    });
    expectValidationError(raw, 'hypothesis_record', 'sessionId');
  });

  it('rejects sessionId = ".." with an MCP InvalidParams envelope', async () => {
    const raw = await client.callTool({
      name: 'hypothesis_record',
      arguments: { sessionId: '..', text: 'whatever', requiredChecks: [] },
    });
    expectValidationError(raw, 'hypothesis_record', 'sessionId');
  });

  it('rejects a sessionId containing a path separator with an MCP InvalidParams envelope', async () => {
    const raw = await client.callTool({
      name: 'hypothesis_record',
      arguments: { sessionId: 'a/b', text: 'whatever', requiredChecks: [] },
    });
    expectValidationError(raw, 'hypothesis_record', 'sessionId');
  });

  it('rejects text longer than 4096 chars with an MCP InvalidParams envelope', async () => {
    const tooLong = 'x'.repeat(4097);
    const raw = await client.callTool({
      name: 'hypothesis_record',
      arguments: { sessionId: 'gs-len-1', text: tooLong, requiredChecks: [] },
    });
    expectValidationError(raw, 'hypothesis_record', 'text');
  });

  it('rejects evidence longer than 4096 chars with an MCP InvalidParams envelope', async () => {
    // Record a real hypothesis first so the call would otherwise succeed —
    // this asserts the schema rejects BEFORE the wrapper sees a valid store.
    const recorded = parseToolResult(
      await client.callTool({
        name: 'hypothesis_record',
        arguments: { sessionId: 'gs-evid-len', text: 'h', requiredChecks: [] },
      }),
    ) as { hypothesis: { id: string } };

    const tooLong = 'e'.repeat(4097);
    const raw = await client.callTool({
      name: 'hypothesis_evidence',
      arguments: {
        sessionId: 'gs-evid-len',
        hypothesisId: recorded.hypothesis.id,
        evidence: tooLong,
      },
    });
    expectValidationError(raw, 'hypothesis_evidence', 'evidence');
  });
});

describe('hypothesis_reset MCP roundtrip', () => {
  it('records a hypothesis, resets the session, and hypothesis_list shows zero hypotheses', async () => {
    const sessionId = 'gs-reset-1';

    // Record a hypothesis so the store exists.
    await client.callTool({
      name: 'hypothesis_record',
      arguments: { sessionId, text: 'DNS resolution is failing', requiredChecks: [] },
    });

    // Verify hypothesis_list sees it.
    const beforeReset = parseToolResult(
      await client.callTool({ name: 'hypothesis_list', arguments: { sessionId } }),
    ) as { summary: { total: number } };
    expect(beforeReset.summary.total).toBe(1);

    // Call hypothesis_reset and assert cleared: true.
    const resetResult = parseToolResult(
      await client.callTool({ name: 'hypothesis_reset', arguments: { sessionId } }),
    ) as { sessionId: string; cleared: boolean };
    expect(resetResult).toEqual({ sessionId, cleared: true });

    // hypothesis_list after reset shows zero hypotheses (empty-fixture path).
    const afterReset = parseToolResult(
      await client.callTool({ name: 'hypothesis_list', arguments: { sessionId } }),
    ) as { summary: { total: number }; hypotheses: unknown[] };
    expect(afterReset.summary.total).toBe(0);
    expect(afterReset.hypotheses).toEqual([]);
  });

  it('hypothesis_reset of a never-seen session returns { cleared: false }', async () => {
    const raw = await client.callTool({
      name: 'hypothesis_reset',
      arguments: { sessionId: 'gs-never-seen' },
    });
    const result = parseToolResult(raw) as { sessionId: string; cleared: boolean };
    expect(result).toEqual({ sessionId: 'gs-never-seen', cleared: false });
  });
});

describe('hypothesis_* MCP roundtrip — happy path through every verb', () => {
  it('record → list → evidence (auto-support) → check_done → reject covers the wrapper happy paths', async () => {
    const sessionId = 'gs-happy';

    // Record one hypothesis with one check.
    const recorded = parseToolResult(
      await client.callTool({
        name: 'hypothesis_record',
        arguments: {
          sessionId,
          text: 'DNS resolution is failing',
          requiredChecks: ['Run dig example.com'],
        },
      }),
    ) as { hypothesis: { id: string; status: string; required_checks: { done: boolean }[] } };
    expect(recorded.hypothesis.status).toBe('unverified');
    expect(recorded.hypothesis.required_checks).toHaveLength(1);

    // List sees the new hypothesis and reports pending_checks=1.
    const listed = parseToolResult(
      await client.callTool({ name: 'hypothesis_list', arguments: { sessionId } }),
    ) as { summary: { total: number; unverified: number; pending_checks: number } };
    expect(listed.summary).toEqual(
      expect.objectContaining({ total: 1, unverified: 1, pending_checks: 1 }),
    );

    // Attaching evidence auto-promotes unverified → supported.
    const withEvidence = parseToolResult(
      await client.callTool({
        name: 'hypothesis_evidence',
        arguments: {
          sessionId,
          hypothesisId: recorded.hypothesis.id,
          evidence: 'dig returns SERVFAIL',
          source: 'dig example.com',
        },
      }),
    ) as { hypothesis: { status: string; evidence: { source?: string }[] } };
    expect(withEvidence.hypothesis.status).toBe('supported');
    expect(withEvidence.hypothesis.evidence[0]?.source).toBe('dig example.com');

    // Completing the check drains pending_checks.
    const checked = parseToolResult(
      await client.callTool({
        name: 'hypothesis_check_done',
        arguments: {
          sessionId,
          hypothesisId: recorded.hypothesis.id,
          checkIndex: 0,
        },
      }),
    ) as { hypothesis: { required_checks: { done: boolean }[] } };
    expect(checked.hypothesis.required_checks[0]?.done).toBe(true);

    // Rejecting still works after support — kept in store with a
    // `[rejected]` evidence entry (audit, not delete).
    const rejected = parseToolResult(
      await client.callTool({
        name: 'hypothesis_reject',
        arguments: {
          sessionId,
          hypothesisId: recorded.hypothesis.id,
          reason: 'turned out to be a stale resolver',
        },
      }),
    ) as { hypothesis: { status: string; evidence: { text: string }[] } };
    expect(rejected.hypothesis.status).toBe('rejected');
    expect(rejected.hypothesis.evidence.at(-1)?.text).toMatch(/\[rejected\]/);
  });

  it('hypothesis_list on a session with no recorded hypotheses returns the empty fixture', async () => {
    // Exercises the `if (!store)` early-return branch in the list handler:
    // a list-before-record must not allocate an empty store and must hand
    // back the zero-counts summary verbatim.
    const listed = parseToolResult(
      await client.callTool({
        name: 'hypothesis_list',
        arguments: { sessionId: 'gs-empty' },
      }),
    ) as { sessionId: string; summary: Record<string, number>; hypotheses: unknown[] };
    expect(listed.sessionId).toBe('gs-empty');
    expect(listed.summary).toEqual({
      total: 0,
      unverified: 0,
      supported: 0,
      rejected: 0,
      pending_checks: 0,
    });
    expect(listed.hypotheses).toEqual([]);
  });
});

describe('hypothesis_* MCP roundtrip — survives a simulated grounding-mcp restart', () => {
  // `resetStores()` drops the in-process Map without touching disk — the
  // same starting state a fresh grounding-mcp process has after Claude
  // Code restarts it. Every hypothesis_* verb that mutates a store saves
  // it to GROUNDING_MCP_HYPOTHESES_DIR (see hypothesis-store.ts); these
  // tests pin that the data is actually there afterwards, not just that
  // saveStore was called.

  it('hypothesis_list returns a previously-recorded hypothesis after the in-process cache is cleared', async () => {
    const sessionId = 'gs-restart-list';
    const recorded = parseToolResult(
      await client.callTool({
        name: 'hypothesis_record',
        arguments: {
          sessionId,
          text: 'DNS resolution is failing',
          requiredChecks: ['Run dig'],
        },
      }),
    ) as { hypothesis: { id: string } };

    resetStores(); // simulated restart

    const afterRestart = parseToolResult(
      await client.callTool({ name: 'hypothesis_list', arguments: { sessionId } }),
    ) as { summary: { total: number }; hypotheses: { id: string; text: string }[] };
    expect(afterRestart.summary.total).toBe(1);
    expect(afterRestart.hypotheses[0]?.id).toBe(recorded.hypothesis.id);
    expect(afterRestart.hypotheses[0]?.text).toBe('DNS resolution is failing');
  });

  it('a mutation made after one restart is still visible after a second restart', async () => {
    const sessionId = 'gs-restart-evidence';
    const recorded = parseToolResult(
      await client.callTool({
        name: 'hypothesis_record',
        arguments: { sessionId, text: 'firewall blocks 443', requiredChecks: [] },
      }),
    ) as { hypothesis: { id: string } };

    resetStores(); // restart #1 — hypothesis_evidence below must hydrate first

    await client.callTool({
      name: 'hypothesis_evidence',
      arguments: {
        sessionId,
        hypothesisId: recorded.hypothesis.id,
        evidence: 'iptables shows DROP on 443',
        source: 'iptables -L',
      },
    });

    resetStores(); // restart #2 — the evidence write above must have persisted

    const listed = parseToolResult(
      await client.callTool({ name: 'hypothesis_list', arguments: { sessionId } }),
    ) as { summary: { total: number; supported: number }; hypotheses: { status: string; evidence: unknown[] }[] };
    expect(listed.summary).toEqual(expect.objectContaining({ total: 1, supported: 1 }));
    expect(listed.hypotheses[0]?.status).toBe('supported');
    expect(listed.hypotheses[0]?.evidence).toHaveLength(1);
  });

  it('hypothesis_support success path persists the supported status across a restart', async () => {
    const sessionId = 'gs-restart-support';
    const recorded = parseToolResult(
      await client.callTool({
        name: 'hypothesis_record',
        arguments: {
          sessionId,
          text: 'race condition on startup',
          requiredChecks: ['inspect logs'],
        },
      }),
    ) as { hypothesis: { id: string } };

    await client.callTool({
      name: 'hypothesis_check_done',
      arguments: { sessionId, hypothesisId: recorded.hypothesis.id, checkIndex: 0 },
    });
    const supported = parseToolResult(
      await client.callTool({
        name: 'hypothesis_support',
        arguments: { sessionId, hypothesisId: recorded.hypothesis.id },
      }),
    ) as { hypothesis: { status: string } };
    expect(supported.hypothesis.status).toBe('supported');

    resetStores(); // simulated restart

    const listed = parseToolResult(
      await client.callTool({ name: 'hypothesis_list', arguments: { sessionId } }),
    ) as { hypotheses: { status: string }[] };
    expect(listed.hypotheses[0]?.status).toBe('supported');
  });

  it('hypothesis_reset purges the on-disk file so a later restart does not resurrect the session', async () => {
    const sessionId = 'gs-restart-reset';
    await client.callTool({
      name: 'hypothesis_record',
      arguments: { sessionId, text: 'stale route entry', requiredChecks: [] },
    });

    const resetResult = parseToolResult(
      await client.callTool({ name: 'hypothesis_reset', arguments: { sessionId } }),
    ) as { cleared: boolean };
    expect(resetResult.cleared).toBe(true);

    resetStores(); // simulated restart after the reset

    const listed = parseToolResult(
      await client.callTool({ name: 'hypothesis_list', arguments: { sessionId } }),
    ) as { summary: { total: number } };
    expect(listed.summary.total).toBe(0);
  });
});
