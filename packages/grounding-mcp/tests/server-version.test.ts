// Asserts the MCP `name+version` handshake reports package.json's version,
// not a hand-maintained literal. A mutant that hardcodes a different string
// at the point server.ts resolves PACKAGE_VERSION must fail this test.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../src/server.js';

const PACKAGE_JSON = resolve(__dirname, '..', 'package.json');

function expectedVersion(): string {
  const raw = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { version: string };
  return raw.version;
}

describe('grounding-mcp MCP handshake version', () => {
  it('reports package.json#version in the server info handshake', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await server.connect(serverTransport);

    const client = new Client({ name: 'server-version-test', version: '0.0.0' });
    await client.connect(clientTransport);

    try {
      const serverVersion = client.getServerVersion();
      expect(serverVersion?.version).toBe(expectedVersion());
      // Independent of the exact comparison above: catches a bundled dist/
      // with no sibling package.json falling back to the hardcoded default,
      // even where this test's own package.json resolution path is absent.
      expect(serverVersion?.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(serverVersion?.version).not.toBe('0.0.0');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
