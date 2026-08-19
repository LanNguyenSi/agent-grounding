// Producer-side signing mirror of harness' HMAC marker signing
// (verdict-signing.ts). All tests isolate HARNESS_HOME to a tempdir so the
// signing-key resolution + getOrCreate never touches the host's real
// ~/.harness (or ~/.claude fallback) — see D-001/D-002,
// .ai/runs/2026-08-19-verdict-signing-producer/03-decisions.md.
//
// The `resolveHarnessHome` precedence tiers beyond the HARNESS_HOME env
// override (~/.harness-exists, ~/.claude-legacy, default-create) mirror
// harness `resolveHomeDir` and are deliberately NOT separately unit-tested
// here: they read `os.homedir()` directly (no test-injectable override, by
// design — grounding-mcp has no `--home` CLI flag to mirror), and a
// `vi.spyOn(os, 'homedir')` was tried and confirmed NOT to redirect the
// call inside verdict-signing.ts under this package's ESM/vitest setup (the
// resolved path came back as the REAL host home dir, which on this
// particular dev machine has a real ~/.harness — exactly the real-home
// touch this suite must not risk). The single HARNESS_HOME-env test below
// is what every other test in this file (and in solution-verdict.test.ts)
// actually relies on for isolation, so it is the one covered here.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  canonicalPayload,
  getOrCreateSigningKey,
  GENERATED_DIRNAME,
  resolveGeneratedDir,
  resolveHarnessHome,
  sha256Hex,
  signingKeyPathFor,
  signMarker,
  signVerdict,
  SIGNING_ALG,
  SIGNING_KEY_BASENAME,
  verdictMarkerId,
  VERDICT_MARKER_ID_PREFIX,
} from '../src/verdict-signing.js';
import { writeVerdict, type Verdict } from '../src/solution-verdict.js';

const HEAD_A = 'a'.repeat(40);

function makeVerdict(over: Partial<Verdict> = {}): Verdict {
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

/** Manually recompute the expected signature bytes, independent of the module under test. */
function expectedSignature(key: Buffer, payload: string): string {
  return crypto.createHmac('sha256', key).update(payload).digest('hex');
}

let tmpHome: string;
let savedHarnessHome: string | undefined;

beforeEach(() => {
  savedHarnessHome = process.env.HARNESS_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-signing-home-'));
  process.env.HARNESS_HOME = tmpHome;
});

afterEach(() => {
  if (savedHarnessHome === undefined) delete process.env.HARNESS_HOME;
  else process.env.HARNESS_HOME = savedHarnessHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('verdictMarkerId', () => {
  it('prefixes with the pinned VERDICT_MARKER_ID_PREFIX', () => {
    expect(VERDICT_MARKER_ID_PREFIX).toBe('solution-verdict-');
    expect(verdictMarkerId('task-1')).toBe('solution-verdict-task-1');
  });
});

describe('canonicalPayload', () => {
  it('matches the exact hard-coded byte order the harness consumer verifies against', () => {
    const payload = canonicalPayload(
      'solution-verdict-task-1',
      '2026-05-30T00:00:00.000Z',
      'preflight',
      'deadbeef',
    );
    expect(payload).toBe(
      '{"markerId":"solution-verdict-task-1","approvedAt":"2026-05-30T00:00:00.000Z","approvedBy":"preflight","reportContentHash":"deadbeef"}',
    );
  });

  it('encodes a null reportContentHash as JSON null (not omitted, not "null" string)', () => {
    const payload = canonicalPayload('m', 'a', 'b', null);
    expect(payload).toBe('{"markerId":"m","approvedAt":"a","approvedBy":"b","reportContentHash":null}');
  });
});

describe('resolveHarnessHome', () => {
  it('honors the HARNESS_HOME env override', () => {
    expect(resolveHarnessHome()).toBe(tmpHome);
  });
});

describe('resolveGeneratedDir', () => {
  it('is <home>/harness.generated', () => {
    expect(resolveGeneratedDir()).toBe(path.join(tmpHome, GENERATED_DIRNAME));
  });
});

describe('getOrCreateSigningKey', () => {
  it('creates a fresh 32-byte key with mode 0600 when none exists', () => {
    const generatedDir = path.join(tmpHome, GENERATED_DIRNAME);
    const handle = getOrCreateSigningKey(generatedDir);
    expect(handle.created).toBe(true);
    expect(handle.key.length).toBe(32);
    expect(handle.filePath).toBe(signingKeyPathFor(generatedDir));
    expect(handle.filePath).toBe(path.join(generatedDir, SIGNING_KEY_BASENAME));
    const stat = fs.statSync(handle.filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('reads an existing >=32-byte key unchanged (does not overwrite it)', () => {
    const generatedDir = path.join(tmpHome, GENERATED_DIRNAME);
    fs.mkdirSync(generatedDir, { recursive: true });
    const preexisting = crypto.randomBytes(32);
    fs.writeFileSync(signingKeyPathFor(generatedDir), preexisting, { mode: 0o600 });
    const handle = getOrCreateSigningKey(generatedDir);
    expect(handle.created).toBe(false);
    expect(handle.key.equals(preexisting)).toBe(true);
    // still on disk, byte-identical (not rewritten)
    expect(fs.readFileSync(signingKeyPathFor(generatedDir)).equals(preexisting)).toBe(true);
  });

  it('treats a key file shorter than 32 bytes as corrupt and regenerates it', () => {
    const generatedDir = path.join(tmpHome, GENERATED_DIRNAME);
    fs.mkdirSync(generatedDir, { recursive: true });
    const short = crypto.randomBytes(16);
    fs.writeFileSync(signingKeyPathFor(generatedDir), short, { mode: 0o600 });
    const handle = getOrCreateSigningKey(generatedDir);
    expect(handle.created).toBe(true);
    expect(handle.key.length).toBe(32);
    expect(handle.key.equals(short)).toBe(false);
    const stat = fs.statSync(handle.filePath);
    expect(stat.mode & 0o777).toBe(0o600);
    // repaired on disk too
    expect(fs.readFileSync(handle.filePath).length).toBe(32);
  });

  it('a second call after creation returns the SAME key (idempotent)', () => {
    const generatedDir = path.join(tmpHome, GENERATED_DIRNAME);
    const first = getOrCreateSigningKey(generatedDir);
    const second = getOrCreateSigningKey(generatedDir);
    expect(second.created).toBe(false);
    expect(second.key.equals(first.key)).toBe(true);
  });
});

describe('signMarker', () => {
  it('signs against a manually recomputed HMAC over the canonical payload', () => {
    const generatedDir = path.join(tmpHome, GENERATED_DIRNAME);
    const signed = signMarker(generatedDir, 'solution-verdict-task-1', {
      approvedAt: '2026-05-30T00:00:00.000Z',
      approvedBy: 'preflight',
      reportContentHash: 'deadbeef',
    });
    expect(signed.alg).toBe(SIGNING_ALG);
    expect(signed.alg).toBe('hmac-sha256-v1');
    expect(signed.reportContentHash).toBe('deadbeef');

    const { key } = getOrCreateSigningKey(generatedDir);
    const expected = expectedSignature(
      key,
      canonicalPayload('solution-verdict-task-1', '2026-05-30T00:00:00.000Z', 'preflight', 'deadbeef'),
    );
    expect(signed.signature).toBe(expected);
  });

  it('maps a missing reportContentHash to null (not omitted)', () => {
    const generatedDir = path.join(tmpHome, GENERATED_DIRNAME);
    const signed = signMarker(generatedDir, 'm', { approvedAt: 'a', approvedBy: 'b' });
    expect(signed.reportContentHash).toBeNull();
  });
});

describe('signVerdict', () => {
  it('signs a verdict with alg + a signature verifying against the locally recomputed contract HMAC', () => {
    const generatedDir = path.join(tmpHome, GENERATED_DIRNAME);
    const verdict = makeVerdict();
    const signed = signVerdict(generatedDir, verdict);

    expect(signed.alg).toBe('hmac-sha256-v1');
    expect(signed.signature).toMatch(/^[0-9a-f]{64}$/);
    // does not mutate the input
    expect((verdict as Verdict).alg).toBeUndefined();

    const { key } = getOrCreateSigningKey(generatedDir);
    const reportContentHash = sha256Hex(
      JSON.stringify({
        head: verdict.head,
        ready: verdict.ready,
        confidence: verdict.confidence,
        blockers: verdict.blockers,
      }),
    );
    const payload = canonicalPayload(
      verdictMarkerId(verdict.id),
      verdict.timestamp,
      verdict.source,
      reportContentHash,
    );
    expect(signed.signature).toBe(expectedSignature(key, payload));
  });

  it('a changed field (ready flipped) invalidates the previously computed signature', () => {
    const generatedDir = path.join(tmpHome, GENERATED_DIRNAME);
    const verdict = makeVerdict({ ready: true });
    const signed = signVerdict(generatedDir, verdict);
    const tampered = signVerdict(generatedDir, { ...verdict, ready: false });
    expect(tampered.signature).not.toBe(signed.signature);
  });
});

describe('writeVerdict (solution-verdict.ts wiring)', () => {
  it('always signs: the on-disk marker carries alg + signature verifying against the contract HMAC', () => {
    const verdictDirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-signing-verdictdir-'));
    const savedVerdictDir = process.env.SOLUTION_VERDICT_DIR;
    process.env.SOLUTION_VERDICT_DIR = verdictDirTmp;
    try {
      const verdict = makeVerdict();
      const markerPath = writeVerdict(verdict);
      const onDisk = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Verdict;

      expect(onDisk.alg).toBe('hmac-sha256-v1');
      expect(typeof onDisk.signature).toBe('string');
      expect(onDisk.signature).toMatch(/^[0-9a-f]{64}$/);

      const generatedDir = path.join(tmpHome, GENERATED_DIRNAME);
      const { key } = getOrCreateSigningKey(generatedDir);
      const reportContentHash = sha256Hex(
        JSON.stringify({
          head: onDisk.head,
          ready: onDisk.ready,
          confidence: onDisk.confidence,
          blockers: onDisk.blockers,
        }),
      );
      const payload = canonicalPayload(
        verdictMarkerId(onDisk.id),
        onDisk.timestamp,
        onDisk.source,
        reportContentHash,
      );
      expect(onDisk.signature).toBe(expectedSignature(key, payload));
    } finally {
      if (savedVerdictDir === undefined) delete process.env.SOLUTION_VERDICT_DIR;
      else process.env.SOLUTION_VERDICT_DIR = savedVerdictDir;
      fs.rmSync(verdictDirTmp, { recursive: true, force: true });
    }
  });
});
