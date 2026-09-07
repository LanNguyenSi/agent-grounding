/** Trusted, explicit startup configuration for the restricted assessment producer. */
import { createPrivateKey, type KeyObject } from 'node:crypto';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ASSESSMENT_POLICY } from './grounding-assessment-policy.js';
import { GroundingAssessmentStore } from './grounding-assessment-store.js';

const MAX_CONFIG_BYTES = 64 * 1024;
export const ASSESSMENT_PACKAGE_VERSION: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const token = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]{1,128}$/);
const configSchema = z.object({
  issuer: token,
  kid: token,
  privateKeyPath: z.string().min(1),
  stateDirectory: z.string().min(1),
  policy: z.object({
    id: z.literal(ASSESSMENT_POLICY.id),
    revision: z.literal(ASSESSMENT_POLICY.revision),
    sha256: z.literal(ASSESSMENT_POLICY.sha256),
  }).strict(),
}).strict();

export class AssessmentIssuerError extends Error {
  constructor() { super('Assessment startup configuration rejected'); this.name = 'AssessmentIssuerError'; }
}

export interface AssessmentIssuerConfig extends z.infer<typeof configSchema> {}

async function boundedUtf8File(file: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new AssessmentIssuerError();
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes || length !== stat.size) throw new AssessmentIssuerError();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
  } finally { await handle.close(); }
}

/** Loads only an operator-selected absolute config file. No default state/key paths exist. */
export async function loadAssessmentIssuer(configPath = process.env.GROUNDING_ASSESSMENT_CONFIG): Promise<{
  config: AssessmentIssuerConfig; privateKey: KeyObject;
}> {
  try {
    if (typeof configPath !== 'string' || !path.isAbsolute(configPath)) throw new AssessmentIssuerError();
    const parsed: unknown = JSON.parse(await boundedUtf8File(configPath, MAX_CONFIG_BYTES));
    const config = configSchema.parse(parsed);
    if (!path.isAbsolute(config.privateKeyPath) || !path.isAbsolute(config.stateDirectory)) throw new AssessmentIssuerError();
    const key = createPrivateKey(await boundedUtf8File(config.privateKeyPath, MAX_CONFIG_BYTES));
    if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new AssessmentIssuerError();
    return { config: { ...config, privateKeyPath: path.resolve(config.privateKeyPath), stateDirectory: path.resolve(config.stateDirectory) }, privateKey: key };
  } catch {
    throw new AssessmentIssuerError();
  }
}

export async function createAssessmentStore(configPath?: string, producer = { name: 'grounding-assessment-mcp', version: ASSESSMENT_PACKAGE_VERSION, policyBuild: ASSESSMENT_POLICY.sha256 }): Promise<GroundingAssessmentStore> {
  const { config, privateKey } = await loadAssessmentIssuer(configPath);
  return new GroundingAssessmentStore({ directory: config.stateDirectory, issuer: config.issuer, kid: config.kid, privateKey, producer });
}
