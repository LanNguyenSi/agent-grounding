#!/usr/bin/env node
/** Dedicated stdio entrypoint for the restricted assessment producer. */
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAssessmentServer } from './assessment-server.js';
import { ASSESSMENT_PACKAGE_VERSION, createAssessmentStore } from './grounding-issuer.js';

async function main(): Promise<void> {
  if (process.argv.length === 3 && ['--version', '-v'].includes(process.argv[2])) { process.stdout.write(`${ASSESSMENT_PACKAGE_VERSION}\n`); return; }
  if (process.argv.length !== 2) throw new Error('Unexpected assessment arguments');
  const store = await createAssessmentStore();
  const server = createAssessmentServer(store);
  await server.connect(new StdioServerTransport());
}
function resolvedArgv1(): string | undefined { try { return process.argv[1] && realpathSync(process.argv[1]); } catch { return process.argv[1]; } }
if (resolvedArgv1() === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write('grounding-assessment-mcp failed to start\n'); process.exitCode = 1; });
}
