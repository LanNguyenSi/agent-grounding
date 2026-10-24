// Pins the accept set of the assessment MCP challenge uuid fields across the
// zod 3 -> 4 migration (assessment-server.ts uses z.guid(), not z.uuid()).
//
// zod 3's z.string().uuid() accepted ANY 8-4-4-4-12 hex string
// (case-insensitive, no version/variant bits enforced). zod 4's z.uuid()
// enforces RFC 9562 version/variant bits and would newly reject the inputs
// below marked "discriminator". z.guid() keeps the zod 3 accept set.
//
// Each uuid is validated twice: first by the MCP tool schema (this file's
// subject; rejection surfaces as a JSON-RPC InvalidParams -32602 envelope),
// then again by the store's own stricter custom regex (lowercase only,
// version [1-8], variant [89ab]; rejection surfaces as an isError tool result
// "Invalid assessment input"). A schema-rejection test therefore asserts the
// PRESENCE of -32602; an accept-set test asserts its ABSENCE (the MCP schema
// let the value through and the store is the one rejecting it).
//
// The winning inputs for the guid-vs-uuid choice are the variant-c and
// version-9 forms: z.guid() passes them to the store, z.uuid() would reject
// them with -32602 at the MCP boundary. One input per test case.

import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ASSESSMENT_POLICY } from '../src/grounding-assessment-policy.js';
import { initializeAssessmentState, GroundingAssessmentStore } from '../src/grounding-assessment-store.js';
import { createAssessmentServer } from '../src/assessment-server.js';
import { expectValidationError } from './expect-validation-error.js';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) { try { await close(); } catch (error) { failures.push(error); } }
  expect(failures).toEqual([]);
});

async function connect() {
  const root = mkdtempSync(join(tmpdir(), 'assessment-uuid-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const stateDirectory = join(root, 'state');
  await initializeAssessmentState(stateDirectory);
  const store = new GroundingAssessmentStore({
    directory: stateDirectory, issuer: 'issuer.test', kid: 'key.test',
    privateKey: generateKeyPairSync('ed25519').privateKey,
    producer: { name: 'grounding-assessment-mcp', version: '0.0.0-test', policyBuild: ASSESSMENT_POLICY.sha256 },
  });
  const server = createAssessmentServer(store);
  const client = new Client({ name: 'uuid-acceptance-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  cleanup.push(() => client.close());
  cleanup.push(() => server.close());
  await server.connect(b);
  await client.connect(a);
  return client;
}

function challenge(projectId: string) {
  const now = Math.floor(Date.now() / 1000);
  return {
    audience: 'consumer.test', projectId, taskId: randomUUID(), attemptId: randomUUID(),
    nonce: Buffer.alloc(32, 3).toString('base64url'), contextRevision: 1,
    target: { workflowId: null, from: 'producer', to: 'consumer', action: 'assess' },
    subject: { kind: 'task-context/v1', digest: 'a'.repeat(64) }, policy: { ...ASSESSMENT_POLICY },
    createdAt: now - 1, expiresAt: now + 600,
  };
}

async function start(client: Client, projectId: string) {
  return client.callTool({ name: 'assessment_start', arguments: { challenge: challenge(projectId), keyword: 'service', problem: 'uuid accept set pin' } }, undefined, { timeout: 4000 });
}

function text(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0].text;
}

describe('assessment MCP challenge uuid accept set (zod 3 parity via z.guid)', () => {
  it('accepts a lowercase random v4 uuid end to end (control)', async () => {
    const client = await connect();
    const result = await start(client, randomUUID());
    expect((result as { isError?: boolean }).isError).not.toBe(true);
    expect(JSON.parse(text(result))).toMatchObject({ revision: 1 });
  });

  it('lets an uppercase uuid reach the store (v3 regex was case-insensitive); store rejects it without -32602', async () => {
    const client = await connect();
    const result = await start(client, '550E8400-E29B-41D4-A716-446655440000');
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text(result)).not.toContain('-32602');
    expect(text(result)).toContain('Invalid assessment input');
  });

  it('lets the nil uuid reach the store (zod 3 accepted all-zero); store rejects it without -32602', async () => {
    const client = await connect();
    const result = await start(client, '00000000-0000-0000-0000-000000000000');
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text(result)).not.toContain('-32602');
    expect(text(result)).toContain('Invalid assessment input');
  });

  it('DISCRIMINATOR: lets a variant-c uuid reach the store (zod 4 z.uuid() would reject it with -32602)', async () => {
    const client = await connect();
    const result = await start(client, '550e8400-e29b-41d4-c716-446655440000');
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text(result)).not.toContain('-32602');
    expect(text(result)).toContain('Invalid assessment input');
  });

  it('DISCRIMINATOR: lets a version-9 uuid reach the store (zod 4 z.uuid() would reject it with -32602)', async () => {
    const client = await connect();
    const result = await start(client, '00000000-0000-9000-8000-000000000000');
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text(result)).not.toContain('-32602');
    expect(text(result)).toContain('Invalid assessment input');
  });

  it('DISCRIMINATOR: lets a hex-version-A uuid reach the store (zod 4 z.uuid() would reject it with -32602)', async () => {
    const client = await connect();
    const result = await start(client, '00000000-0000-A000-8000-000000000000');
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text(result)).not.toContain('-32602');
    expect(text(result)).toContain('Invalid assessment input');
  });

  it('rejects a 35-character uuid at the MCP schema boundary with -32602', async () => {
    const client = await connect();
    const result = await start(client, '550e8400-e29b-41d4-a716-44665544000');
    expectValidationError(result, 'assessment_start', 'challenge.projectId');
  });

  it('rejects a brace-wrapped uuid at the MCP schema boundary with -32602', async () => {
    const client = await connect();
    const result = await start(client, '{550e8400-e29b-41d4-a716-446655440000}');
    expectValidationError(result, 'assessment_start', 'challenge.projectId');
  });
});
