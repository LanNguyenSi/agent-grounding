/** Restricted seven-operation assessment MCP surface. It deliberately imports no legacy server. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { dossierProjection, PHASES } from './grounding-assessment-policy.js';
import { AssessmentStoreError, GroundingAssessmentStore } from './grounding-assessment-store.js';
import { ASSESSMENT_PACKAGE_VERSION } from './grounding-issuer.js';

const token = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]{1,128}$/);
const uuid = z.string().uuid();
const integer = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().length(64).regex(/^[0-9a-f]{64}$/);
const challenge = z.object({
  audience: token, projectId: uuid, taskId: uuid, attemptId: uuid,
  nonce: z.string().length(43).regex(/^[A-Za-z0-9_-]{43}$/), contextRevision: integer,
  target: z.object({ workflowId: uuid.nullable(), from: token, to: token, action: token }).strict(),
  subject: z.object({ kind: z.literal('task-context/v1'), digest }).strict(),
  policy: z.object({ id: z.literal('debug-evidence-assessment/v1'), revision: z.literal('1'), sha256: z.literal('50c68e4070b5c36c2bd166f61f83377df717253f30933fe05825386d605325a4') }).strict(),
  createdAt: z.number().int().min(0), expiresAt: z.number().int().min(1),
}).strict();
const session = z.object({ sessionId: token }).strict();
const mutation = z.object({ sessionId: token, expectedRevision: integer }).strict();

function json(value: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }; }
function error(error: unknown) {
  const message = error instanceof AssessmentStoreError ? error.message : 'Assessment request rejected';
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}
function guarded<T>(operation: () => Promise<T>, projection: (value: T) => unknown = (value) => value) {
  return async () => { try { return json(projection(await operation())); } catch (cause) { return error(cause); } };
}

export const ASSESSMENT_TOOL_NAMES = Object.freeze([
  'assessment_start', 'assessment_status', 'assessment_advance', 'assessment_dossier_add',
  'assessment_dossier_read', 'assessment_claim_set', 'assessment_export',
] as const);

export function createAssessmentServer(store: GroundingAssessmentStore): McpServer {
  const server = new McpServer({ name: 'grounding-assessment-mcp', version: ASSESSMENT_PACKAGE_VERSION });
  server.registerTool('assessment_start', { description: 'Start a producer-owned assessment session.', inputSchema: z.object({ challenge, keyword: z.string().min(1).max(64), problem: z.string().min(1).max(8192) }).strict() },
    ({ challenge: input, keyword, problem }) => guarded(() => store.createSession({ challenge: input, keyword, problem }))());
  server.registerTool('assessment_status', { description: 'Read session revision and current phase.', inputSchema: session },
    ({ sessionId }) => guarded(() => store.getSession({ sessionId }), (value) => ({ sessionId: value.id, revision: value.revision, currentPhase: value.currentPhase }))());
  server.registerTool('assessment_advance', { description: 'Confirm the current assessment phase.', inputSchema: mutation.extend({ expectedPhase: z.enum(PHASES) }).strict() },
    ({ sessionId, expectedRevision, expectedPhase }) => guarded(() => store.advance({ sessionId, expectedRevision, expectedPhase }))());
  server.registerTool('assessment_dossier_add', { description: 'Add an agent-asserted dossier entry.', inputSchema: mutation.extend({ kind: z.enum(['fact', 'hypothesis', 'rejected', 'unknown']), content: z.string().min(1).max(8192), source: z.string().max(1024) }).strict() },
    ({ sessionId, expectedRevision, kind, content, source }) => guarded(() => store.addDossierEntry({ sessionId, expectedRevision, kind, content, source }))());
  server.registerTool('assessment_dossier_read', { description: 'Read the bounded dossier projection.', inputSchema: session },
    ({ sessionId }) => guarded(() => store.getSession({ sessionId }), dossierProjection)());
  server.registerTool('assessment_claim_set', { description: 'Set the agent-asserted claim text.', inputSchema: mutation.extend({ text: z.string().max(8192) }).strict() },
    ({ sessionId, expectedRevision, text }) => guarded(() => store.setClaim({ sessionId, expectedRevision, text }))());
  server.registerTool('assessment_export', { description: 'Export the exact UTF-8 signed receipt wire bytes.', inputSchema: mutation.extend({ challenge }).strict() },
    async ({ sessionId, expectedRevision, challenge: input }) => {
      try {
        const wire = await store.exportReceipt({ sessionId, expectedRevision, challenge: input });
        const text = new TextDecoder('utf-8', { fatal: true }).decode(wire);
        return { content: [{ type: 'text' as const, text }] };
      }
      catch (cause) { return error(cause); }
    });
  return server;
}
