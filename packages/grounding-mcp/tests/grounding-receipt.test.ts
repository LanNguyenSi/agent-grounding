import * as crypto from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canonicalizePayload, decodeReceipt, encodeReceipt, GroundingReceiptError,
  MAX_PAYLOAD_BYTES, MAX_WIRE_BYTES, POLICY_ID, POLICY_REVISION, POLICY_SHA256,
  signatureInput, validatePayload, verifyReceipt, type GroundingReceiptPayload,
} from '../src/grounding-receipt.js';

const corpus = path.resolve(import.meta.dirname, '../contracts/grounding-receipt-v1');
const file = (name: string): Buffer => readFileSync(path.join(corpus, name));
const json = (name: string) => JSON.parse(file(name).toString('utf8'));
const hash = (bytes: Uint8Array): string => crypto.createHash('sha256').update(bytes).digest('hex');
const keys = json('test-keys.json');
// TEST ONLY: DER is derived from the openly published 00..1f seed, never issuer keys.
const privateKey = crypto.createPrivateKey({ key: Buffer.from(keys.pkcs8DerPrefixHex + keys.seedHex, 'hex'), format: 'der', type: 'pkcs8' });
const publicKey = crypto.createPublicKey(keys.publicKeyPem);
const pass = json('golden-pass.payload.json') as GroundingReceiptPayload;
const policy = json('policy.json');
const schema = json('schema.json');
const negative = json('negative-vectors.json').cases as { id: string; group: string; expected: { code: GroundingReceiptError['code']; message?: string }; wireBase64: string }[];
const positive = json('positive-vectors.json').cases as { id: string; payload: GroundingReceiptPayload; wireBase64: string }[];
const contexts = json('context-vectors.json').cases as { id: string; mismatchedField: string; expectedContextValue: unknown; actualContextValue: unknown; wireBase64: string }[];
const dossierVectors = json('policy-vectors.json');

function expectCode(action: () => unknown, code: GroundingReceiptError['code'], message?: string): void {
  try { action(); }
  catch (error) {
    expect(error).toBeInstanceOf(GroundingReceiptError);
    expect((error as GroundingReceiptError).code).toBe(code);
    if (message) expect((error as Error).message).toBe(message);
    // Errors are bounded diagnostics, never a dump of signed input or key material.
    expect((error as Error).message).not.toContain(keys.seedHex);
    expect((error as Error).message).not.toContain(json('golden-pass.receipt').payload);
    return;
  }
  throw new Error(`expected ${code} rejection`);
}

function literalSignedPayload(text: string): string {
  const payload = Buffer.from(text).toString('base64url');
  const input = Buffer.from('grounding-receipt/v1\nEd25519\ntest.issuer\ntest-key\n' + payload);
  return JSON.stringify({ format: 'grounding-receipt/v1', alg: 'Ed25519', issuer: 'test.issuer', kid: 'test-key', payload, signature: crypto.sign(null, input, privateKey).toString('base64url') });
}

function field(object: unknown, locator: string): unknown {
  return locator.split('.').reduce((value, key) => (value as Record<string, unknown>)[key], object);
}

describe('grounding receipt v1 fixed conformance corpus', () => {
  it('N-02 pins exact policy bytes and the complete ordered corpus, without fixture regeneration', () => {
    // This is an explicit contract pin, independent of both the manifest and module.
    expect(POLICY_SHA256).toBe('50c68e4070b5c36c2bd166f61f83377df717253f30933fe05825386d605325a4');
    expect(hash(file('policy.json'))).toBe(POLICY_SHA256);
    const manifest = json('manifest.json');
    expect(manifest.format).toBe('grounding-receipt/v1');
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.policy).toEqual({ id: POLICY_ID, revision: POLICY_REVISION, sha256: POLICY_SHA256 });
    expect(manifest.files.map((entry: { path: string }) => entry.path)).toEqual(readdirSync(corpus).filter(name => name !== 'manifest.json').sort());
    for (const entry of manifest.files) {
      expect(file(entry.path).length, entry.path).toBe(entry.bytes);
      expect(hash(file(entry.path)), entry.path).toBe(entry.sha256);
    }
    expect(new Set(negative.map(v => v.id)).size).toBe(negative.length);
    expect([...new Set(negative.map(v => v.group))].sort()).toEqual(['N-02', 'N-03', 'N-04', 'N-18', 'N-19', 'N-20']);
  });

  it.each(['pass', 'fail'])('compares every %s payload field and every signature-input byte with fixed artifacts', outcome => {
    const wire = file(`golden-${outcome}.receipt`);
    const payloadBytes = file(`golden-${outcome}.payload.json`);
    const signatureBytes = Buffer.from(file(`golden-${outcome}.signature.hex`).toString().trim(), 'hex');
    const fixedInput = file(`golden-${outcome}.signature-input.bin`);
    const envelope = JSON.parse(wire.toString());
    const payload = JSON.parse(payloadBytes.toString()) as GroundingReceiptPayload;
    expect(Buffer.from(envelope.payload, 'base64url')).toEqual(payloadBytes);
    expect(Buffer.from(envelope.signature, 'base64url')).toEqual(signatureBytes);
    expect(Buffer.from(signatureInput(envelope.issuer, envelope.kid, envelope.payload))).toEqual(fixedInput);
    expect(fixedInput).toEqual(Buffer.from('grounding-receipt/v1\nEd25519\n' + envelope.issuer + '\n' + envelope.kid + '\n' + envelope.payload));
    expect(crypto.verify(null, fixedInput, publicKey, signatureBytes)).toBe(true);
    expect(crypto.sign(null, fixedInput, privateKey)).toEqual(signatureBytes);
    expect(Buffer.from(canonicalizePayload(payload))).toEqual(payloadBytes);
    expect(Buffer.from(encodeReceipt(payload, envelope.issuer, envelope.kid, privateKey))).toEqual(wire);
    expect(verifyReceipt(wire, publicKey).payload).toEqual(payload);
    expect(payload.assessment.outcome).toBe(outcome);
    expect(payload.assessment.evidenceOrigin).toBe('agent_asserted');
    expect(Object.keys(envelope)).toEqual(schema['x-wire'].envelopeOrder);
    expect(Object.keys(payload)).toEqual(schema.$defs.payload.required);
  });

  it('derives the public golden key from the public test seed', () => {
    expect(keys.seedHex).toBe(Array.from({ length: 32 }, (_, i) => i.toString(16).padStart(2, '0')).join(''));
    expect(keys.purpose).toContain('TEST ONLY');
    const derived = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
    expect(derived.toString('hex')).toBe(keys.publicKeySpkiDerHex);
    expect(publicKey.export({ format: 'der', type: 'spki' })).toEqual(derived);
  });

  it.each(negative)('$group rejects fixed wire $id', vector => {
    expectCode(() => verifyReceipt(Buffer.from(vector.wireBase64, 'base64'), publicKey), vector.expected.code, vector.expected.message);
  });

  it.each(positive)('accepts fixed boundary/reason case $id', vector => {
    expect(verifyReceipt(Buffer.from(vector.wireBase64, 'base64'), publicKey).payload).toEqual(vector.payload);
  });

  it.each(contexts)('keeps $id cryptographically valid; expected-context comparison belongs to the consumer', vector => {
    const decoded = verifyReceipt(Buffer.from(vector.wireBase64, 'base64'), publicKey);
    // Comparison demonstrates differing fixture values, not an implemented consumer gate.
    expect(field(pass, vector.mismatchedField)).toEqual(vector.expectedContextValue);
    expect(field(decoded.payload, vector.mismatchedField)).toEqual(vector.actualContextValue);
    expect(vector.actualContextValue).not.toEqual(vector.expectedContextValue);
  });

  it('covers every reason individually and together as signed fail with agent_asserted provenance', () => {
    expect(json('golden-fail.payload.json').assessment.reasons).toEqual(policy.reasonCodes);
    for (const reason of policy.reasonCodes) {
      const item = positive.find(v => v.id === 'fail-' + reason)!;
      expect(item.payload.assessment.reasons).toEqual([reason]);
      expect(item.payload.assessment.outcome).toBe('fail');
      expect(item.payload.assessment.evidenceOrigin).toBe('agent_asserted');
    }
  });

  it('N-03 uses inclusive byte ceilings for Uint8Array and strings, before JSON work', () => {
    const atLimit = Buffer.from(positive.find(v => v.id === 'wire-exactly-32768')!.wireBase64, 'base64');
    expect(atLimit.length).toBe(MAX_WIRE_BYTES);
    expect(verifyReceipt(atLimit.toString(), publicKey).payload).toEqual(pass);
    expectCode(() => decodeReceipt(atLimit.toString() + ' '), 'invalid', 'receipt exceeds wire byte limit');
    expectCode(() => decodeReceipt(atLimit.toString() + '\ud800'), 'invalid', 'receipt exceeds wire byte limit');
    for (const size of [MAX_PAYLOAD_BYTES, MAX_PAYLOAD_BYTES + 1]) {
      const item = negative.find(v => v.id === 'payload-byte-bound-' + size)!;
      expect(Buffer.from(JSON.parse(Buffer.from(item.wireBase64, 'base64').toString()).payload, 'base64url').length).toBe(size);
    }
  });

  it('rejects wrong transport types, raw surrogate strings, and normalizes malformed JSON errors', () => {
    for (const input of [null, undefined, {}, [], 4, new ArrayBuffer(2)]) expectCode(() => decodeReceipt(input as Uint8Array), 'invalid');
    for (const raw of ['\ud800', '\udfff', '\ud800x', '\ud800\ud800']) expectCode(() => decodeReceipt(raw), 'invalid', 'unpaired UTF-16 surrogate');
    // Valid Unicode pairs survive scalar decoding but are outside ASCII issuer tokens.
    const pair = file('golden-pass.receipt').toString().replace('test.issuer', '\ud83d\ude00');
    expectCode(() => decodeReceipt(pair), 'invalid', 'issuer must be an ASCII token');
    const escapedPair = file('golden-pass.receipt').toString().replace('test.issuer', '\\ud83d\\ude00');
    expectCode(() => decodeReceipt(escapedPair), 'invalid', 'issuer must be an ASCII token');
    expect((Object.prototype as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('rejects equivalent minus-zero and exponential timestamp bytes at the canonical boundary', () => {
    const payload = { ...pass, evaluatedAt: 0, issuedAt: 0, expiresAt: 1 };
    for (const lexical of ['-0', '0.0', '0e0']) {
      const raw = JSON.stringify(payload).replace('"evaluatedAt":0', '"evaluatedAt":' + lexical);
      expectCode(() => verifyReceipt(literalSignedPayload(raw), publicKey), 'invalid', 'payload is not canonical');
    }
  });

  it('N-02 requires explicit Ed25519 keys of the correct kind without selecting algorithms from input', () => {
    const wrongSeed = crypto.createPrivateKey({ key: Buffer.from(keys.pkcs8DerPrefixHex + '01'.repeat(32), 'hex'), type: 'pkcs8', format: 'der' });
    expectCode(() => verifyReceipt(file('golden-pass.receipt'), crypto.createPublicKey(wrongSeed)), 'untrusted');
    // Public P-256 generator point, deterministic and non-secret, used only for key-type rejection.
    const ecPublic = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: Buffer.from('6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296','hex').toString('base64url'), y: Buffer.from('4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5','hex').toString('base64url') } });
    for (const invalidKey of [privateKey, ecPublic, crypto.createSecretKey(Buffer.alloc(32)), null, {}, keys.publicKeyPem]) {
      expectCode(() => verifyReceipt(file('golden-pass.receipt'), invalidKey as crypto.KeyObject), 'untrusted');
    }
    for (const invalidKey of [publicKey, ecPublic, crypto.createSecretKey(Buffer.alloc(32)), null, {}]) {
      expectCode(() => encodeReceipt(pass, 'test.issuer', 'test-key', invalidKey as crypto.KeyObject), 'untrusted');
    }
  });

  it('schema describes all nested closed objects and inclusive numeric bounds', () => {
    const payloadSchema = schema.$defs.payload;
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['format', 'alg', 'issuer', 'kid', 'payload', 'signature']);
    expect(payloadSchema.additionalProperties).toBe(false);
    for (const object of ['target', 'subject', 'policy', 'session', 'assessment', 'producer']) {
      expect(payloadSchema.properties[object].additionalProperties).toBe(false);
      expect(payloadSchema.properties[object].required).toEqual(Object.keys(pass[object as keyof GroundingReceiptPayload] as object));
    }
    for (const locator of ['contextRevision', 'evaluatedAt', 'issuedAt', 'expiresAt']) expect(payloadSchema.properties[locator].maximum).toBe(Number.MAX_SAFE_INTEGER);
    expect(payloadSchema.properties.session.properties.revision.maximum).toBe(Number.MAX_SAFE_INTEGER);
    expect(payloadSchema.properties.assessment.properties.factCount.maximum).toBe(Number.MAX_SAFE_INTEGER);
    expect(payloadSchema.properties.assessment.properties.reasons.items.enum).toEqual(policy.reasonCodes);
    expect(payloadSchema.properties.policy.properties.sha256.const).toBe(POLICY_SHA256);
    expect(schema['x-wire'].maxBytes).toBe(MAX_WIRE_BYTES);
    expect(schema['x-invariants'].length).toBeGreaterThan(0);
    expect(validatePayload(pass)).toEqual(pass);
  });
});

describe('frozen declarative policy, not a P02 dossier evaluator', () => {
  it('N-19/N-20 supplies positive and negative dossiers for every minimum predicate', () => {
    expect(dossierVectors.scope).toContain('not dossier authority or policy evaluation');
    for (const predicate of policy.minimumPredicates) {
      const cases = dossierVectors.minimumPredicates.filter((v: { predicate: string }) => v.predicate === predicate.id);
      expect(cases.some((v: { expected: { decision: string } }) => v.expected.decision === 'pass'), predicate.id).toBe(true);
      expect(cases.some((v: { expected: { decision: string } }) => v.expected.decision === (predicate.onError ? 'issuer_error' : 'fail')), predicate.id).toBe(true);
    }
    const fabricated = dossierVectors.minimumPredicates.find((v: { id: string }) => v.id === 'fact-accepted');
    expect(fabricated.input.dossier.facts[0]).toEqual({ type: 'fact', content: 'I invented a successful process observation; no command was run.', origin: 'agent_asserted' });
    expect(fabricated.input.dossier.rejected[0].origin).toBe('agent_asserted');
    expect(fabricated.expected.decision).toBe('pass');
    expect(fabricated.note).toContain('not a P01 evaluation');
    // These assertions check the specification matrix, never run an assessment function.
    for (const [type, requires] of Object.entries(policy.claim.prerequisites) as [string, string[]][]) {
      const cases = dossierVectors.claimPrerequisites.filter((v: { type: string }) => v.type === type);
      expect(cases.some((v: { expectedClaimAllowed: boolean }) => v.expectedClaimAllowed)).toBe(true);
      for (const prerequisite of requires) {
        const rejection = cases.find((v: { focusPrerequisite: string }) => v.focusPrerequisite === prerequisite);
        expect(rejection.expectedClaimAllowed).toBe(false);
        expect(rejection.expectedMissing).toContain(prerequisite);
        expect(rejection.expectedDerivedContext[prerequisite]).toBe(false);
      }
    }
  });

  it.each(dossierVectors.claimDetection as { claim: string; expectedType: string }[])('frozen regex order classifies "$claim" as $expectedType', vector => {
    // This exercises only declarative text detection; no live claim-gate import or dossier evaluation.
    const matched = policy.claim.detectionPatterns.find((p: { pattern?: string; fallback?: boolean }) => p.fallback || new RegExp(p.pattern!).test(vector.claim.toLowerCase()));
    expect(matched.type).toBe(vector.expectedType);
  });

  it('N-04 pins sequence metadata, skip semantics, all prerequisites, and derivation without live imports', () => {
    expect(policy.phases.ordered).toEqual(['scope-resolution', 'doc-reading', 'playbook-loading', 'runtime-inspection', 'evidence-collection', 'claim-evaluation', 'complete']);
    expect(policy.phases.sequence).toEqual(['domain-router', 'readme-first-resolver', 'debug-playbook-engine', 'evidence-ledger', 'claim-gate', 'hypothesis-tracker']);
    expect(policy.phases.conditionalInsertion).toEqual({ tool: 'runtime-reality-checker', index: 3, keywordIncludesAny: ['monitor', 'agent', 'service', 'server', 'gateway'] });
    expect(policy.phases.steps.map((step: { mandatory: boolean }) => step.mandatory)).toEqual([true, true, true, true, true, true, false]);
    expect(policy.phases.skip.wrapper).toContain('no selected steps');
    expect(policy.claim.deriveContext).toMatchObject({ readme_read: 'phaseSatisfied(doc-reading)', process_checked: 'phaseSatisfied(runtime-inspection)', config_checked: 'phaseSatisfied(runtime-inspection)', health_checked: 'phaseSatisfied(runtime-inspection)', has_evidence: 'facts.length > 0', alternatives_considered: 'rejected.length > 0' });
    expect(policy.claim.prerequisites).toEqual({ architecture: ['readme_read','process_checked','config_checked','alternatives_considered'], root_cause: ['readme_read','process_checked','config_checked','has_evidence','alternatives_considered'], security: ['readme_read','config_checked','has_evidence'], network: ['health_checked','process_checked'], configuration: ['readme_read','config_checked'], process: ['process_checked'], availability: ['health_checked','process_checked'], token: ['config_checked','has_evidence'], generic: ['has_evidence'] });
    const source = readFileSync(path.resolve(import.meta.dirname, '../src/grounding-receipt.ts'), 'utf8');
    expect([...source.matchAll(/^import .* from '([^']+)';$/gm)].map(match => match[1])).toEqual(['node:crypto']);
  });
});
