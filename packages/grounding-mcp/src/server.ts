#!/usr/bin/env node
// MCP server exposing the agent-grounding stack to long-running Claude Code
// sessions. See README.md for the full tool catalog and the Claude Code
// settings.json registration block.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
import { getOrCreateStore, getStore } from './hypothesis-store.js';

// Single source of truth for the version string emitted by both the
// MCP `name+version` handshake and the `--version` CLI short-circuit.
// Bump alongside package.json on release.
const PACKAGE_VERSION = '0.3.1';

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
  .describe('Session id, namespaces the hypothesis store. Use the same id as your grounding session.');

const hypothesisIdSchema = z
  .string()
  .min(1)
  .max(64)
  .describe('Hypothesis id returned by hypothesis_record.');

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

// ── Server factory ──────────────────────────────────────────────────────
//
// Builds a fully wired McpServer instance. Exposed as a factory so tests
// can hook a fresh server up to an InMemoryTransport without triggering
// the CLI `main()` path that opens stdio.

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'grounding-mcp',
    version: PACKAGE_VERSION,
  });

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
    'Append an entry to the evidence ledger for a session. Types: fact (verified), hypothesis (unverified), rejected (disproven), unknown (open question), policy_decision (Phase 5 #4 audit row, kept in a separate bucket from evidence types).',
    {
      sessionId: z.string().describe('Session id — used as the ledger session namespace.'),
      type: z.enum(['fact', 'hypothesis', 'rejected', 'unknown', 'policy_decision']),
      content: z.string().describe('What you observed / hypothesize / rejected.'),
      source: z.string().optional().describe('Where the evidence came from (file path, log line, command output).'),
      confidence: z.enum(['high', 'medium', 'low']).optional(),
    },
    async ({ sessionId, type, content, source, confidence }) => {
      const entry = addEntry(ledgerDb(), {
        type: type as EntryType,
        content,
        source,
        confidence: confidence as ConfidenceLevel | undefined,
        session: sessionId,
      });
      return jsonResponse(entry);
    },
  );

  server.tool(
    'ledger_summary',
    'Return facts/hypotheses/rejected/unknowns for a session. Use to brief a follow-up agent or before claim-gate evaluation. Phase 5 #5: optional server-side filters.',
    {
      sessionId: z.string(),
      sinceIso: z
        .string()
        .optional()
        .describe(
          'Optional ISO-8601 UTC cutoff (e.g. "2026-05-01T08:00:00Z"). Rows with `created_at` earlier than this are excluded server-side.',
        ),
      contentPrefix: z
        .string()
        .optional()
        .describe(
          'Optional content-prefix filter. Only rows whose `content` starts with this string are returned. Useful for harness audit consumers that only want `policy_decision:` rows.',
        ),
    },
    async ({ sessionId, sinceIso, contentPrefix }) => {
      const filters: { sinceIso?: string; contentPrefix?: string } = {};
      if (sinceIso !== undefined) filters.sinceIso = sinceIso;
      if (contentPrefix !== undefined) filters.contentPrefix = contentPrefix;
      const summary = getSummary(ledgerDb(), sessionId, filters);
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
    'Like claim_evaluate, but derives the context from the linked grounding session and its ledger entries. The default path for in-session use — no manual flag-passing.',
    {
      sessionId: z.string(),
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
    async ({ sessionId, claim, type }) => {
      const session = loadSession(sessionId);
      const summary = getSummary(ledgerDb(), sessionId);
      const context = deriveContext(session, summary);
      const result = evaluateClaim(claim, context, type as ClaimType | undefined);
      return jsonResponse({ ...result, derivedContext: context });
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
  // from the ledger (which is the durable evidence record): hypotheses
  // here live only in-process and are meant to be churned through as the
  // agent reasons. Use them to force yourself to keep alternatives alive
  // instead of silently replacing one wrong guess with another.
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
        return jsonResponse({ error: 'hypothesis_not_found_or_rejected', sessionId, hypothesisId });
      }
      return jsonResponse({ sessionId, hypothesis: updated });
    },
  );

  server.tool(
    'ledger_status',
    'Return ledger reachability + lightweight stats (entry count, db path, last-write timestamp). No-arg liveness probe — designed for harness MCP health checks. Does not require a session.',
    {},
    async () => jsonResponse(ledgerStatus()),
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
