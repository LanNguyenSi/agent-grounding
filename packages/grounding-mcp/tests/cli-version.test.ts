// Smoke test for the `--version` CLI short-circuit added so tooling that
// probes installed MCP binaries (e.g. harness doctor's tools.mcp[]
// min_version check) does not hang waiting for the stdio transport to
// initialize.

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const SERVER_BIN = resolve(__dirname, '..', 'dist', 'server.js');
const PACKAGE_JSON = resolve(__dirname, '..', 'package.json');

function expectedVersion(): string {
  const raw = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { version: string };
  return raw.version;
}

describe('grounding-mcp CLI --version', () => {
  it('prints package.json#version and exits 0 within the doctor probe budget', () => {
    const result = spawnSync(process.execPath, [SERVER_BIN, '--version'], {
      encoding: 'utf8',
      timeout: 4_000,
    });
    expect(result.status).toBe(0);
    expect(result.error).toBeUndefined();
    expect(result.stdout.trim()).toBe(expectedVersion());
    // The short-circuit must keep the in-file constant in sync with
    // package.json. If this drifts, the registered MCP handshake reports
    // a different version than --version.
  });

  it('accepts the -v shorthand alias', () => {
    const result = spawnSync(process.execPath, [SERVER_BIN, '-v'], {
      encoding: 'utf8',
      timeout: 4_000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(expectedVersion());
  });
});
