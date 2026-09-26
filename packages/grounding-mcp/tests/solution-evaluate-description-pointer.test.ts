// Asserts the `solution_evaluate` tool description points agents at the doc
// that actually holds the progress-notification and timeout detail
// (docs/solution-acceptance-gate.md), not a "see README" pointer into a
// section that moved out of README.md. A mutant that reverts the pointer
// back to "see README" must fail this test.

import { describe, expect, it } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../src/server.js';

describe('solution_evaluate tool description pointer', () => {
  it('names docs/solution-acceptance-gate.md instead of README', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverTransport);

    const client = new Client({ name: 'description-pointer-test', version: '0.0.0' });
    await client.connect(clientTransport);

    try {
      const tools = (await client.listTools()).tools;
      const tool = tools.find((t) => t.name === 'solution_evaluate');
      expect(tool).toBeDefined();
      const description = tool?.description ?? '';
      expect(description).toContain('docs/solution-acceptance-gate.md');
      expect(description).not.toMatch(/see README\.?$/);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
