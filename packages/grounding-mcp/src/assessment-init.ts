#!/usr/bin/env node
/** Separate operator entrypoint; never registered on the assessment transport. */
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { loadAssessmentIssuer } from './grounding-issuer.js';
import { initializeAssessmentState } from './grounding-assessment-store.js';

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error('Unexpected initialization arguments');
  const { config } = await loadAssessmentIssuer();
  await initializeAssessmentState(config.stateDirectory);
  process.stdout.write('Assessment state initialized\n');
}
function resolvedArgv1(): string | undefined { try { return process.argv[1] && realpathSync(process.argv[1]); } catch { return process.argv[1]; } }
if (resolvedArgv1() === fileURLToPath(import.meta.url)) {
  main().catch(() => { process.stderr.write('grounding-assessment initialization failed\n'); process.exitCode = 1; });
}
