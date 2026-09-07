import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPublicKey, generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AssessmentChallenge } from '../src/grounding-assessment-store.js';
import type { AssessmentSnapshot } from '../src/grounding-assessment-policy.js';
import { ASSESSMENT_POLICY } from '../src/grounding-assessment-policy.js';
import { verifyReceipt } from '../src/grounding-receipt.js';
import { createAssessmentServer } from '../src/assessment-server.js';
import { createAssessmentStore } from '../src/grounding-issuer.js';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) { try { await close(); } catch (error) { failures.push(error); } }
  vi.restoreAllMocks();
  expect(failures).toEqual([]);
});
const phases = ['scope-resolution', 'doc-reading', 'playbook-loading', 'runtime-inspection', 'evidence-collection', 'claim-evaluation'] as const;
function challenge(): AssessmentChallenge {
  const now = Math.floor(Date.now() / 1000);
  return { audience: 'consumer.test', projectId: randomUUID(), taskId: randomUUID(), attemptId: randomUUID(),
    nonce: Buffer.alloc(32, 7).toString('base64url'), contextRevision: 1,
    target: { workflowId: null, from: 'producer', to: 'consumer', action: 'assess' },
    subject: { kind: 'task-context/v1', digest: 'a'.repeat(64) }, policy: { ...ASSESSMENT_POLICY }, createdAt: now - 1, expiresAt: now + 600 };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'assessment-receipt-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const producerHome = join(root, 'producer'); const clientHome = join(root, 'client');
  mkdirSync(producerHome); mkdirSync(clientHome);
  const keys = generateKeyPairSync('ed25519');
  const keyPath = join(producerHome, 'issuer.pem'); const publicPath = join(clientHome, 'issuer.pub');
  writeFileSync(keyPath, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }));
  writeFileSync(publicPath, keys.publicKey.export({ format: 'pem', type: 'spki' }));
  const configPath = join(producerHome, 'config.json'); const stateDirectory = join(producerHome, 'state');
  writeFileSync(configPath, JSON.stringify({ issuer: 'issuer.test', kid: 'key.test', privateKeyPath: keyPath, stateDirectory, policy: ASSESSMENT_POLICY }));
  const stateFile = join(stateDirectory, 'state.json');
  return { root, producerHome, clientHome, configPath, stateDirectory, stateFile, publicKey: createPublicKey(readFileSync(publicPath)) };
}
type Fixture = ReturnType<typeof fixture>;
async function connect(f: Fixture, mode: 'stdio' | 'memory' = 'stdio') {
  const client = new Client({ name: 'independent-assessment-client', version: '1' });
  if (mode === 'memory') {
    const store = await createAssessmentStore(f.configPath);
    const server = createAssessmentServer(store);
    const [a, b] = InMemoryTransport.createLinkedPair();
    cleanup.push(() => server.close()); cleanup.push(() => client.close());
    await server.connect(b); await client.connect(a);
    return { client, close: () => client.close() };
  }
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [resolve(import.meta.dirname, '../dist/assessment-index.js')], cwd: f.producerHome,
    env: { HOME: f.producerHome, GROUNDING_ASSESSMENT_CONFIG: f.configPath,
      HARNESS_HOME: join(f.producerHome, '.harness'), GROUNDING_MCP_SESSIONS_DIR: join(f.producerHome, 'legacy-sessions'),
      EVIDENCE_LEDGER_DB: join(f.producerHome, 'legacy-ledger.db') }, stderr: 'pipe' });
  let stderr = ''; transport.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  // Register cleanup before connect: even failed initialization must terminate its child.
  cleanup.push(() => transport.close()); cleanup.push(() => client.close());
  await client.connect(transport, { timeout: 4000 });
  const onclose = transport.onclose;
  const closed = new Promise<void>((done) => { transport.onclose = () => { onclose?.(); done(); }; });
  let stopped = false;
  const close = async () => {
    if (stopped) return;
    stopped = true;
    await client.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('stdio child did not close')), 5000); })]); }
    finally { clearTimeout(timer); }
    expect(stderr).toBe('');
  };
  cleanup.push(close);
  return { client, close };
}
function text(raw: unknown): string {
  const result = raw as { content: { type: string; text: string }[]; isError?: boolean };
  expect(result.isError).not.toBe(true); expect(result.content).toHaveLength(1); expect(result.content[0].type).toBe('text');
  return result.content[0].text;
}
async function call(client: Client, name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args }, undefined, { timeout: 4000 });
}
async function json<T = AssessmentSnapshot>(client: Client, name: string, args: Record<string, unknown>): Promise<T> {
  return JSON.parse(text(await call(client, name, args))) as T;
}
async function start(client: Client, c: AssessmentChallenge) {
  return json(client, 'assessment_start', { challenge: c, keyword: 'service', problem: 'documented outage' });
}
async function advance(client: Client, s: AssessmentSnapshot, count = phases.length) {
  for (const phase of phases.slice(0, count)) s = await json(client, 'assessment_advance', { sessionId: s.id, expectedRevision: s.revision, expectedPhase: phase });
  return s;
}
async function entry(client: Client, s: AssessmentSnapshot, kind = 'fact') {
  return json(client, 'assessment_dossier_add', { sessionId: s.id, expectedRevision: s.revision, kind, content: 'documented observation', source: 'agent notebook' });
}
async function claim(client: Client, s: AssessmentSnapshot, value = 'service offline') {
  return json(client, 'assessment_claim_set', { sessionId: s.id, expectedRevision: s.revision, text: value });
}
async function ready(client: Client, c: AssessmentChallenge) { return claim(client, await entry(client, await advance(client, await start(client, c)))); }
function exportArgs(s: AssessmentSnapshot, c: AssessmentChallenge) { return { sessionId: s.id, expectedRevision: s.revision, challenge: c }; }
function rejected(raw: unknown, previousWire?: string) {
  const result = raw as { isError?: boolean; content: { text: string }[] };
  expect(result.isError, 'failed requests must be errors, never stale success').toBe(true);
  expect(JSON.stringify(result)).not.toContain('grounding-receipt/v1');
  if (previousWire) expect(JSON.stringify(result)).not.toContain(JSON.stringify(previousWire).slice(1, -1));
}
function verify(wire: string, f: Fixture, c: AssessmentChallenge, s: AssessmentSnapshot) {
  const receipt = verifyReceipt(Buffer.from(wire, 'utf8'), f.publicKey);
  expect(Buffer.from(receipt.wire).toString('utf8')).toBe(wire);
  expect(receipt.envelope).toMatchObject({ issuer: 'issuer.test', kid: 'key.test', format: 'grounding-receipt/v1', alg: 'Ed25519' });
  expect(receipt.payload).toMatchObject({ audience: c.audience, projectId: c.projectId, taskId: c.taskId, attemptId: c.attemptId,
    nonce: c.nonce, contextRevision: c.contextRevision, target: c.target, subject: c.subject, policy: c.policy,
    session: { id: s.id, revision: s.revision } });
  expect(receipt.payload.expiresAt).toBeLessThanOrEqual(c.expiresAt);
  return receipt.payload;
}

describe('restricted assessment receipt MCP', () => {
  it.each(['stdio', 'memory'] as const)('N-01 %s real-store lifecycle verifies portable signed bytes without a legacy ledger', async (mode) => {
    const f = fixture(); const { client } = await connect(f, mode); const c = challenge();
    const s = await ready(client, c);
    const status = await json(client, 'assessment_status', { sessionId: s.id });
    expect(status).toEqual({ sessionId: s.id, revision: s.revision, currentPhase: 'complete' });
    const dossier = await json<any>(client, 'assessment_dossier_read', { sessionId: s.id });
    expect(dossier.entries[0]).toMatchObject({ kind: 'fact', origin: 'agent_asserted' });
    expect(dossier.claim.origin).toBe('agent_asserted');
    const wire = text(await call(client, 'assessment_export', exportArgs(s, c)));
    // The independent client possesses only its explicit public key and received bytes.
    writeFileSync(join(f.clientHome, 'receipt.json'), wire);
    const payload = verify(readFileSync(join(f.clientHome, 'receipt.json'), 'utf8'), f, c, s);
    expect(payload.assessment).toMatchObject({ outcome: 'pass', evidenceOrigin: 'agent_asserted', factCount: 1, claimAllowed: true, reasons: [] });
    expect(() => verifyReceipt(wire, generateKeyPairSync('ed25519').publicKey)).toThrow('signature did not verify');
    expect(readdirSync(f.clientHome).sort()).toEqual(['issuer.pub', 'receipt.json']);
    expect(readdirSync(f.producerHome).sort()).toEqual(['config.json', 'issuer.pem', 'state']);
  });

  it('N-10 exact retries survive restart; changed challenge, session, and revision conflict without replacing terminal bytes', async () => {
    const f = fixture(); let connection = await connect(f); const c = challenge();
    const s = await ready(connection.client, c); const args = exportArgs(s, c);
    const wire = text(await call(connection.client, 'assessment_export', args)); verify(wire, f, c, s);
    expect(text(await call(connection.client, 'assessment_export', args))).toBe(wire);
    const other = await start(connection.client, c);
    for (const changed of [ { ...args, expectedRevision: s.revision + 1 }, { ...args, sessionId: other.id },
      { ...args, challenge: { ...c, nonce: Buffer.alloc(32, 8).toString('base64url') } },
      { ...args, challenge: { ...c, contextRevision: 2 } },
      { ...args, challenge: { ...c, target: { ...c.target, action: 'different' } } } ]) {
      rejected(await call(connection.client, 'assessment_export', changed), wire);
      expect(text(await call(connection.client, 'assessment_export', args))).toBe(wire);
    }
    await claim(connection.client, s, 'updated documentary claim');
    await connection.close(); connection = await connect(f);
    expect(text(await call(connection.client, 'assessment_export', args))).toBe(wire);
    const stored = JSON.parse(readFileSync(f.stateFile, 'utf8'));
    expect(stored.terminals).toHaveLength(1); expect(stored.terminals[0].wire).toBe(wire);
  });

  it.each(['conflict', 'storage'] as const)('N-09 pass A followed by fresh-attempt %s failure B never returns A', async (fault) => {
    const f = fixture(); const { client } = await connect(f); const c = challenge(); const s = await ready(client, c);
    const first = text(await call(client, 'assessment_export', exportArgs(s, c)));
    expect(verify(first, f, c, s).assessment.outcome).toBe('pass');
    const fresh = { ...c, attemptId: randomUUID(), nonce: Buffer.alloc(32, 9).toString('base64url') };
    const stateBefore = readFileSync(f.stateFile);
    if (fault === 'storage') writeFileSync(f.stateFile, '{broken state');
    try {
      rejected(await call(client, 'assessment_export', { ...exportArgs(s, fresh), expectedRevision: s.revision + (fault === 'conflict' ? 1 : 0) }), first);
      expect(readFileSync(f.stateFile)).toEqual(fault === 'storage' ? Buffer.from('{broken state') : stateBefore);
    } finally { if (fault === 'storage') writeFileSync(f.stateFile, stateBefore); }
    expect(JSON.parse(readFileSync(f.stateFile, 'utf8')).terminals).toHaveLength(1);
  });

  it.each([
    { name: 'no fact', kind: null, steps: 6, claimText: 'plain observation', reasons: ['fact_missing', 'claim_prerequisites_missing'] },
    { name: 'only hypothesis', kind: 'hypothesis', steps: 6, claimText: 'plain observation', reasons: ['fact_missing', 'claim_prerequisites_missing'] },
    { name: 'incomplete phases', kind: 'fact', steps: 1, claimText: 'plain observation', reasons: ['mandatory_steps_incomplete'] },
    { name: 'empty claim', kind: 'fact', steps: 6, claimText: '   ', reasons: ['claim_missing'] },
    { name: 'missing claim', kind: 'fact', steps: 6, claimText: null, reasons: ['claim_missing'] },
    { name: 'root cause without alternatives', kind: 'fact', steps: 6, claimText: 'root cause is documented', reasons: ['claim_prerequisites_missing'] },
  ])('N-19 signed policy failure: $name', async ({ kind, steps, claimText, reasons }) => {
    const f = fixture(); const { client } = await connect(f, 'memory'); const c = challenge();
    let s = await advance(client, await start(client, c), steps);
    if (kind) s = await entry(client, s, kind);
    if (claimText !== null) s = await claim(client, s, claimText);
    const wire = text(await call(client, 'assessment_export', exportArgs(s, c)));
    expect(verify(wire, f, c, s).assessment).toMatchObject({ outcome: 'fail', reasons });
    if (claimText?.startsWith('root cause')) {
      const dossier = await json<any>(client, 'assessment_dossier_read', { sessionId: s.id });
      expect(dossier.claimEvaluation).toMatchObject({ type: 'root_cause', allowed: false, missing: ['alternatives_considered'] });
      s = await entry(client, s, 'rejected');
      const next = { ...c, attemptId: randomUUID() };
      expect(verify(text(await call(client, 'assessment_export', exportArgs(s, next))), f, next, s).assessment.outcome).toBe('pass');
    }
  });

  it('N-19 rejects authority overrides across mutating families and nested challenge boundaries before state changes', async () => {
    const f = fixture(); const { client } = await connect(f); const c = challenge(); const s = await start(client, c);
    const before = readFileSync(f.stateFile);
    const calls: [string, Record<string, unknown>][] = [
      ['assessment_start', { challenge: c, keyword: 'service', problem: 'outage' }],
      ['assessment_advance', { sessionId: s.id, expectedRevision: s.revision, expectedPhase: 'scope-resolution' }],
      ['assessment_dossier_add', { sessionId: s.id, expectedRevision: s.revision, kind: 'fact', content: 'assertion', source: 'text' }],
      ['assessment_claim_set', { sessionId: s.id, expectedRevision: s.revision, text: 'root cause' }],
      ['assessment_export', exportArgs(s, c)],
    ];
    const injections = { allowed: true, phase: 'complete', phases: ['complete'], events: [], snapshot: {}, origin: 'execution_verified', claimType: 'generic', type: 'generic', skip: true, issuer: 'attacker', privateKeyPath: '/tmp/key', stateDirectory: '/tmp/state' };
    for (const [name, args] of calls) for (const [field, value] of Object.entries(injections)) {
      rejected(await call(client, name, { ...args, [field]: value }));
      expect(readFileSync(f.stateFile), `${name}.${field} must not mutate state`).toEqual(before);
    }
    for (const name of ['assessment_start', 'assessment_export']) for (const boundary of ['challenge', 'target', 'subject', 'policy']) {
      for (const [field, value] of Object.entries(injections)) {
        const changed = structuredClone(c) as any;
        (boundary === 'challenge' ? changed : changed[boundary])[field] = value;
        const args = name === 'assessment_start' ? { challenge: changed, keyword: 'service', problem: 'outage' } : exportArgs(s, changed);
        rejected(await call(client, name, args)); expect(readFileSync(f.stateFile)).toEqual(before);
      }
    }
    for (const change of [ { policy: { ...c.policy, revision: 'wrong' } }, { policy: { ...c.policy, sha256: 'b'.repeat(64) } },
      { expiresAt: 0 }, { createdAt: c.expiresAt }, { nonce: '='.repeat(43) } ]) {
      rejected(await call(client, 'assessment_export', exportArgs(s, { ...c, ...change } as AssessmentChallenge)));
      expect(readFileSync(f.stateFile)).toEqual(before);
    }
    rejected(await call(client, 'assessment_advance', { sessionId: s.id, expectedRevision: s.revision, expectedPhase: 'claim-evaluation' }));
    expect(readFileSync(f.stateFile)).toEqual(before);
    expect(await json(client, 'assessment_status', { sessionId: s.id })).toEqual({ sessionId: s.id, revision: 1, currentPhase: 'scope-resolution' });
  });
});
