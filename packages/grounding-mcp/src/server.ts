#!/usr/bin/env node
// MCP server exposing the agent-grounding stack to long-running Claude Code
// sessions. See README.md for the full tool catalog and the Claude Code
// settings.json registration block.

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

import { saveSession, loadSession } from './session-store.js';
import { ledgerDb } from './ledger-bridge.js';
import { deriveContext } from './derive-context.js';

const server = new McpServer({
  name: 'grounding-mcp',
  version: '0.1.0',
});

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

// ── Tools ────────────────────────────────────────────────────────────────

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

// ── Start ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('grounding-mcp failed:', err);
  process.exit(1);
});
