// Interop suite: proves a marker THIS package's `writeVerdict`
// (src/solution-verdict.ts) actually produces is accepted by harness'
// real consumer-side verification logic, and that tampering / relabeling
// is rejected — with the same rejection reasons and `forged` classification
// harness itself would produce. The verifier under test here is
// `./harness-verifier.vendored.ts`, an independently-transcribed mirror of
// the harness CONSUMER (see that file's header for the exact source stamp);
// this suite deliberately does NOT reuse `../../src/verdict-signing.ts`'s
// verification logic (it has none — this package only ever signs, never
// verifies) so the proof is not circular.
//
// Isolation: same convention as verdict-signing.test.ts / solution-verdict.
// test.ts — HARNESS_HOME and SOLUTION_VERDICT_DIR are pinned to disposable
// tempdirs for every test, so nothing here ever touches the host's real
// ~/.harness (or ~/.claude fallback) or ~/.local/state/agent-grounding/.
//
// ── Regenerating a golden fixture for harness' side (documentation) ──
//
// harness pins producer/consumer field parity with its OWN golden fixtures
// (tests/fixtures/solution-acceptance/golden-verdict-<version>.json in the
// harness repo), captured from a REAL producer run rather than hand-written.
// harness' own doc comment (tests/policy-packs/solution-acceptance-runtime.
// test.ts, "golden fixture — drift guard against the real producer") already
// says how: run `solution_evaluate({ id })` against a real repo and copy the
// written marker. Concretely, against THIS producer:
//
//   1. Build this package: `npm run build` (packages/grounding-mcp).
//   2. Run it as the `grounding-mcp` MCP server in a real Claude Code /
//      harness session against a repo that has `@lannguyensi/agent-preflight`
//      installed and a committed `.preflight.json`, and call
//      `mcp__grounding-mcp__solution_evaluate({ id: "<fixture-id>" })`
//      (or invoke `evaluateSolution('<fixture-id>', repoPath)` from
//      `dist/solution-verdict.js` directly, for a script-only capture).
//   3. Copy the written marker from
//      `$SOLUTION_VERDICT_DIR/<fixture-id>.json` (default
//      `~/.local/state/agent-grounding/solution-verdicts/<fixture-id>.json`)
//      into `tests/fixtures/solution-acceptance/golden-verdict-<this
//      package's version>.json` in the harness repo (e.g.
//      `golden-verdict-0.8.0.json`).
//
//   Signature-portability note (why harness' existing golden fixtures carry
//   no `alg`/`signature` field, and the new one does not need to be captured
//   any differently): the HMAC signature is only valid against the SAME key
//   file it was computed with, which is machine/generatedDir-local — copying
//   raw signature bytes across a captured fixture is not portable. harness'
//   own tests already handle this correctly: they capture the RAW 7-key
//   content, assert it field-for-field matches the producer's `Verdict`
//   shape, and for a POSITIVE signature-acceptance test they locally
//   re-sign that captured content with harness' OWN test `signVerdict`
//   call against harness' OWN test `generatedDir` (see
//   "the consumer gates a SIGNED copy of the real marker's content
//   correctly" in solution-acceptance-runtime.test.ts) rather than trusting
//   a copied signature. The same pattern applies to any new
//   golden-verdict-0.8.0.json capture: only the 7-key shape needs pinning
//   there: this file (verdict-signing-interop.test.ts) is what proves the
//   SIGNATURE itself round-trips end to end, in THIS repo's CI, against a
//   real writeVerdict marker and a real shared key.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeVerdict, type Verdict as ProducerVerdict } from '../../src/solution-verdict.js';
import { resolveGeneratedDir } from '../../src/verdict-signing.js';
import {
  evaluateGate,
  verifyVerdictSignature,
  type Verdict as VendoredVerdict,
} from './harness-verifier.vendored.js';

const HEAD_A = 'a'.repeat(40);

function makeVerdict(over: Partial<ProducerVerdict> = {}): ProducerVerdict {
  return {
    id: 'task-1',
    head: HEAD_A,
    ready: true,
    confidence: 0.9,
    blockers: [],
    timestamp: '2026-05-30T00:00:00.000Z',
    source: 'preflight',
    ...over,
  };
}

let tmpHarnessHome: string;
let savedHarnessHome: string | undefined;
let tmpVerdictDir: string;
let savedVerdictDir: string | undefined;

beforeEach(() => {
  savedHarnessHome = process.env.HARNESS_HOME;
  tmpHarnessHome = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-interop-home-'));
  process.env.HARNESS_HOME = tmpHarnessHome;

  savedVerdictDir = process.env.SOLUTION_VERDICT_DIR;
  tmpVerdictDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-interop-verdicts-'));
  process.env.SOLUTION_VERDICT_DIR = tmpVerdictDir;
});

afterEach(() => {
  if (savedHarnessHome === undefined) delete process.env.HARNESS_HOME;
  else process.env.HARNESS_HOME = savedHarnessHome;
  fs.rmSync(tmpHarnessHome, { recursive: true, force: true });

  if (savedVerdictDir === undefined) delete process.env.SOLUTION_VERDICT_DIR;
  else process.env.SOLUTION_VERDICT_DIR = savedVerdictDir;
  fs.rmSync(tmpVerdictDir, { recursive: true, force: true });
});

/** The `generatedDir` BOTH the real producer signed into and the vendored verifier reads from, for the current test's isolated HARNESS_HOME. */
function gd(): string {
  return resolveGeneratedDir();
}

/** Runs the REAL producer (`writeVerdict`), then reads the on-disk marker back as raw JSON (the only way to see `alg`/`signature` — the producer's own `readVerdict` does not surface them, since the producer never verifies). */
function writeAndRead(verdict: ProducerVerdict): VendoredVerdict {
  const markerPath = writeVerdict(verdict);
  return JSON.parse(fs.readFileSync(markerPath, 'utf8')) as VendoredVerdict;
}

describe('interop: a real writeVerdict marker vs the vendored harness verifier', () => {
  it('positive: the vendored verifier accepts a real marker under the consumer\'s own lookup id', () => {
    const v = makeVerdict();
    const onDisk = writeAndRead(v);

    const sig = verifyVerdictSignature(gd(), v.id, onDisk);
    expect(sig.ok).toBe(true);

    const gate = evaluateGate(onDisk, v.head, v.id, gd());
    expect(gate.allowed).toBe(true);
    expect(gate.forged).toBe(false);
    expect(gate.reason).toContain('ready at HEAD');
  });

  describe('tamper negatives (content mutated after signing invalidates the signature)', () => {
    it('ready flipped', () => {
      const v = makeVerdict({ ready: true });
      const onDisk = writeAndRead(v);
      const tampered: VendoredVerdict = { ...onDisk, ready: false };
      const gate = evaluateGate(tampered, v.head, v.id, gd());
      expect(gate.allowed).toBe(false);
      expect(gate.forged).toBe(true);
      expect(gate.reason).toContain('signature verification failed (tampered or forged)');
    });

    it('head changed', () => {
      const v = makeVerdict({ head: HEAD_A });
      const onDisk = writeAndRead(v);
      const otherHead = 'b'.repeat(40);
      const tampered: VendoredVerdict = { ...onDisk, head: otherHead };
      const gate = evaluateGate(tampered, otherHead, v.id, gd());
      expect(gate.allowed).toBe(false);
      expect(gate.forged).toBe(true);
      expect(gate.reason).toContain('signature verification failed (tampered or forged)');
    });

    it('confidence changed', () => {
      const v = makeVerdict({ confidence: 0.9 });
      const onDisk = writeAndRead(v);
      const tampered: VendoredVerdict = { ...onDisk, confidence: 0.1 };
      const gate = evaluateGate(tampered, v.head, v.id, gd());
      expect(gate.allowed).toBe(false);
      expect(gate.forged).toBe(true);
      expect(gate.reason).toContain('signature verification failed (tampered or forged)');
    });

    it('blockers changed', () => {
      const v = makeVerdict({ blockers: [] });
      const onDisk = writeAndRead(v);
      const tampered: VendoredVerdict = { ...onDisk, blockers: ['smuggled: not actually there'] };
      const gate = evaluateGate(tampered, v.head, v.id, gd());
      expect(gate.allowed).toBe(false);
      expect(gate.forged).toBe(true);
      expect(gate.reason).toContain('signature verification failed (tampered or forged)');
    });

    it('1 signature byte changed', () => {
      const v = makeVerdict();
      const onDisk = writeAndRead(v);
      const sig = onDisk.signature as string;
      const flippedFirstChar = sig[0] === 'a' ? 'b' : 'a';
      const tampered: VendoredVerdict = { ...onDisk, signature: flippedFirstChar + sig.slice(1) };
      const gate = evaluateGate(tampered, v.head, v.id, gd());
      expect(gate.allowed).toBe(false);
      expect(gate.forged).toBe(true);
      expect(gate.reason).toContain('signature verification failed (tampered or forged)');
    });
  });

  describe('relabel / cross-id replay — both independent layers', () => {
    it('layer 1 (signature binding): the SAME marker bytes checked under a DIFFERENT id fail signature verification', () => {
      // Simulates copying the byte-identical marker file onto another id's
      // path (the marker's own `id` field, "task-1", is untouched) — the
      // signature was computed over markerId "solution-verdict-task-1"
      // (verdictMarkerId(verdict.id) at sign time), but the consumer always
      // recomputes using the CALLER's lookup id, so checking it as "task-2"
      // recomputes over a different markerId and the HMAC no longer matches.
      const v = makeVerdict({ id: 'task-1' });
      const onDisk = writeAndRead(v);

      const gate = evaluateGate(onDisk, v.head, 'task-2', gd());
      expect(gate.allowed).toBe(false);
      expect(gate.forged).toBe(true);
      expect(gate.reason).toContain('signature verification failed (tampered or forged)');
    });

    it('layer 2 (verdict.id !== id guard): fires even when the signature itself still verifies', () => {
      // `verdict.id` is NOT part of the signed payload (only markerId,
      // approvedAt, approvedBy, reportContentHash are) — so swapping ONLY
      // the body's `id` field, leaving everything else (including
      // `signature`) untouched, and checking it under the id it was
      // ACTUALLY signed for ("task-1") still passes signature verification.
      // The belt-and-braces `verdict.id !== id` check in evaluateGate is
      // what catches this.
      const v = makeVerdict({ id: 'task-1' });
      const onDisk = writeAndRead(v);
      const relabeled: VendoredVerdict = { ...onDisk, id: 'task-2' };

      const sig = verifyVerdictSignature(gd(), 'task-1', relabeled);
      expect(sig.ok).toBe(true);

      const gate = evaluateGate(relabeled, v.head, 'task-1', gd());
      expect(gate.allowed).toBe(false);
      expect(gate.forged).toBe(true);
      expect(gate.reason).toContain('cross-id replay');
    });
  });

  describe('alg / signature field negatives', () => {
    it('alg unknown (signature present) => rejected, forged', () => {
      const v = makeVerdict();
      const onDisk = writeAndRead(v);
      const tampered: VendoredVerdict = { ...onDisk, alg: 'hmac-sha1-v0' };
      const gate = evaluateGate(tampered, v.head, v.id, gd());
      expect(gate.allowed).toBe(false);
      expect(gate.forged).toBe(true);
      expect(gate.reason).toContain('unrecognized or missing alg');
    });

    it('alg removed, signature present => rejected, forged', () => {
      const v = makeVerdict();
      const onDisk = writeAndRead(v);
      const tampered: VendoredVerdict = { ...onDisk };
      delete tampered.alg;
      const gate = evaluateGate(tampered, v.head, v.id, gd());
      expect(gate.allowed).toBe(false);
      expect(gate.forged).toBe(true);
      expect(gate.reason).toContain('unrecognized or missing alg (got undefined)');
    });

    it('signature removed, alg present => rejected, forged (NOT the unsigned carve-out)', () => {
      const v = makeVerdict();
      const onDisk = writeAndRead(v);
      const tampered: VendoredVerdict = { ...onDisk };
      delete tampered.signature;
      const gate = evaluateGate(tampered, v.head, v.id, gd());
      expect(gate.allowed).toBe(false);
      expect(gate.forged).toBe(true);
      expect(gate.reason).toContain('missing signature (legacy pre-signing marker, or forged file)');
    });

    it('signature AND alg both removed, timestamp/source still valid => STILL forged:true, not the carve-out', () => {
      // This is the realistic shape a legacy (pre-signing) producer emits —
      // and it is deliberately NOT what the narrow "genuinely unsigned"
      // carve-out below catches; see that describe block, and
      // harness-verifier.vendored.ts's comment on
      // MISSING_APPROVED_AT_REASON / MISSING_APPROVED_BY_REASON, for why.
      // This matches harness' own golden-fixture assertion for the
      // pre-c7c3f606 0.3.2 / 0.5.0 markers ("the real UNSIGNED ... marker
      // is rejected as forged/unsigned, even at its own HEAD").
      const v = makeVerdict();
      const onDisk = writeAndRead(v);
      const tampered: VendoredVerdict = { ...onDisk };
      delete tampered.signature;
      delete tampered.alg;
      const gate = evaluateGate(tampered, v.head, v.id, gd());
      expect(gate.allowed).toBe(false);
      expect(gate.forged).toBe(true);
      expect(gate.reason).toContain('missing signature (legacy pre-signing marker, or forged file)');
    });
  });

  describe('the narrow "genuinely unsigned, not forged" carve-out (harness solution-acceptance-runtime.ts:528-547)', () => {
    it('a SIGNED marker with a blank required field is TAMPERING, not the carve-out', () => {
      // Proves the review-R2 scoping: the carve-out below only ever applies
      // when signature/alg are BOTH absent. A verdict that still carries
      // them but happens to hit the same "missing approvedAt" reason (here,
      // via a blanked timestamp) is a signed field reading blank — only
      // possible via post-signing tampering — and stays in the generic
      // forged:true bucket.
      const v = makeVerdict();
      const onDisk = writeAndRead(v);
      const tampered: VendoredVerdict = { ...onDisk, timestamp: '' };
      const gate = evaluateGate(tampered, v.head, v.id, gd());
      expect(gate.allowed).toBe(false);
      expect(gate.forged).toBe(true);
      expect(gate.reason).toContain('missing approvedAt');
      expect(gate.reason).not.toContain('treating as unsigned, not forged');
    });

    it('a blank required field WITH no alg/signature at all hits the carve-out: forged:false, "unsigned, not forged"', () => {
      const v = makeVerdict();
      const onDisk = writeAndRead(v);
      const tampered: VendoredVerdict = { ...onDisk, timestamp: '' };
      delete tampered.signature;
      delete tampered.alg;
      const gate = evaluateGate(tampered, v.head, v.id, gd());
      expect(gate.allowed).toBe(false);
      expect(gate.forged).toBe(false);
      expect(gate.reason).toContain('treating as unsigned, not forged');
    });
  });
});
