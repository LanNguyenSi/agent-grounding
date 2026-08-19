// Producer-side signing mirror of harness' HMAC marker signing
// (verdict-signing.ts). All tests isolate HARNESS_HOME to a tempdir so the
// signing-key resolution + getOrCreate never touches the host's real
// ~/.harness (or ~/.claude fallback) — see D-001 (independent mirror, no
// package dependency) / D-002 (unconditional signing, no unsigned
// fallback), task 9b6c4beb / grounding-mcp CHANGELOG 0.8.0.
//
// The `resolveHarnessHome` precedence tiers beyond the HARNESS_HOME env
// override (~/.harness-exists, ~/.claude-legacy, default-create) mirror
// harness `resolveHomeDir` and are exercised below via `resolveHarnessHome`'s
// injectable `userHome` parameter (D-005, same task/CHANGELOG anchor: review
// found the deeper tiers only transitively tested). A
// `vi.spyOn(os, 'homedir')` was tried FIRST and confirmed NOT to redirect
// the call inside verdict-signing.ts under this package's ESM/vitest setup
// (the resolved path came back as the REAL host home dir, which on this
// particular dev machine has a real ~/.harness — exactly the real-home
// touch this suite must not risk); `userHome` is the explicit test-injection
// seam that replaces that broken approach, mirroring harness'
// `resolveHomeDir(opts)`'s own `opts.userHome`. The HARNESS_HOME-env test
// below is still what every OTHER test in this file (and in
// solution-verdict.test.ts) relies on for isolation — the `userHome` tier
// tests are additive, not a replacement for that.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// F4b (review round 1): hoisted, test-armed mocks of `node:fs.readFileSync`
// / `node:fs.writeFileSync` used ONLY by the two "wx-write catch block"
// tests below, to exercise BOTH branches of `getOrCreateSigningKey`'s
// exclusive-create failure handling (verdict-signing.ts's wx-write catch
// block, otherwise uncovered): the lost-the-race EEXIST readback, and its
// non-EEXIST rethrow. `vi.spyOn(fs, 'readFileSync')` does NOT work for
// this: same class of failure as the `vi.spyOn(os, 'homedir')` finding
// above — confirmed by hand (a throwaway spy-based version of this test
// never observed the spy invoked from inside verdict-signing.ts). Module
// mocking via `vi.mock('node:fs', ...)` DOES intercept calls made through
// verdict-signing.ts's `import * as fs from 'node:fs'`, confirmed the same
// way. Guarded by the two `armedPath` flags below: every other test in this
// file (both stay null) gets the real, unmodified `node:fs` behavior.
const fsReadRace = vi.hoisted(() => ({
  armedPath: null as string | null,
  armedPayload: null as Buffer | null,
}));
const fsWriteFail = vi.hoisted(() => ({ armedPath: null as string | null }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((...args: unknown[]) => {
    const target = args[0];
    if (fsReadRace.armedPath !== null && target === fsReadRace.armedPath) {
      const payload = fsReadRace.armedPayload as Buffer;
      fsReadRace.armedPath = null;
      fsReadRace.armedPayload = null;
      // The "concurrent creator": really write the winning key to disk,
      // in the exact window between the miss-read we are about to report
      // and getOrCreateSigningKey's own `wx` write, using the SAME
      // exclusive-create flag a genuine concurrent process would use.
      actual.writeFileSync(target as string, payload, { mode: 0o600, flag: 'wx' });
      const err = new Error('ENOENT (simulated concurrent-create race)') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
  }) as typeof actual.readFileSync;
  const writeFileSync = ((...args: unknown[]) => {
    const target = args[0];
    const opts = args[2] as { flag?: string } | undefined;
    if (fsWriteFail.armedPath !== null && target === fsWriteFail.armedPath && opts?.flag === 'wx') {
      fsWriteFail.armedPath = null;
      // A non-EEXIST failure of the exclusive-create write (e.g. a real
      // EACCES from a read-only generatedDir) — must propagate, NOT be
      // swallowed as a lost create race.
      const err = new Error('EACCES (simulated non-EEXIST wx-write failure)') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    }
    return (actual.writeFileSync as (...a: unknown[]) => unknown)(...args);
  }) as typeof actual.writeFileSync;
  return {
    ...actual,
    default: { ...actual.default, readFileSync, writeFileSync },
    readFileSync,
    writeFileSync,
  };
});

import {
  canonicalPayload,
  getOrCreateSigningKey,
  GENERATED_DIRNAME,
  HARNESS_HOME_DIRNAME,
  LEGACY_HARNESS_HOME_DIRNAME,
  resolveGeneratedDir,
  resolveHarnessHome,
  resolveSigningKeyPath,
  sha256Hex,
  signingKeyPathFor,
  signMarker,
  signVerdict,
  SIGNING_ALG,
  SIGNING_KEY_BASENAME,
  SIGNING_KEY_ENV,
  verdictMarkerId,
  VERDICT_MARKER_ID_PREFIX,
} from '../src/verdict-signing.js';
import { verdictPath, writeVerdict, type Verdict } from '../src/solution-verdict.js';

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
let savedSigningKeyEnv: string | undefined;

beforeEach(() => {
  savedHarnessHome = process.env.HARNESS_HOME;
  savedSigningKeyEnv = process.env[SIGNING_KEY_ENV];
  // Start every test with the env projection ABSENT: the mirrored home
  // resolution is the baseline under test; env-primary tests set it
  // explicitly themselves.
  delete process.env[SIGNING_KEY_ENV];
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-signing-home-'));
  process.env.HARNESS_HOME = tmpHome;
});

afterEach(() => {
  if (savedHarnessHome === undefined) delete process.env.HARNESS_HOME;
  else process.env.HARNESS_HOME = savedHarnessHome;
  if (savedSigningKeyEnv === undefined) delete process.env[SIGNING_KEY_ENV];
  else process.env[SIGNING_KEY_ENV] = savedSigningKeyEnv;
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

  it('the HARNESS_HOME env override wins even when a userHome override is also passed', () => {
    // Precedence: env beats userHome unconditionally — userHome only
    // matters for the tiers BELOW the env check.
    const otherUserHome = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-signing-otheruser-'));
    try {
      expect(resolveHarnessHome(otherUserHome)).toBe(tmpHome);
    } finally {
      fs.rmSync(otherUserHome, { recursive: true, force: true });
    }
  });

  describe('userHome tiers (D-005: HARNESS_HOME env unset, isolated via the injectable userHome override)', () => {
    let userHome: string;

    beforeEach(() => {
      delete process.env.HARNESS_HOME;
      userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-signing-userhome-'));
    });

    afterEach(() => {
      fs.rmSync(userHome, { recursive: true, force: true });
      // outer beforeEach/afterEach restore HARNESS_HOME from savedHarnessHome
    });

    it('<userHome>/.harness exists on disk -> used', () => {
      const newHarnessDir = path.join(userHome, HARNESS_HOME_DIRNAME);
      fs.mkdirSync(newHarnessDir, { recursive: true });
      expect(resolveHarnessHome(userHome)).toBe(newHarnessDir);
    });

    it('no .harness, <userHome>/.claude carries harness.generated/ -> legacy fallback', () => {
      const legacyDir = path.join(userHome, LEGACY_HARNESS_HOME_DIRNAME);
      fs.mkdirSync(path.join(legacyDir, 'harness.generated'), { recursive: true });
      expect(resolveHarnessHome(userHome)).toBe(legacyDir);
    });

    it('no .harness, <userHome>/.claude carries harness.yaml -> legacy fallback', () => {
      const legacyDir = path.join(userHome, LEGACY_HARNESS_HOME_DIRNAME);
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, 'harness.yaml'), 'policy_packs: []\n', 'utf8');
      expect(resolveHarnessHome(userHome)).toBe(legacyDir);
    });

    it('neither tier present -> defaults to <userHome>/.harness (create-on-first-use)', () => {
      const newHarnessDir = path.join(userHome, HARNESS_HOME_DIRNAME);
      expect(fs.existsSync(newHarnessDir)).toBe(false);
      expect(resolveHarnessHome(userHome)).toBe(newHarnessDir);
    });

    it('a bare <userHome>/.claude WITHOUT harness state is NOT claimed (not somebody else\'s dir)', () => {
      const legacyDir = path.join(userHome, LEGACY_HARNESS_HOME_DIRNAME);
      // e.g. Claude Code's own settings.json living there, no harness.yaml
      // and no harness.generated/.
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, 'settings.json'), '{}\n', 'utf8');
      const newHarnessDir = path.join(userHome, HARNESS_HOME_DIRNAME);
      expect(resolveHarnessHome(userHome)).toBe(newHarnessDir);
    });

    it('.harness (new) is preferred over a ALSO-present legacy .claude with harness state', () => {
      const newHarnessDir = path.join(userHome, HARNESS_HOME_DIRNAME);
      fs.mkdirSync(newHarnessDir, { recursive: true });
      const legacyDir = path.join(userHome, LEGACY_HARNESS_HOME_DIRNAME);
      fs.mkdirSync(path.join(legacyDir, 'harness.generated'), { recursive: true });
      expect(resolveHarnessHome(userHome)).toBe(newHarnessDir);
    });
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

describe('writeVerdict fail-closed on a signing failure (F4a, D-002 pinned directly)', () => {
  it('a directory sitting at the key file path makes writeVerdict throw and writes NO marker file', () => {
    const verdictDirTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'verdict-signing-failclosed-'));
    const savedVerdictDir = process.env.SOLUTION_VERDICT_DIR;
    process.env.SOLUTION_VERDICT_DIR = verdictDirTmp;
    try {
      const generatedDir = resolveGeneratedDir();
      // A directory (not a file) at the key path: getOrCreateSigningKey's
      // `fs.readFileSync(filePath)` throws EISDIR, which is NOT 'ENOENT',
      // so it rethrows immediately instead of falling through to
      // "generate a fresh key" — signVerdict, and therefore writeVerdict,
      // never reaches its write.
      fs.mkdirSync(signingKeyPathFor(generatedDir), { recursive: true });

      const verdict = makeVerdict({ id: 'fail-closed-task' });
      expect(() => writeVerdict(verdict)).toThrow();
      // D-002 fail-closed, pinned directly: no marker file at all — not a
      // partially-written or unsigned one.
      expect(fs.existsSync(verdictPath(verdict.id))).toBe(false);
    } finally {
      if (savedVerdictDir === undefined) delete process.env.SOLUTION_VERDICT_DIR;
      else process.env.SOLUTION_VERDICT_DIR = savedVerdictDir;
      fs.rmSync(verdictDirTmp, { recursive: true, force: true });
    }
  });
});

describe('getOrCreateSigningKey exclusive-create (wx) failure handling (F4b)', () => {
  it('EEXIST create-race: a key concurrently created between the miss-read and the wx-write is read back, not clobbered — both converge on the SAME key', () => {
    const generatedDir = path.join(tmpHome, GENERATED_DIRNAME);
    const filePath = signingKeyPathFor(generatedDir);
    const concurrentWinner = crypto.randomBytes(32);

    fsReadRace.armedPath = filePath;
    fsReadRace.armedPayload = concurrentWinner;

    const handle = getOrCreateSigningKey(generatedDir);

    // The race was consumed (armed exactly once) — confirms this test
    // actually exercised the injected race rather than silently no-op'ing.
    expect(fsReadRace.armedPath).toBeNull();
    // Lost the `wx` race: `created` is false, the returned key is the
    // concurrent creator's key, read back rather than overwritten.
    expect(handle.created).toBe(false);
    expect(handle.key.equals(concurrentWinner)).toBe(true);
    // Both "callers" converge on the identical on-disk key: our call's
    // result AND a fresh, unmocked re-read of the file.
    expect(fs.readFileSync(filePath).equals(concurrentWinner)).toBe(true);

    // A second, wholly normal call (no race) also converges on the exact
    // same key — the shared-key contract getOrCreateSigningKey exists for.
    const second = getOrCreateSigningKey(generatedDir);
    expect(second.created).toBe(false);
    expect(second.key.equals(concurrentWinner)).toBe(true);
  });

  it('a non-EEXIST wx-write failure propagates (rethrown, not swallowed as a lost race)', () => {
    const generatedDir = path.join(tmpHome, GENERATED_DIRNAME);
    const filePath = signingKeyPathFor(generatedDir);

    fsWriteFail.armedPath = filePath;

    expect(() => getOrCreateSigningKey(generatedDir)).toThrow(/EACCES/);
    // The armed failure was consumed exactly once — confirms this test
    // actually reached the wx-write, not some earlier branch.
    expect(fsWriteFail.armedPath).toBeNull();
    // The failed exclusive-create wrote nothing: no key file left behind.
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

describe('resolveSigningKeyPath / SOLUTION_VERDICT_SIGNING_KEY (env primary, task d0daa18a)', () => {
  it('falls back to the mirrored generatedDir path when the env projection is absent', () => {
    expect(resolveSigningKeyPath()).toBe(signingKeyPathFor(resolveGeneratedDir()));
  });

  it('returns the env-projected key file path verbatim when set', () => {
    const projected = path.join(tmpHome, 'projected', 'the-key');
    process.env[SIGNING_KEY_ENV] = projected;
    expect(resolveSigningKeyPath()).toBe(projected);
    expect(resolveSigningKeyPath(path.join(tmpHome, 'other-generated'))).toBe(projected);
  });

  it('getOrCreateSigningKey creates the key AT the projected path and never consults the mirrored dir', () => {
    const projected = path.join(tmpHome, 'projected-dir', 'signing.key');
    process.env[SIGNING_KEY_ENV] = projected;
    const handle = getOrCreateSigningKey(resolveGeneratedDir());
    expect(handle.filePath).toBe(projected);
    expect(handle.created).toBe(true);
    expect(fs.readFileSync(projected).length).toBe(32);
    expect(fs.statSync(projected).mode & 0o777).toBe(0o600);
    // The mirrored location must stay untouched (env is authoritative).
    expect(fs.existsSync(signingKeyPathFor(resolveGeneratedDir()))).toBe(false);
  });

  it('uses a pre-existing key at the projected path (H1 model: harness projected its own key file)', () => {
    const consumerGenerated = path.join(tmpHome, 'consumer', GENERATED_DIRNAME);
    const consumerKeyPath = signingKeyPathFor(consumerGenerated);
    fs.mkdirSync(consumerGenerated, { recursive: true });
    const consumerKey = crypto.randomBytes(32);
    fs.writeFileSync(consumerKeyPath, consumerKey, { mode: 0o600 });
    process.env[SIGNING_KEY_ENV] = consumerKeyPath;

    const markerId = verdictMarkerId('task-env');
    const fields = signMarker(resolveGeneratedDir(), markerId, {
      approvedAt: '2026-05-30T00:00:00.000Z',
      approvedBy: 'preflight',
      reportContentHash: sha256Hex('x'),
    });
    expect(fields.signature).toBe(
      expectedSignature(
        consumerKey,
        canonicalPayload(markerId, '2026-05-30T00:00:00.000Z', 'preflight', sha256Hex('x')),
      ),
    );
  });

  it('writeVerdict signs with the env-projected key end to end', () => {
    const projected = path.join(tmpHome, 'consumer-side', GENERATED_DIRNAME, SIGNING_KEY_BASENAME);
    process.env[SIGNING_KEY_ENV] = projected;
    const verdictDir = path.join(tmpHome, 'verdicts');
    process.env.SOLUTION_VERDICT_DIR = verdictDir;
    try {
      const verdict = makeVerdict({ id: 'task-env-e2e' });
      writeVerdict(verdict);
      const raw = JSON.parse(
        fs.readFileSync(verdictPath('task-env-e2e'), 'utf8'),
      ) as Verdict & { alg: string; signature: string };
      const key = fs.readFileSync(projected);
      const markerId = verdictMarkerId('task-env-e2e');
      const contentHash = sha256Hex(
        JSON.stringify({
          head: verdict.head,
          ready: verdict.ready,
          confidence: verdict.confidence,
          blockers: verdict.blockers,
        }),
      );
      expect(raw.alg).toBe(SIGNING_ALG);
      expect(raw.signature).toBe(
        expectedSignature(
          key,
          canonicalPayload(markerId, verdict.timestamp, verdict.source, contentHash),
        ),
      );
    } finally {
      delete process.env.SOLUTION_VERDICT_DIR;
    }
  });
});

describe('resolveSigningKeyPath hardening (review round 1 of task d0daa18a)', () => {
  it('an empty-string env value falls back to the mirrored resolution', () => {
    process.env[SIGNING_KEY_ENV] = '';
    expect(resolveSigningKeyPath()).toBe(signingKeyPathFor(resolveGeneratedDir()));
  });

  it('a relative env value throws loudly instead of creating a key under cwd', () => {
    process.env[SIGNING_KEY_ENV] = 'relative/key';
    expect(() => resolveSigningKeyPath()).toThrow(/must be an absolute path/);
  });

  it('an unexpanded tilde env value throws loudly (projection-side tilde gotcha)', () => {
    process.env[SIGNING_KEY_ENV] = '~/.harness/harness.generated/.approval-signing.key';
    expect(() => resolveSigningKeyPath()).toThrow(/must be an absolute path/);
  });
});
