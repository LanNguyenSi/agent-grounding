// Asserts the `solution_evaluate` tool description points agents at the doc
// that actually holds the progress-notification and timeout detail
// (docs/solution-acceptance-gate.md), not a "see README" pointer into a
// section that moved out of README.md. A mutant that reverts the pointer
// back to "see README" must fail this test.
//
// The description also names an absolute GitHub URL for that doc, since
// the npm package does not ship `docs/`: a plain-text MCP tool description
// has no base to resolve a relative path against, so an npm-only consumer
// (no repo checkout) can only reach the doc through a fully qualified URL.
// A mutant that drops the URL and leaves only the bare relative path must
// fail this test too.

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
      expect(description).toContain(
        'https://github.com/LanNguyenSi/agent-grounding/blob/master/packages/grounding-mcp/docs/solution-acceptance-gate.md',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
});
