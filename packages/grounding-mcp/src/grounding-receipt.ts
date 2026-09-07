/**
 * Portable grounding-receipt/v1 codec.  This module is deliberately only a
 * byte-format and signature primitive: it neither loads keys nor decides
 * whether an issuer, task, session, or claim is authoritative.
 */
import * as crypto from 'node:crypto';

export const RECEIPT_FORMAT = 'grounding-receipt/v1';
export const RECEIPT_ALGORITHM = 'Ed25519';
export const POLICY_ID = 'debug-evidence-assessment/v1';
export const POLICY_REVISION = '1';
/** Frozen SHA-256 of the literal v1 policy.json bytes, including its final newline. */
export const POLICY_SHA256 = '50c68e4070b5c36c2bd166f61f83377df717253f30933fe05825386d605325a4';
export const MAX_WIRE_BYTES = 32_768;
export const MAX_PAYLOAD_BYTES = 16_384;

const token = /^[A-Za-z0-9._:-]{1,128}$/;
const sha256 = /^[0-9a-f]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const reasons = [
  'session_binding_invalid',
  'session_revision_invalid',
  'mandatory_steps_incomplete',
  'fact_missing',
  'claim_missing',
  'claim_prerequisites_missing',
] as const;
type Reason = (typeof reasons)[number];

export type ReceiptErrorCode = 'invalid' | 'unsupported' | 'untrusted';
export class GroundingReceiptError extends Error {
  constructor(readonly code: ReceiptErrorCode, message: string) {
    super(message);
    this.name = 'GroundingReceiptError';
  }
}

export interface GroundingReceiptPayload {
  schemaVersion: 1;
  receiptId: string;
  audience: string;
  projectId: string;
  taskId: string;
  attemptId: string;
  nonce: string;
  contextRevision: number;
  target: { workflowId: string | null; from: string; to: string; action: string };
  subject: { kind: 'task-context/v1'; digest: string };
  policy: { id: typeof POLICY_ID; revision: typeof POLICY_REVISION; sha256: typeof POLICY_SHA256 };
  session: { id: string; revision: number };
  assessment: {
    outcome: 'pass' | 'fail'; evidenceOrigin: 'agent_asserted'; factCount: number;
    claimAllowed: boolean; reasons: Reason[]; dossierSha256: string;
  };
  evaluatedAt: number;
  issuedAt: number;
  expiresAt: number;
  producer: { name: string; version: string; policyBuild: string };
}

export interface GroundingReceiptEnvelope {
  format: typeof RECEIPT_FORMAT;
  alg: typeof RECEIPT_ALGORITHM;
  issuer: string;
  kid: string;
  payload: string;
  signature: string;
}

export interface DecodedReceipt { envelope: GroundingReceiptEnvelope; payload: GroundingReceiptPayload; wire: Uint8Array; }

function fail(code: ReceiptErrorCode, message: string): never { throw new GroundingReceiptError(code, message); }
function exactObject(value: unknown, keys: readonly string[], label: string, ordered = true): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid', `${label} must be an object`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || (ordered ? keys.some((key, index) => actual[index] !== key) : keys.some((key) => !actual.includes(key)))) fail('invalid', `${label} has an invalid schema`);
  return value as Record<string, unknown>;
}
function asciiToken(value: unknown, label: string): string {
  if (typeof value !== 'string' || !token.test(value)) fail('invalid', `${label} must be an ASCII token`);
  return value;
}
function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) fail('invalid', `${label} must be a positive safe integer`);
  return value;
}
function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('invalid', `${label} must be a non-negative safe integer`);
  return value;
}
function lowercaseUuid(value: unknown, label: string, v4 = false): string {
  if (typeof value !== 'string' || !(v4 ? uuidV4 : uuid).test(value)) fail('invalid', `${label} must be a lowercase UUID`);
  return value;
}
function base64url(value: unknown, label: string, byteLength?: number): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value) || value.includes('=')) fail('invalid', `${label} must be unpadded base64url`);
  let decoded: Buffer;
  try { decoded = Buffer.from(value, 'base64url'); } catch { fail('invalid', `${label} is not base64url`); }
  if (decoded.toString('base64url') !== value || (byteLength !== undefined && decoded.length !== byteLength)) fail('invalid', `${label} is not canonical base64url`);
  return value;
}
function sha(value: unknown, label: string): string {
  if (typeof value !== 'string' || !sha256.test(value)) fail('invalid', `${label} must be lowercase SHA-256`);
  return value;
}

/** Stable, fixed-order UTF-8 JSON projection for payload signature bytes. */
export function canonicalizePayload(input: GroundingReceiptPayload): Uint8Array {
  const payload = validatePayload(input);
  return Buffer.from(JSON.stringify({
    schemaVersion: payload.schemaVersion, receiptId: payload.receiptId, audience: payload.audience,
    projectId: payload.projectId, taskId: payload.taskId, attemptId: payload.attemptId, nonce: payload.nonce,
    contextRevision: payload.contextRevision, target: { workflowId: payload.target.workflowId, from: payload.target.from, to: payload.target.to, action: payload.target.action },
    subject: { kind: payload.subject.kind, digest: payload.subject.digest },
    policy: { id: payload.policy.id, revision: payload.policy.revision, sha256: payload.policy.sha256 },
    session: { id: payload.session.id, revision: payload.session.revision },
    assessment: { outcome: payload.assessment.outcome, evidenceOrigin: payload.assessment.evidenceOrigin, factCount: payload.assessment.factCount, claimAllowed: payload.assessment.claimAllowed, reasons: payload.assessment.reasons, dossierSha256: payload.assessment.dossierSha256 },
    evaluatedAt: payload.evaluatedAt, issuedAt: payload.issuedAt, expiresAt: payload.expiresAt,
    producer: { name: payload.producer.name, version: payload.producer.version, policyBuild: payload.producer.policyBuild },
  }), 'utf8');
}

export function validatePayload(input: unknown): GroundingReceiptPayload {
  const p = exactObject(input, ['schemaVersion', 'receiptId', 'audience', 'projectId', 'taskId', 'attemptId', 'nonce', 'contextRevision', 'target', 'subject', 'policy', 'session', 'assessment', 'evaluatedAt', 'issuedAt', 'expiresAt', 'producer'], 'payload');
  if (typeof p.schemaVersion !== 'number' || !Number.isSafeInteger(p.schemaVersion)) fail('invalid', 'payload schema version must be an integer');
  if (p.schemaVersion !== 1) fail('unsupported', 'unsupported payload schema');
  const target = exactObject(p.target, ['workflowId', 'from', 'to', 'action'], 'target');
  if (target.workflowId !== null) lowercaseUuid(target.workflowId, 'target.workflowId');
  const subject = exactObject(p.subject, ['kind', 'digest'], 'subject');
  if (typeof subject.kind !== 'string') fail('invalid', 'subject kind must be a string');
  if (subject.kind !== 'task-context/v1') fail('unsupported', 'unsupported subject kind');
  const policy = exactObject(p.policy, ['id', 'revision', 'sha256'], 'policy');
  if (typeof policy.id !== 'string' || typeof policy.revision !== 'string' || typeof policy.sha256 !== 'string') fail('invalid', 'policy fields must be strings');
  if (policy.id !== POLICY_ID || policy.revision !== POLICY_REVISION || policy.sha256 !== POLICY_SHA256) fail('unsupported', 'unsupported policy profile');
  const session = exactObject(p.session, ['id', 'revision'], 'session');
  const assessment = exactObject(p.assessment, ['outcome', 'evidenceOrigin', 'factCount', 'claimAllowed', 'reasons', 'dossierSha256'], 'assessment');
  const producer = exactObject(p.producer, ['name', 'version', 'policyBuild'], 'producer');
  const outcome = assessment.outcome;
  if (outcome !== 'pass' && outcome !== 'fail') fail('invalid', 'invalid assessment outcome');
  if (assessment.evidenceOrigin !== 'agent_asserted') fail('invalid', 'assessment evidence origin must remain agent_asserted');
  const factCount = nonNegativeInteger(assessment.factCount, 'assessment.factCount');
  if (typeof assessment.claimAllowed !== 'boolean' || !Array.isArray(assessment.reasons) || assessment.reasons.length > reasons.length) fail('invalid', 'invalid assessment fields');
  const seen = new Set<string>();
  let previous = -1;
  for (const reason of assessment.reasons) {
    const index = reasons.indexOf(reason as Reason);
    if (index < 0 || seen.has(reason as string) || index <= previous) fail('invalid', 'assessment reasons must be unique policy-order codes');
    seen.add(reason as string); previous = index;
  }
  if ((outcome === 'pass' && (factCount < 1 || assessment.claimAllowed !== true || assessment.reasons.length !== 0)) || (outcome === 'fail' && assessment.reasons.length === 0)) fail('invalid', 'inconsistent assessment outcome');
  if ((factCount === 0 && !seen.has('fact_missing')) || (factCount > 0 && seen.has('fact_missing'))) fail('invalid', 'inconsistent fact assessment');
  if ((!assessment.claimAllowed && !seen.has('claim_missing') && !seen.has('claim_prerequisites_missing')) || (assessment.claimAllowed && (seen.has('claim_missing') || seen.has('claim_prerequisites_missing')))) fail('invalid', 'inconsistent claim assessment');
  const evaluatedAt = nonNegativeInteger(p.evaluatedAt, 'evaluatedAt');
  const issuedAt = nonNegativeInteger(p.issuedAt, 'issuedAt');
  const expiresAt = nonNegativeInteger(p.expiresAt, 'expiresAt');
  if (evaluatedAt > issuedAt || issuedAt >= expiresAt || expiresAt - evaluatedAt > 900) fail('invalid', 'invalid receipt lifetime');
  return {
    schemaVersion: 1, receiptId: lowercaseUuid(p.receiptId, 'receiptId', true), audience: asciiToken(p.audience, 'audience'),
    projectId: lowercaseUuid(p.projectId, 'projectId'), taskId: lowercaseUuid(p.taskId, 'taskId'), attemptId: lowercaseUuid(p.attemptId, 'attemptId'), nonce: base64url(p.nonce, 'nonce', 32), contextRevision: positiveInteger(p.contextRevision, 'contextRevision'),
    target: { workflowId: target.workflowId as string | null, from: asciiToken(target.from, 'target.from'), to: asciiToken(target.to, 'target.to'), action: asciiToken(target.action, 'target.action') },
    subject: { kind: 'task-context/v1', digest: sha(subject.digest, 'subject.digest') },
    policy: { id: POLICY_ID, revision: POLICY_REVISION, sha256: POLICY_SHA256 }, session: { id: asciiToken(session.id, 'session.id'), revision: positiveInteger(session.revision, 'session.revision') },
    assessment: { outcome, evidenceOrigin: assessment.evidenceOrigin as 'agent_asserted', factCount, claimAllowed: assessment.claimAllowed, reasons: assessment.reasons as Reason[], dossierSha256: sha(assessment.dossierSha256, 'assessment.dossierSha256') },
    evaluatedAt, issuedAt, expiresAt, producer: { name: asciiToken(producer.name, 'producer.name'), version: asciiToken(producer.version, 'producer.version'), policyBuild: asciiToken(producer.policyBuild, 'producer.policyBuild') },
  };
}

export function signatureInput(issuer: string, kid: string, payload: string): Uint8Array {
  asciiToken(issuer, 'issuer'); asciiToken(kid, 'kid'); base64url(payload, 'payload');
  return Buffer.from(`${RECEIPT_FORMAT}\n${RECEIPT_ALGORITHM}\n${issuer}\n${kid}\n${payload}`, 'utf8');
}
function ed25519Key(key: crypto.KeyObject, kind: 'private' | 'public'): crypto.KeyObject {
  if (!(key instanceof crypto.KeyObject) || key.type !== kind || key.asymmetricKeyType !== 'ed25519') fail('untrusted', `explicit ${kind} key must be Ed25519`);
  return key;
}

export function encodeReceipt(payload: GroundingReceiptPayload, issuer: string, kid: string, privateKey: crypto.KeyObject): Uint8Array {
  const bytes = canonicalizePayload(payload);
  if (bytes.length > MAX_PAYLOAD_BYTES) fail('invalid', 'payload exceeds byte limit');
  const body = Buffer.from(bytes).toString('base64url');
  const signature = crypto.sign(null, signatureInput(issuer, kid, body), ed25519Key(privateKey, 'private')).toString('base64url');
  const wire = Buffer.from(JSON.stringify({ format: RECEIPT_FORMAT, alg: RECEIPT_ALGORITHM, issuer, kid, payload: body, signature }), 'utf8');
  if (wire.length > MAX_WIRE_BYTES) fail('invalid', 'receipt exceeds wire byte limit');
  return wire;
}

/** Decode syntax and canonical schema only; this deliberately does not trust an issuer. */
export function decodeReceipt(input: Uint8Array | string): DecodedReceipt {
  const wire = strictWireBytes(input);
  const parsed = parseNoDuplicateJson(wire) as unknown;
  const raw = exactObject(parsed, ['format', 'alg', 'issuer', 'kid', 'payload', 'signature'], 'envelope', false);
  if (typeof raw.format !== 'string' || typeof raw.alg !== 'string') fail('invalid', 'format and algorithm must be strings');
  if (raw.format !== RECEIPT_FORMAT || raw.alg !== RECEIPT_ALGORITHM) fail('unsupported', 'unsupported receipt format or algorithm');
  const envelope: GroundingReceiptEnvelope = { format: RECEIPT_FORMAT, alg: RECEIPT_ALGORITHM, issuer: asciiToken(raw.issuer, 'issuer'), kid: asciiToken(raw.kid, 'kid'), payload: base64url(raw.payload, 'payload'), signature: base64url(raw.signature, 'signature', 64) };
  const payloadBytes = Buffer.from(envelope.payload, 'base64url');
  if (payloadBytes.length > MAX_PAYLOAD_BYTES) fail('invalid', 'payload exceeds byte limit');
  let payloadJson: unknown;
  try { payloadJson = parseNoDuplicateJson(payloadBytes); } catch (error) { if (error instanceof GroundingReceiptError) throw error; fail('invalid', 'payload is not valid UTF-8 JSON'); }
  const payload = validatePayload(payloadJson);
  if (!Buffer.from(canonicalizePayload(payload)).equals(payloadBytes)) fail('invalid', 'payload is not canonical');
  return { envelope, payload, wire };
}

/** Verify only schema plus a signature under the supplied public key. */
export function verifyReceipt(input: Uint8Array | string, publicKey: crypto.KeyObject): DecodedReceipt {
  const decoded = decodeReceipt(input);
  if (!crypto.verify(null, signatureInput(decoded.envelope.issuer, decoded.envelope.kid, decoded.envelope.payload), ed25519Key(publicKey, 'public'), Buffer.from(decoded.envelope.signature, 'base64url'))) fail('untrusted', 'receipt signature did not verify');
  return decoded;
}

/** Reject UTF-16 strings that would otherwise be silently replaced during encoding. */
function assertScalarString(text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0xd800 || code > 0xdfff) continue;
    const next = text.charCodeAt(i + 1);
    if (code > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff)) {
      fail('invalid', 'unpaired UTF-16 surrogate');
    }
    i += 1;
  }
}

function strictWireBytes(input: Uint8Array | string): Uint8Array {
  let bytes: Uint8Array;
  if (typeof input === 'string') {
    // Bound before scanning or allocating an encoded copy.
    if (Buffer.byteLength(input, 'utf8') > MAX_WIRE_BYTES) fail('invalid', 'receipt exceeds wire byte limit');
    assertScalarString(input);
    bytes = Buffer.from(input, 'utf8');
  } else if (input instanceof Uint8Array) bytes = input;
  else fail('invalid', 'wire input must be UTF-8 string or Uint8Array');
  if (bytes.length > MAX_WIRE_BYTES) fail('invalid', 'receipt exceeds wire byte limit');
  return bytes;
}

/**
 * Bounded JSON grammar walk: catch duplicate decoded keys before JSON.parse
 * erases them, and reject escaped lone surrogates as well as malformed UTF-8.
 * The v1 schema is shallow; the depth ceiling also bounds malformed inputs.
 * No values are assigned to user-controlled object keys by this walk.
 */
function parseNoDuplicateJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    // Preserve a BOM so the JSON grammar rejects it instead of silently stripping it.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail('invalid', 'invalid UTF-8 JSON');
  }
  let at = 0;
  const whitespace = (): void => {
    while (at < text.length && /[ \t\n\r]/.test(text[at])) at += 1;
  };
  const string = (): string => {
    const start = at;
    if (text[at++] !== '"') fail('invalid', 'invalid JSON string');
    while (at < text.length) {
      const char = text[at++];
      if (char === '"') {
        let decoded: string;
        try { decoded = JSON.parse(text.slice(start, at)) as string; }
        catch { fail('invalid', 'invalid JSON string'); }
        assertScalarString(decoded);
        return decoded;
      }
      if (char === '\\') {
        const escape = text[at++];
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(at, at + 4))) fail('invalid', 'invalid JSON escape');
          at += 4;
        } else if (!escape || !'"\\/bfnrt'.includes(escape)) {
          fail('invalid', 'invalid JSON escape');
        }
      } else if (char.charCodeAt(0) < 0x20) {
        fail('invalid', 'invalid JSON string');
      }
    }
    fail('invalid', 'unterminated JSON string');
  };
  const value = (depth = 0): void => {
    if (depth > 32) fail('invalid', 'JSON nesting exceeds limit');
    whitespace();
    const char = text[at];
    if (char === '{') {
      at += 1;
      whitespace();
      const seen = new Set<string>();
      if (text[at] === '}') { at += 1; return; }
      while (true) {
        whitespace();
        const key = string();
        if (seen.has(key)) fail('invalid', 'duplicate JSON key');
        seen.add(key);
        whitespace();
        if (text[at++] !== ':') fail('invalid', 'invalid JSON object');
        value(depth + 1);
        whitespace();
        if (text[at] === '}') { at += 1; return; }
        if (text[at++] !== ',') fail('invalid', 'invalid JSON object');
      }
    }
    if (char === '[') {
      at += 1;
      whitespace();
      if (text[at] === ']') { at += 1; return; }
      while (true) {
        value(depth + 1);
        whitespace();
        if (text[at] === ']') { at += 1; return; }
        if (text[at++] !== ',') fail('invalid', 'invalid JSON array');
      }
    }
    if (char === '"') { string(); return; }
    const primitive = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(at));
    if (!primitive) fail('invalid', 'invalid JSON value');
    at += primitive[0].length;
  };
  value();
  whitespace();
  if (at !== text.length) fail('invalid', 'trailing JSON data');
  try { return JSON.parse(text); }
  catch { fail('invalid', 'invalid JSON'); }
}
