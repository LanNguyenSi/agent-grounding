#!/usr/bin/env node
// MCP server exposing the agent-grounding stack to long-running Claude Code
// sessions. See README.md for the full tool catalog and the Claude Code
// settings.json registration block.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isJSONRPCRequest, type JSONRPCMessage, type JSONRPCRequest, type MessageExtraInfo, type RequestId } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';

import {
  initSession,
  advancePhase,
  isGuardrailActive,
  type GroundingSession,
  type GuardrailId,
} from '@lannguyensi/grounding-wrapper';
import { addEntry, getSummary, type EntryType, type ConfidenceLevel } from '@lannguyensi/evidence-ledger';
import {
  evaluateClaim,
  type ClaimContext,
  type ClaimType,
} from '@lannguyensi/claim-gate';
import {
  verifyMemoryReference,
  type MemoryReference,
} from '@lannguyensi/runtime-reality-checker';
import {
  addHypothesis,
  addEvidence,
  completeCheck,
  rejectHypothesis,
  supportHypothesis,
  getSummary as getHypothesisSummary,
  findHypothesis,
} from '@lannguyensi/hypothesis-tracker';

import { saveSession, loadSession } from './session-store.js';
import { ledgerDb, ledgerStatus } from './ledger-bridge.js';
import { deriveContext } from './derive-context.js';
import { getOrCreateStore, getStore, resetStore, saveStore } from './hypothesis-store.js';
import { evaluateGate, getHeadSha } from './solution-verdict.js';
import { withProgressPings, DEFAULT_PROGRESS_INTERVAL_MS, DEFAULT_PROGRESS_MESSAGE } from './progress.js';
import {
  SolutionAttemptRegistry,
  reconcileOrphanedAttempts,
  MAX_ID_FILENAME_LENGTH,
} from './solution-attempt-log.js';

// Single source of truth for the version string emitted by both the
// MCP `name+version` handshake and the `--version` CLI short-circuit is
// package.json itself, read at runtime so a release bump never needs a
// matching edit here. Resolved relative to this module so it works both
// from src/ (dev, via tsx) and from the built dist/ layout (dist/server.js
// sits one level below the package root, same as src/server.ts). npm always
// includes package.json in the published tarball, independent of `files`.
// packageJsonUrl and read are injectable so tests can drive the failure
// path (missing file, invalid JSON, missing version field) without
// spawning a dist/ subprocess or mutating the real package.json.
// The diagnostic write is best-effort: it runs in its own try/catch so a
// throwing process.stderr.write (closed or bad fd, EBADF) can never escape
// this function. This module's `main` is dist/server.js, not this export;
// readPackageVersion is exported only as a test seam, not supported API.
// @internal
export function readPackageVersion(
  packageJsonUrl: URL = new URL('../package.json', import.meta.url),
  read: (url: URL, encoding: BufferEncoding) => string = readFileSync,
): string {
  try {
    const text = read(packageJsonUrl, 'utf8');
    const pkg = JSON.parse(text) as { version?: string };
    if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
      try {
        process.stderr.write(
          'grounding-mcp: package.json has no "version" field; reporting 0.0.0\n',
        );
      } catch {
        // stderr itself is unwritable; the 0.0.0 fallback below still
        // applies, this diagnostic is best-effort only.
      }
      return '0.0.0';
    }
    return pkg.version;
  } catch (err) {
    try {
      const reason = (err instanceof Error ? err.message : String(err))
        .replace(/\r?\n/g, ' ')
        .slice(0, 500);
      process.stderr.write(
        `grounding-mcp: could not read version from package.json (${reason}); reporting 0.0.0\n`,
      );
    } catch {
      // stderr itself is unwritable, or the error's message/toString threw;
      // nothing more can be reported.
    }
    return '0.0.0';
  }
}

const PACKAGE_VERSION = readPackageVersion();

// Wrap a JSON payload as an MCP text-content response. The MCP SDK requires
// content blocks; serializing the structured result as text keeps the agent
// able to parse it without losing field names.
function jsonResponse(payload: unknown): {
  content: { type: 'text'; text: string }[];
} {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function summarizeSession(s: GroundingSession): {
  sessionId: string;
  keyword: string;
  problem: string;
  currentPhase: string;
  mandatorySequence: string[];
  activeGuardrails: GuardrailId[];
  phaseStatus: GroundingSession['phase_status'];
} {
  return {
    sessionId: s.id,
    keyword: s.keyword,
    problem: s.problem,
    currentPhase: s.current_phase,
    mandatorySequence: s.mandatory_sequence,
    activeGuardrails: s.active_guardrails,
    phaseStatus: s.phase_status,
  };
}

// ── Hypothesis schemas ──────────────────────────────────────────────────
//
// Hoisted out of registerTools so the schemas (and their .min/.max bounds)
// are easy to spot when reading the file: the integration test for
// hypothesis_* asserts the bounds end-to-end through the MCP client.

const hypothesisSessionIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._-]+$/, 'session id may only contain letters, digits, ".", "_", or "-"')
  // The charset regex alone still admits '.' and '..' (both chars are in
  // the allowed set); reject those two reserved segments explicitly so
  // every string that passes this schema is guaranteed safe to pass to
  // hypothesis-store.ts's sanitizeHypothesisSessionId without throwing.
  // Without this, sessionId='.' passed zod (min(1)/max(256) don't exclude
  // it) but threw inside the handler, surfacing as an uncaught-exception
  // MCP isError envelope instead of the same clean "Invalid arguments for
  // tool X" validation envelope every other malformed sessionId gets.
  .refine((id) => id !== '.' && id !== '..', {
    message: 'session id must not be "." or ".." (reserved path segments)',
  })
  .describe('Session id, namespaces the hypothesis store. Use the same id as your grounding session.');

const hypothesisIdSchema = z
  .string()
  .min(1)
  .max(64)
  .describe('Hypothesis id returned by hypothesis_record.');

// ledger_summary's sinceIso filter is passed straight into evidence-ledger's
// `datetime(created_at) >= datetime(@sinceIso)` SQL comparison. SQLite's
// datetime() silently returns NULL for anything it cannot parse, which makes
// the comparison false for every row rather than erroring -- a caller who
// passes '', a relative shorthand ('1h', '24h', 'yesterday'), an epoch
// number, or `Date.toString()` output gets a quiet 0 back, indistinguishable
// from "nothing established yet". A local datetime with no zone is a
// different failure: SQLite accepts it (this task's own probing confirmed
// datetime() already normalizes an explicit numeric offset to UTC correctly,
// so no query-side normalization is needed here), but it silently shifts the
// window whenever the caller's wall-clock zone is not UTC. Reject both
// classes at the schema boundary, before either reaches SQL, so an agent
// never mistakes "the filter matched nothing" for "the filter was
// malformed".
const SINCE_ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2}))?$/;

function isValidSinceIso(value: string): boolean {
  return SINCE_ISO_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

const SINCE_ISO_VALIDATION_MESSAGE =
  'sinceIso must be an ISO-8601 date (e.g. "2026-05-01") or a datetime with an explicit Z or numeric offset (e.g. "2026-05-01T08:00:00Z" or "2026-05-01T10:00:00+02:00"); relative shorthand ("1h", "24h", "yesterday"), epoch seconds/milliseconds, Date.toString() output, an empty string, and a local datetime without a zone are rejected because SQLite would otherwise silently exclude every row instead of erroring';

const hypothesisTextSchema = z
  .string()
  .min(1)
  .max(4096)
  .describe('One-sentence hypothesis (e.g. "DNS resolution is failing").');

const evidenceTextSchema = z
  .string()
  .min(1)
  .max(4096)
  .describe('What you observed (raw, not interpreted).');

// ── Ledger request serialization (task 0a8645d2) ────────────────────────
//
// The evidence ledger (better-sqlite3, fully synchronous) has no race of
// its own. The race is upstream, in the MCP SDK's own dispatch: the
// `tools/call` request handler `await`s zod schema validation
// (`validateToolInput`) before invoking a tool's callback, and two
// concurrently-arriving requests validate against schemas of different
// shapes (ledger_add's 5-key object vs ledger_summary's 3-key object).
// That difference changes how many microtask ticks each validation takes
// to resolve, so the tool whose schema resolves faster can have ITS
// callback invoked first, even though its JSON-RPC request arrived
// second (seen in an instrumentation trace of a
// `Promise.all([ledger_add, ledger_summary])` call: the summary callback
// ran before the add callback).
//
// Two orders that look like arrival order are not:
//   - The JSON-RPC request id's own VALUE. Nothing in JSON-RPC requires
//     rising numeric ids: a string id, a UUID, or a client that hands out
//     falling numeric ids is legal, and sorting by value reorders those
//     exactly like the original bug.
//   - The order in which handlers call `enqueue()`. By then the SDK's
//     async per-request validation has already had its chance to reorder
//     which handler runs first, so this is the reordered invocation order.
//
// Arrival stamp. True arrival order is observable in the transport's own
// `onmessage` callback: `Protocol#connect` (see
// node_modules/@modelcontextprotocol/sdk/dist/esm/shared/protocol.js,
// the `connect()` method) keeps whatever `transport.onmessage` was
// already set to and invokes it SYNCHRONOUSLY, first, for every message,
// before its own routing and the async validation chain that reorders
// invocation:
//
//   const _onmessage = this._transport?.onmessage;
//   this._transport.onmessage = (message, extra) => {
//     _onmessage?.(message, extra);           // <- ours, if set first
//     ... isJSONRPCRequest(message) ? this._onrequest(message, extra) ...
//   };
//
// `trackLedgerRequests` below installs that `onmessage` (and a `send`
// wrapper, see "Stamp lifetime") on a transport before `Protocol#connect`
// runs; `createServer` wraps `server.connect` so this happens for every
// transport the server is connected to (stdio in `main()`,
// `InMemoryTransport` in the tests). It stamps only a JSON-RPC request
// (`isJSONRPCRequest`, the check the SDK routes requests by) whose method
// is `tools/call` and whose `params.name` is in `LEDGER_TOOL_NAMES`, with a
// per-server sequence number that rises by one per stamped request.
//
// Stamp lifetime. Two releases and a cap keep the map down to ledger
// requests that are still in flight:
//   - `send` wrapper: released when the server sends the JSON-RPC response
//     (a message with an `id` and no `method`) for that id. The SDK sends
//     one for a completed call, for a tool error, and for a call that fails
//     input validation (answered with an `isError` result without invoking
//     the tool's callback, so that call never reaches the queue).
//   - queue `finally` (in `drain`): released when the request's queued run
//     settles. This covers a request the client cancels
//     (`notifications/cancelled`) after it arrived: the SDK still invokes
//     the tool's callback but sends no response for it.
//   - cap: neither release fires for a request that gets no response
//     (cancelled, or cut off by the transport closing) AND never reaches
//     the queue (it fails validation, say), so its stamp would stay.
//     `LedgerArrivalStamps` therefore holds at most `cap` stamps (default
//     `DEFAULT_LEDGER_ARRIVAL_CAP`): recording one more evicts the oldest,
//     since a Map iterates in insertion order and a stamp is inserted when
//     its request arrives.
//
// Queue. Each ledger handler hands `{requestId, run}` to `enqueue()`,
// which buffers entries and, on the first entry of a new batch, schedules
// a `setImmediate` barrier. The barrier fires after the current microtask
// queue drains, so every ledger request that arrived in the same
// event-loop turn has reached `enqueue()` by then (the dispatch up to
// `enqueue()`, validation included, is microtask-only). `drain`
// computes each entry's sort key exactly once, reading its stamp without
// removing it, sorts on those precomputed keys, and chains each entry's
// `run()` onto one shared tail promise, so entry N only starts once entry
// N-1's ledger work has finished. Keys are never computed inside the sort comparator: a
// comparator is called more than once per element, and one that changed
// the stamps would change an element's key in the middle of the sort.
//
// Missing stamp. An entry whose stamp is absent when its batch drains
// (evicted by the cap, or a client that reuses an in-flight request id,
// which MCP forbids) is logged with `console.error`, one line per entry,
// and runs after every stamped entry of its batch, in `enqueue()` call
// order, since its arrival position is no longer known. A caller that
// invokes a tool's callback directly, without a transport, has no stamp
// either and takes this path.
//
// Scope. The handlers that read or write the ledger
// (`rg 'ledgerDb\(\)|ledgerStatus\(\)' packages/grounding-mcp/src`):
// ledger_add, ledger_summary, claim_evaluate_from_session (via
// getSummary), and ledger_status (via ledgerStatus's own ledgerDb()
// call). All four go through this queue, and `LEDGER_TOOL_NAMES` lists
// the same four. `hypothesis_*` reads/writes its own separate store
// through the same kind of SDK dispatch and is NOT ordered by this or any
// other mechanism (same root cause, tracked as a follow-up task, out of
// scope here): see the package README and CHANGELOG.
const LEDGER_TOOL_NAMES: ReadonlySet<string> = new Set([
  'ledger_add',
  'ledger_summary',
  'claim_evaluate_from_session',
  'ledger_status',
]);

const DEFAULT_LEDGER_ARRIVAL_CAP = 1024;

// `raw` is createServer's test-oriented `ledgerArrivalCap` option: anything
// that is not a positive safe integer falls back to the default, since a
// cap below 1 would evict every stamp as soon as it is recorded.
function resolveLedgerArrivalCap(raw: unknown): number {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_LEDGER_ARRIVAL_CAP;
}

class LedgerArrivalStamps {
  private readonly stamps = new Map<RequestId, number>();
  private nextSeq = 0;

  constructor(private readonly cap: number) {}

  record(requestId: RequestId): void {
    this.stamps.set(requestId, this.nextSeq++);
    if (this.stamps.size > this.cap) {
      const oldest = this.stamps.keys().next().value as RequestId;
      this.stamps.delete(oldest);
    }
  }

  get(requestId: RequestId): number | undefined {
    return this.stamps.get(requestId);
  }

  release(requestId: RequestId): void {
    this.stamps.delete(requestId);
  }

  get size(): number {
    return this.stamps.size;
  }
}

const ledgerArrivalStampsByServer = new WeakMap<McpServer, LedgerArrivalStamps>();

// Test seam, not supported API: how many ledger arrival stamps a server
// built by `createServer` holds right now (see "Stamp lifetime" above).
// @internal
export function ledgerArrivalStampCount(server: McpServer): number {
  const stamps = ledgerArrivalStampsByServer.get(server);
  if (stamps === undefined) {
    throw new Error('ledgerArrivalStampCount: server was not built by createServer');
  }
  return stamps.size;
}

function isLedgerToolCall(message: JSONRPCMessage): message is JSONRPCRequest {
  if (!isJSONRPCRequest(message) || message.method !== 'tools/call') return false;
  const name = (message.params as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' && LEDGER_TOOL_NAMES.has(name);
}

function trackLedgerRequests(transport: Transport, stamps: LedgerArrivalStamps): void {
  const priorOnMessage = transport.onmessage;
  transport.onmessage = ((message: JSONRPCMessage, extra?: MessageExtraInfo) => {
    if (isLedgerToolCall(message)) stamps.record(message.id);
    priorOnMessage?.(message, extra);
  }) as typeof transport.onmessage;
  const baseSend = transport.send.bind(transport);
  transport.send = (message, options) => {
    if (!('method' in message) && message.id !== undefined) stamps.release(message.id);
    return baseSend(message, options);
  };
}

interface LedgerQueueEntry {
  requestId: RequestId;
  enqueueSeq: number;
  run: () => unknown;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

function createLedgerRequestQueue(
  stamps: LedgerArrivalStamps,
): <T>(requestId: RequestId, run: () => T | Promise<T>) => Promise<T> {
  let pending: LedgerQueueEntry[] = [];
  let barrierScheduled = false;
  let enqueueCounter = 0;
  let tail: Promise<void> = Promise.resolve();

  // [tier, key]: tier 0 (a recorded arrival stamp, key = the stamp) sorts
  // before tier 1 (no stamp, see "Missing stamp" above; key = enqueue-call
  // order). Called once per entry per batch, from `drain`, never from the
  // sort comparator.
  function sortKey(entry: LedgerQueueEntry): [number, number] {
    const stamp = stamps.get(entry.requestId);
    if (stamp !== undefined) return [0, stamp];
    // eslint-disable-next-line no-console
    console.error(
      `grounding-mcp: ledger request id ${JSON.stringify(entry.requestId)} has no recorded arrival ` +
        'stamp (evicted by the in-flight cap, or a reused request id); running it after every stamped ' +
        'ledger request of its batch, in enqueue-call order, which is NOT guaranteed to be arrival order.',
    );
    return [1, entry.enqueueSeq];
  }

  function drain(): void {
    const batch = pending;
    pending = [];
    barrierScheduled = false;
    const keyed = batch.map((entry) => ({ entry, key: sortKey(entry) }));
    keyed.sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1]);
    for (const { entry } of keyed) {
      tail = tail.then(async () => {
        try {
          entry.resolve(await entry.run());
        } catch (err) {
          entry.reject(err);
        } finally {
          stamps.release(entry.requestId);
        }
      });
    }
  }

  return function enqueue<T>(requestId: RequestId, run: () => T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      pending.push({
        requestId,
        enqueueSeq: enqueueCounter++,
        run: run as () => unknown,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      if (!barrierScheduled) {
        barrierScheduled = true;
        setImmediate(drain);
      }
    });
  };
}

// ── Server factory ──────────────────────────────────────────────────────
//
// Builds a fully wired McpServer instance. Exposed as a factory so tests
// can hook a fresh server up to an InMemoryTransport without triggering
// the CLI `main()` path that opens stdio.

// `raw` is untrusted caller input (options.progressIntervalMs), not just an
// optional number: anything that is not a positive finite number (0,
// negative, NaN, Infinity, a non-number) falls back to the default instead
// of reaching `setInterval` — a non-positive interval would otherwise flood
// the client with notifications. Exported so it is unit-testable without
// standing up a full server.
export function resolveProgressIntervalMs(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PROGRESS_INTERVAL_MS;
}

// `progressIntervalMs` is test-oriented: it exists so the MCP-roundtrip
// progress tests can use a short real interval (e.g. 20ms) instead of
// waiting out the ~10s production default. Production callers should not
// set it.
//
// The `attempt*` options are test-oriented for the same reason (a short wait
// bound instead of the ~45s production default, a short retention window plus
// an injectable clock instead of a day), and operator-oriented for one of
// them: `attemptWaitBoundMs` is the value an operator lowers when the client
// in use cuts calls earlier than this default assumes. Each is validated the
// same way `progressIntervalMs` is, inside the registry.
//
// `ledgerArrivalCap` is test-oriented too: the most ledger arrival stamps
// the server keeps at once (default 1024, see the "Ledger request
// serialization" comment above `LEDGER_TOOL_NAMES`), so a test can evict
// a stamp with a handful of requests. Anything that is not a positive safe
// integer falls back to the default. Production callers should not set it.
//
// Spelled out field by field rather than intersected with the registry's own
// `AttemptRegistryOptions`: intersecting it published a SECOND, undocumented
// spelling of every knob (`waitBoundMs` beside `attemptWaitBoundMs`, and so
// on) that nothing here documents and nothing forwards deliberately. This type
// is the whole option surface of `createServer`, and the four `attempt*` names
// plus `now` are all of it.
export function createServer(
  options: {
    progressIntervalMs?: number;
    attemptWaitBoundMs?: number;
    attemptPollAfterMs?: number;
    attemptRetentionMs?: number;
    attemptLockStaleMs?: number;
    now?: () => number;
    ledgerArrivalCap?: number;
  } = {},
): McpServer {
  const progressIntervalMs = resolveProgressIntervalMs(options.progressIntervalMs);
  const attempts = new SolutionAttemptRegistry({
    waitBoundMs: options.attemptWaitBoundMs,
    pollAfterMs: options.attemptPollAfterMs,
    retentionMs: options.attemptRetentionMs,
    lockStaleMs: options.attemptLockStaleMs,
    now: options.now,
  });

  const server = new McpServer({
    name: 'grounding-mcp',
    version: PACKAGE_VERSION,
  });

  // One stamp map and one queue per server instance (see the "Ledger
  // request serialization" comment above `LEDGER_TOOL_NAMES`), not
  // module-level singletons: tests create a fresh server per case, and
  // module-level state would leak ordering state across otherwise
  // independent test servers.
  const ledgerArrivalStamps = new LedgerArrivalStamps(resolveLedgerArrivalCap(options.ledgerArrivalCap));
  ledgerArrivalStampsByServer.set(server, ledgerArrivalStamps);
  const enqueueLedgerRequest = createLedgerRequestQueue(ledgerArrivalStamps);

  // Wrap `connect` itself (not each individual call site) so every
  // transport this server instance is connected to (stdio in `main()`
  // below, `InMemoryTransport` in the tests) gets `trackLedgerRequests`
  // installed before the SDK's own `Protocol#connect` runs. See the
  // "Ledger request serialization" comment above `LEDGER_TOOL_NAMES` for
  // why this must happen before, not inside, a ledger-touching handler.
  const baseConnect = server.connect.bind(server);
  server.connect = (async (transport: Transport) => {
    trackLedgerRequests(transport, ledgerArrivalStamps);
    return baseConnect(transport);
  }) as typeof server.connect;

  server.tool(
    'grounding_start',
    'Start a new grounding session. Returns the session id, the mandatory tool sequence, and the active guardrails. Always call this BEFORE diagnosing a debug/incident task — the session enforces phase ordering and gates premature claims.',
    {
      keyword: z.string().describe('Domain keyword (e.g. "agent-tasks", "deploy-panel"). Drives guardrail and playbook selection.'),
      problem: z.string().describe('One-sentence problem statement (e.g. "frontend offline after deploy").'),
      workspace: z.string().optional().describe('Optional workspace path; reserved for future scope-resolution use.'),
    },
    async ({ keyword, problem, workspace }) => {
      const session = initSession({ keyword, problem, workspace });
      saveSession(session);
      return jsonResponse(summarizeSession(session));
    },
  );

  server.tool(
    'grounding_advance',
    'Advance an existing grounding session to the next phase. Marks the current phase done and returns the updated session state.',
    {
      sessionId: z.string().describe('Session id returned by grounding_start.'),
    },
    async ({ sessionId }) => {
      const session = loadSession(sessionId);
      advancePhase(session);
      saveSession(session);
      return jsonResponse(summarizeSession(session));
    },
  );

  server.tool(
    'grounding_guardrail_check',
    'Check whether a specific guardrail is active for a session. Use before making a claim to avoid blocking by claim-gate.',
    {
      sessionId: z.string(),
      guardrail: z.enum([
        'no-root-cause-before-readme',
        'no-token-claim-before-config-check',
        'no-architecture-claim-before-docs',
        'no-network-claim-before-process-check',
        'no-step-skipping',
      ]).describe('Guardrail id to check.'),
    },
    async ({ sessionId, guardrail }) => {
      const session = loadSession(sessionId);
      const active = isGuardrailActive(session, guardrail as GuardrailId);
      return jsonResponse({ sessionId, guardrail, active });
    },
  );

  server.tool(
    'ledger_add',
    'Append an entry to the evidence ledger for a session. Types: fact (verified), hypothesis (unverified), rejected (disproven), unknown (open question), policy_decision (Phase 5 #4 audit row, kept in a separate bucket from evidence types). A later ledger_summary call only sees this entry if it is given this exact sessionId string (case-sensitive, no normalization), and only once the write has actually happened: ledger_add, ledger_summary, claim_evaluate_from_session, and ledger_status are ordered by arrival at the transport (not by request id value or invocation order), so a ledger_summary that arrives after a ledger_add for the same sessionId sees it, also when the two calls are pipelined or made concurrently. With more than 1024 ledger requests in flight at once, the oldest loses its arrival stamp and runs after the other requests of its batch (logged to stderr). hypothesis_* tools are a separate store and are not ordered this way.',
    {
      sessionId: z.string().min(1).describe('Session id: used as the ledger session namespace.'),
      type: z.enum(['fact', 'hypothesis', 'rejected', 'unknown', 'policy_decision']),
      content: z.string().describe('What you observed / hypothesize / rejected.'),
      source: z.string().optional().describe('Where the evidence came from (file path, log line, command output).'),
      confidence: z.enum(['high', 'medium', 'low']).optional(),
    },
    async ({ sessionId, type, content, source, confidence }, extra) => {
      const entry = await enqueueLedgerRequest(extra.requestId, () =>
        addEntry(ledgerDb(), {
          type: type as EntryType,
          content,
          source,
          confidence: confidence as ConfidenceLevel | undefined,
          session: sessionId,
        }),
      );
      return jsonResponse(entry);
    },
  );

  server.tool(
    'ledger_summary',
    'Return facts/hypotheses/rejected/unknowns for a session. Use to brief a follow-up agent or before claim-gate evaluation. Phase 5 #5: optional server-side filters. A zero count is not necessarily an error: causes include (not an exhaustive list) no entries yet, a sessionId that does not exactly match the string an earlier ledger_add used (case-sensitive, no normalization), or a sinceIso/contentPrefix filter that excludes every matching row (for example a sinceIso value SQLite cannot parse silently excludes rows rather than erroring). Ordered by arrival at the transport relative to a concurrent/pipelined ledger_add for the same sessionId, see the ledger_add description.',
    {
      sessionId: z.string().min(1),
      sinceIso: z
        .string()
        .refine(isValidSinceIso, { message: SINCE_ISO_VALIDATION_MESSAGE })
        .optional()
        .describe(
          'Optional ISO-8601 cutoff: a date ("2026-05-01") or a datetime with an explicit Z or numeric offset (e.g. "2026-05-01T08:00:00Z" or "2026-05-01T10:00:00+02:00"). Rows with `created_at` earlier than this are excluded server-side. Rejected (not silently ignored) if it is empty, a relative shorthand ("1h", "24h", "yesterday"), an epoch number, Date.toString() output, or a local datetime without a zone.',
        ),
      contentPrefix: z
        .string()
        .optional()
        .describe(
          'Optional content-prefix filter. Only rows whose `content` starts with this string are returned. Useful for harness audit consumers that only want `policy_decision:` rows.',
        ),
    },
    async ({ sessionId, sinceIso, contentPrefix }, extra) => {
      const filters: { sinceIso?: string; contentPrefix?: string } = {};
      if (sinceIso !== undefined) filters.sinceIso = sinceIso;
      if (contentPrefix !== undefined) filters.contentPrefix = contentPrefix;
      const summary = await enqueueLedgerRequest(extra.requestId, () => getSummary(ledgerDb(), sessionId, filters));
      return jsonResponse({
        sessionId,
        counts: {
          facts: summary.facts.length,
          hypotheses: summary.hypotheses.length,
          rejected: summary.rejected.length,
          unknowns: summary.unknowns.length,
          policyDecisions: summary.policyDecisions.length,
        },
        entries: summary,
      });
    },
  );

  server.tool(
    'claim_evaluate',
    'Run a claim through claim-gate with caller-supplied context. Use this when you want to test a hypothetical context without a session (e.g. policy exploration).',
    {
      claim: z.string().describe('Free-text claim, e.g. "the root cause is a missing env var".'),
      type: z.enum([
        'root_cause',
        'architecture',
        'security',
        'network',
        'configuration',
        'process',
        'availability',
        'token',
        'generic',
      ]).optional().describe('Force a claim type; otherwise auto-detected from the claim text.'),
      context: z.object({
        readme_read: z.boolean().optional(),
        process_checked: z.boolean().optional(),
        config_checked: z.boolean().optional(),
        health_checked: z.boolean().optional(),
        has_evidence: z.boolean().optional(),
        alternatives_considered: z.boolean().optional(),
      }).optional().describe('Which prerequisite checks have been completed. Defaults to all-false (no prerequisites met) for policy exploration.'),
    },
    async ({ claim, context, type }) => {
      const result = evaluateClaim(
        claim,
        (context ?? {}) as ClaimContext,
        type as ClaimType | undefined,
      );
      return jsonResponse(result);
    },
  );

  server.tool(
    'claim_evaluate_from_session',
    'Like claim_evaluate, but derives the context from the linked grounding session and its ledger entries. The default path for in-session use: no manual flag-passing. Its ledger read is ordered by arrival at the transport relative to a concurrent/pipelined ledger_add for the same sessionId, see the ledger_add description.',
    {
      sessionId: z.string().min(1),
      claim: z.string(),
      type: z.enum([
        'root_cause',
        'architecture',
        'security',
        'network',
        'configuration',
        'process',
        'availability',
        'token',
        'generic',
      ]).optional(),
    },
    async ({ sessionId, claim, type }, extra) => {
      const session = loadSession(sessionId);
      const summary = await enqueueLedgerRequest(extra.requestId, () => getSummary(ledgerDb(), sessionId));
      const context = deriveContext(session, summary);
      const result = evaluateClaim(claim, context, type as ClaimType | undefined);
      return jsonResponse({ ...result, derivedContext: context });
    },
  );

  // ── Solution-acceptance gate ──────────────────────────────────────────
  //
  // "Done" earned from a real preflight run, not claimed. solution_evaluate
  // RUNS preflight (producer != solver; check set from committed
  // .preflight.json, not caller input) and records a HEAD-pinned verdict
  // marker outside the agent-writable ledger; solution_gate passes only when a
  // ready verdict exists at the current HEAD. See solution-verdict.ts for the
  // anti-hacking contract and README for the marker contract harness consumes.
  //
  // ALL THREE tools below (solution_evaluate and both lookups) bound `id` at
  // MAX_ID_FILENAME_LENGTH (see solution-attempt-log.ts for the derivation): an
  // id over the bound is refused by this schema before the handler ever runs,
  // and SolutionAttemptRegistry.evaluate() enforces the identical bound again
  // at the registry's own entry point, so a library caller that bypasses this
  // MCP schema still gets the failed payload before any filesystem call. Ids
  // are never paths.

  server.tool(
    'solution_evaluate',
    'Run preflight against a repo and record a HEAD-pinned solution-acceptance verdict for <id>, derived from preflight\'s real results (lint/typecheck/test/audit/secret), not from caller input, and with the check set taken from the repo\'s committed .preflight.json. Use this to earn "done" instead of claiming it. Requires the `preflight` binary (agent-preflight) on PATH or via SOLUTION_PREFLIGHT_BIN; fails closed (writes no verdict) when it is unavailable. If the request carries a progressToken, sends periodic notifications/progress pings ("still running", no percentage) while preflight runs; a client that also enables timeout reset on progress can then avoid its own client-side timeout on a slow preflight run — see README.',
    {
      id: z
        .string()
        .min(1)
        .max(MAX_ID_FILENAME_LENGTH)
        .describe('Identifier the verdict is scoped to, e.g. a task id.'),
      repoPath: z
        .string()
        .optional()
        .describe('Repository to evaluate. Defaults to the current working directory.'),
      forceNewAttempt: z
        .boolean()
        .optional()
        .describe('Start a genuinely new attempt instead of joining. Refused while an attempt for this id is still running.'),
    },
    async ({ id, repoPath, forceNewAttempt }, extra) => {
      const result = await withProgressPings(
        extra,
        () => attempts.evaluate(id, repoPath ?? process.cwd(), { forceNewAttempt }),
        progressIntervalMs,
        DEFAULT_PROGRESS_MESSAGE,
      );
      return jsonResponse(result);
    },
  );

  // Read-only attempt lookups. Neither ever starts a `preflight` process, and
  // neither is gate authority: `solution_gate` still reads only the signed
  // marker. With `attemptId` omitted they answer for the latest attempt
  // recorded for the id, which is the recovery path for a caller whose own
  // request timed out before it ever learned an `attemptId`.
  //
  // An id that is short enough to pass this schema but still unusable
  // (`'..'`, say) is answered by the registry with `{status:"unknown", id,
  // error}`, the same posture `solution_evaluate` already has for an unusable
  // id, not with an isError envelope.
  server.tool(
    'solution_evaluate_status',
    'Look up the status of a solution_evaluate attempt for <id> (running / completed / failed / unknown / expired / running-unconfirmed). Read-only and fast: never starts preflight, never blocks. Omit attemptId to ask about the latest attempt recorded for the id, which is the recovery path when your own solution_evaluate call timed out without returning a handle.',
    {
      id: z
        .string()
        .min(1)
        .max(MAX_ID_FILENAME_LENGTH)
        .describe('The same identifier solution_evaluate was called with.'),
      attemptId: z
        .string()
        .min(1)
        .optional()
        .describe('Server-generated attempt handle. Omit to resolve the latest attempt for the id.'),
    },
    async ({ id, attemptId }) => jsonResponse(await attempts.status(id, attemptId)),
  );

  server.tool(
    'solution_evaluate_result',
    'Fetch the outcome of a solution_evaluate attempt for <id> once it is terminal; returns {status:"running"} rather than blocking while it is not. Read-only: never starts preflight. A lookup answered by a process that did not itself run the attempt (another session, or this one after a restart) returns the reduced payload (outcomeClass, summary, persisted error) with verdict/markerPath only when this attempt is still the latest for the id and its marker is present.',
    {
      id: z
        .string()
        .min(1)
        .max(MAX_ID_FILENAME_LENGTH)
        .describe('The same identifier solution_evaluate was called with.'),
      attemptId: z
        .string()
        .min(1)
        .optional()
        .describe('Server-generated attempt handle. Omit to resolve the latest attempt for the id.'),
    },
    async ({ id, attemptId }) => jsonResponse(await attempts.result(id, attemptId)),
  );

  server.tool(
    'solution_gate',
    'Check the solution-acceptance gate for <id>: allowed only if a ready verdict exists at the current git HEAD. Otherwise returns a precise deny reason (no verdict / not ready + blockers / HEAD drift / unresolvable HEAD). Read-only: produce the verdict with solution_evaluate first.',
    {
      id: z.string().min(1),
      repoPath: z.string().optional(),
    },
    async ({ id, repoPath }) => {
      const head = await getHeadSha(repoPath ?? process.cwd());
      const result = evaluateGate(id, head);
      return jsonResponse(result);
    },
  );

  server.tool(
    'verify_memory_reference',
    'Check whether a memory-referenced path/symbol/flag still exists in the current repo state. Use before recommending anything from a memory that names a concrete file, function, or CLI flag — a fast sanity-check against rename/delete/never-merged drift.',
    {
      kind: z.enum(['path', 'symbol', 'flag']),
      value: z.string().min(1),
      repoRoot: z.string().optional(),
    },
    async ({ kind, value, repoRoot }) => {
      const ref: MemoryReference = { kind, value, ...(repoRoot ? { repoRoot } : {}) };
      const result = verifyMemoryReference(ref);
      return jsonResponse(result);
    },
  );

  // ── Hypothesis tracker ────────────────────────────────────────────────
  //
  // Scratch-pad for competing hypotheses during a debug session. Distinct
  // from the ledger (which is the durable evidence record), but — like the
  // ledger and the grounding session — persisted to disk (see
  // hypothesis-store.ts) so it survives a grounding-mcp restart at parity
  // with the rest of the session state. Use it to force yourself to keep
  // alternatives alive instead of silently replacing one wrong guess with
  // another.
  //
  // Error shape: unlike the grounding/ledger verbs (which let loadSession
  // throw and propagate as an MCP tool error), these verbs return a
  // structured `{ error: <code>, ... }` payload for not-found / out-of-range
  // cases. Lazy-create semantics make "no store" a non-exceptional state,
  // so a structured response is friendlier to a recovering agent.

  server.tool(
    'hypothesis_record',
    'Add a new competing hypothesis with required verification checks. Use during debugging when you can name more than one possible cause, recording both forces explicit rejection later instead of silent substitution.',
    {
      sessionId: hypothesisSessionIdSchema,
      text: hypothesisTextSchema,
      requiredChecks: z
        .array(z.string().min(1).max(512))
        .max(32)
        .default([])
        .describe('Verification steps that, if completed, would confirm or reject this hypothesis (e.g. ["Run dig", "Check /etc/resolv.conf"]).'),
    },
    async ({ sessionId, text, requiredChecks }) => {
      const store = getOrCreateStore(sessionId);
      const hypothesis = addHypothesis(store, text, requiredChecks);
      saveStore(sessionId, store);
      return jsonResponse({ sessionId, hypothesis });
    },
  );

  server.tool(
    'hypothesis_list',
    'Return all hypotheses for a session plus a status summary. Use to take stock before claiming a root cause: every unverified or unrejected hypothesis is an open alternative the claim-gate will block on.',
    {
      sessionId: hypothesisSessionIdSchema,
    },
    async ({ sessionId }) => {
      const store = getStore(sessionId);
      if (!store) {
        return jsonResponse({
          sessionId,
          summary: { total: 0, unverified: 0, supported: 0, rejected: 0, pending_checks: 0 },
          hypotheses: [],
        });
      }
      return jsonResponse({
        sessionId,
        summary: getHypothesisSummary(store),
        hypotheses: store.hypotheses,
      });
    },
  );

  server.tool(
    'hypothesis_evidence',
    'Attach evidence to an existing hypothesis. Auto-promotes an unverified hypothesis to supported (mirrors hypothesis-tracker semantics). Use with the actual observation (log line, command output): narrative-only evidence weakens the eventual claim-gate verdict.',
    {
      sessionId: hypothesisSessionIdSchema,
      hypothesisId: hypothesisIdSchema,
      evidence: evidenceTextSchema,
      source: z.string().max(512).optional().describe('Where the observation came from (file path, command, log file).'),
    },
    async ({ sessionId, hypothesisId, evidence, source }) => {
      const store = getStore(sessionId);
      if (!store) {
        return jsonResponse({ error: 'no_store_for_session', sessionId });
      }
      const updated = addEvidence(store, hypothesisId, evidence, source);
      if (!updated) {
        return jsonResponse({ error: 'hypothesis_not_found', sessionId, hypothesisId });
      }
      saveStore(sessionId, store);
      return jsonResponse({ sessionId, hypothesis: updated });
    },
  );

  server.tool(
    'hypothesis_check_done',
    'Mark one of a hypothesis\'s required_checks as completed (0-indexed). Use after actually running the check: this is how the pending_checks counter in hypothesis_list drains.',
    {
      sessionId: hypothesisSessionIdSchema,
      hypothesisId: hypothesisIdSchema,
      checkIndex: z.number().int().min(0).describe('0-based index into required_checks.'),
    },
    async ({ sessionId, hypothesisId, checkIndex }) => {
      const store = getStore(sessionId);
      if (!store) {
        return jsonResponse({ error: 'no_store_for_session', sessionId });
      }
      const hypothesis = findHypothesis(store, hypothesisId);
      if (!hypothesis) {
        return jsonResponse({ error: 'hypothesis_not_found', sessionId, hypothesisId });
      }
      if (checkIndex >= hypothesis.required_checks.length) {
        return jsonResponse({
          error: 'check_index_out_of_range',
          sessionId,
          hypothesisId,
          checkIndex,
          availableChecks: hypothesis.required_checks.length,
        });
      }
      const updated = completeCheck(store, hypothesisId, checkIndex);
      saveStore(sessionId, store);
      return jsonResponse({ sessionId, hypothesis: updated });
    },
  );

  server.tool(
    'hypothesis_reject',
    'Reject a hypothesis with a reason. The reason is appended to the evidence list as a [rejected] entry so the rejection itself becomes auditable, not a silent delete.',
    {
      sessionId: hypothesisSessionIdSchema,
      hypothesisId: hypothesisIdSchema,
      reason: z.string().max(4096).optional().describe('Why the hypothesis was rejected (counter-evidence, failed check, contradiction).'),
    },
    async ({ sessionId, hypothesisId, reason }) => {
      const store = getStore(sessionId);
      if (!store) {
        return jsonResponse({ error: 'no_store_for_session', sessionId });
      }
      const updated = rejectHypothesis(store, hypothesisId, reason);
      if (!updated) {
        return jsonResponse({ error: 'hypothesis_not_found', sessionId, hypothesisId });
      }
      saveStore(sessionId, store);
      return jsonResponse({ sessionId, hypothesis: updated });
    },
  );

  server.tool(
    'hypothesis_support',
    'Explicitly mark a hypothesis as supported. Usually not needed: hypothesis_evidence auto-promotes on first evidence. Use this when promotion happens out-of-band (e.g. evidence is in the ledger but not yet attached).',
    {
      sessionId: hypothesisSessionIdSchema,
      hypothesisId: hypothesisIdSchema,
    },
    async ({ sessionId, hypothesisId }) => {
      const store = getStore(sessionId);
      if (!store) {
        return jsonResponse({ error: 'no_store_for_session', sessionId });
      }
      const updated = supportHypothesis(store, hypothesisId);
      if (!updated) {
        // null also covers a hypothesis whose required_checks are still
        // pending — supportHypothesis refuses to confirm until they are done.
        return jsonResponse({
          error: 'hypothesis_not_found_rejected_or_checks_pending',
          sessionId,
          hypothesisId,
        });
      }
      saveStore(sessionId, store);
      return jsonResponse({ sessionId, hypothesis: updated });
    },
  );

  server.tool(
    'hypothesis_reset',
    'Purge all hypotheses for a session. Use this when reusing a grounding sessionId for a new debug task so stale hypotheses from the previous investigation do not leak in.',
    {
      sessionId: hypothesisSessionIdSchema,
    },
    async ({ sessionId }) => {
      const cleared = resetStore(sessionId);
      return jsonResponse({ sessionId, cleared });
    },
  );

  server.tool(
    'ledger_status',
    'Return ledger reachability + lightweight stats (entry count, db path, last-write timestamp). No-arg liveness probe, designed for harness MCP health checks. Does not require a session. Its entry count is ordered by arrival at the transport relative to a concurrent/pipelined ledger_add, see the ledger_add description.',
    {},
    async (_args, extra) => jsonResponse(await enqueueLedgerRequest(extra.requestId, () => ledgerStatus())),
  );

  return server;
}

// ── Start ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // CLI short-circuit: print the version and exit before opening stdio
  // for the MCP transport. Tooling that probes installed binaries with
  // `<bin> --version` (e.g. `harness doctor`'s tools.mcp min_version
  // check) otherwise hangs on stdin while the transport waits for an
  // initialize request that never arrives.
  if (process.argv.includes('--version') || process.argv.includes('-v')) {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return;
  }
  // Reconcile before serving, never after: an attempt log row left `running`
  // by a process that died must resolve to `unknown` before this process
  // answers any lookup about it. The pass takes each id's lock with no
  // retries, so an id whose holder is still alive is skipped, not reconciled.
  // A failure here is reported and then tolerated: a reconciliation problem
  // must not stop the server from serving.
  try {
    await reconcileOrphanedAttempts();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('grounding-mcp: attempt reconciliation failed:', err);
  }
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only auto-run `main()` when this file is the entrypoint (e.g. invoked as
// the `grounding-mcp` bin). Importing the module from tests pulls in
// `createServer` without opening stdio. `realpathSync` on argv[1] handles
// the `node_modules/.bin/grounding-mcp` symlink so the bin invocation
// still triggers main().
function resolveArgv1(): string | undefined {
  const argv1 = process.argv[1];
  if (typeof argv1 !== 'string') return undefined;
  try {
    return realpathSync(argv1);
  } catch {
    return argv1;
  }
}
const isCliEntrypoint = resolveArgv1() === fileURLToPath(import.meta.url);

if (isCliEntrypoint) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('grounding-mcp failed:', err);
    process.exit(1);
  });
}
